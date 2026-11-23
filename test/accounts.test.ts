// Accounts (RLM-414): WorkOS access tokens verified against the JWKS, the CLI's bearer access
// token, the end of anonymous owners (RLM-434), per-page grants, the browser session cookie and its
// refresh rotation, /auth/* and the dashboard. WorkOS is the stub in test/workos.ts.
import { env } from "cloudflare:workers";
import type { NoteRow, ReceivedFrame } from "austere-axi/sync";
import { describe, expect, it } from "vitest";
import { verifyAccessToken } from "../src/jwt";
import { SESSION_COOKIE, STATE_COOKIE, unseal, type SessionData } from "../src/session";
import { ORIGIN, assetToken, call, createPage, newOwner, open, ownerSocket, publish, reviewerSocket, sha256Hex } from "./helpers";
import { API, accessToken, addUser, keys, sessionCookie, stub } from "./workos";

const note = (text: string) => ({ items: [{ kind: "message" as const, text }] });
type Answer = { token: string; name: string | null; owner: boolean };

/** An account (in the WorkOS stub) and an access token for it. */
async function account(id: string, email: string, first: string | null = null, last: string | null = null) {
  addUser(id, email, first, last);
  return { id, email, at: await accessToken(id) };
}

/** A page published by the account `at`, with the full CLI flow over its access token. */
async function accountPage(at: string) {
  const { id, ack } = await publish(at);
  expect(ack.error).toBeUndefined();
  return id;
}

function grantTo(at: string, id: string, email: string): Promise<Response> {
  return call(`/api/pages/${id}/grants`, { method: "POST", token: at, json: { email } });
}

describe("JWT verify", () => {
  it("accepts a token signed by the JWKS key, for this client and issuer", async () => {
    const v = await verifyAccessToken(env, await accessToken("user_a"));
    expect(v).toEqual({ ok: true, claims: { sub: "user_a", sid: "session_user_a", exp: expect.any(Number) } });
  });

  it("the issuer may also be the client's user_management issuer", async () => {
    const v = await verifyAccessToken(env, await accessToken("user_a", { iss: `${API}/user_management/client_test` }));
    expect(v.ok).toBe(true);
  });

  it("refuses an expired token as expired (past the 30 s skew), and a token not yet valid", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyAccessToken(env, await accessToken("user_a", { exp: now - 31 }))).toEqual({ ok: false, reason: "expired" });
    expect((await verifyAccessToken(env, await accessToken("user_a", { exp: now - 5 }))).ok).toBe(true);
    expect(await verifyAccessToken(env, await accessToken("user_a", { nbf: now + 600 }))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a wrong issuer", async () => {
    expect(await verifyAccessToken(env, await accessToken("user_a", { iss: "https://evil.test" }))).toEqual({ ok: false, reason: "issuer" });
  });

  it("refuses a wrong audience; `aud` naming the client is accepted in place of client_id", async () => {
    expect(await verifyAccessToken(env, await accessToken("user_a", { client_id: "client_other" }))).toEqual({ ok: false, reason: "audience" });
    expect(await verifyAccessToken(env, await accessToken("user_a", { client_id: undefined }))).toEqual({ ok: false, reason: "audience" });
    expect(await verifyAccessToken(env, await accessToken("user_a", { client_id: undefined, aud: ["x", "client_test"] }))).toMatchObject({ ok: true });
  });

  it("refuses a forged signature, an unknown kid, a non-RS256 alg and garbage", async () => {
    expect(await verifyAccessToken(env, await accessToken("user_a", {}, { key: keys.other.privateKey }))).toEqual({ ok: false, reason: "signature" });
    expect(await verifyAccessToken(env, await accessToken("user_a", {}, { kid: "nope" }))).toEqual({ ok: false, reason: "signature" });
    expect(await verifyAccessToken(env, await accessToken("user_a", {}, { alg: "HS256" }))).toEqual({ ok: false, reason: "malformed" });
    const [h, p] = (await accessToken("user_a")).split(".");
    expect(await verifyAccessToken(env, `${h}.${p}.`)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAccessToken(env, "not.a.jwt")).toEqual({ ok: false, reason: "malformed" });
    // A tampered payload under a real signature.
    const [, , s] = (await accessToken("user_a")).split(".");
    const forged = btoa(JSON.stringify({ iss: API, sub: "user_b", client_id: "client_test", exp: 9e9 })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(await verifyAccessToken(env, `${h}.${forged}.${s}`)).toEqual({ ok: false, reason: "signature" });
  });

  it("caches the JWKS: many verifies, one fetch; an unknown kid does not refetch within 5 minutes", async () => {
    for (let i = 0; i < 3; i++) expect((await verifyAccessToken(env, await accessToken(`user_${i}`))).ok).toBe(true);
    await verifyAccessToken(env, await accessToken("user_a", {}, { kid: "rotated" }));
    expect(stub.calls.filter((c) => c.includes("/sso/jwks/")).length).toBe(1);
  });
});

describe("the CLI's access token on /api and the owner socket", () => {
  it("/api/me names the account; the user is looked up at WorkOS once", async () => {
    const a = await account("user_a", "Ana@Example.com", "Ana", "Lima");
    for (let i = 0; i < 2; i++) {
      const res = await call("/api/me", { token: a.at });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user: { id: "user_a", email: "ana@example.com", name: "Ana Lima" }, pages: 0 });
    }
    expect(stub.calls.filter((c) => c === "GET /user_management/users/user_a").length).toBe(1);
  });

  it("an expired, forged or wrong-audience token is 401 on /api and 403 on the owner socket", async () => {
    const a = await account("user_a", "ana@example.com");
    const id = await accountPage(a.at);
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [
      await accessToken("user_a", { exp: now - 600 }),
      await accessToken("user_a", {}, { key: keys.other.privateKey }),
      await accessToken("user_a", { client_id: "client_other" }),
    ]) {
      expect((await call("/api/pages", { token: bad })).status).toBe(401);
      const res = await open(`/api/pages/${id}/sync?cli=${env.MIN_CLI_VERSION}`, { protocols: ["austere-sync.1"], bearer: bad });
      expect(res instanceof Response && res.status).toBe(403);
    }
  });

  it("an account publishes over its access token and lists its pages", async () => {
    const a = await account("user_a", "ana@example.com");
    const id = await accountPage(a.at);
    const list = (await (await call("/api/pages", { token: a.at })).json()) as { pages: { id: string }[] };
    expect(list.pages.map((p) => p.id)).toEqual([id]);
    const html = await call(`/api/pages/${id}/html`, { token: a.at });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("<title>Plan</title>");
  });

  it("the same account is the owner on every one of its pages, from any of its tokens", async () => {
    const a = await account("user_a", "ana@example.com");
    const one = await accountPage(a.at);
    const two = await accountPage(await accessToken("user_a"));
    const sock = await ownerSocket(await accessToken("user_a"), one);
    sock.close();
    expect((await call(`/api/pages/${two}/html`, { token: await accessToken("user_a") })).status).toBe(200);
    // Another account gets 404, as for a missing page.
    const b = await account("user_b", "ben@example.com");
    expect((await call(`/api/pages/${one}/html`, { token: b.at })).status).toBe(404);
    const refused = await open(`/api/pages/${one}/sync?cli=${env.MIN_CLI_VERSION}`, { protocols: ["austere-sync.1"], bearer: b.at });
    expect(refused instanceof Response && refused.status).toBe(404);
  });
});

describe("migration 0003: no anonymous owners (RLM-434)", () => {
  it("revokes every owner token, claimed ones too, and takes down the pages no account holds", async () => {
    const a = await account("user_a", "ana@example.com");
    const kept = await accountPage(a.at);
    const orphan = await accountPage(a.at);
    // As before 0003: an unclaimed anonymous owner holds `orphan`, and the account claimed another token.
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO owners (id, token_hash, created_at) VALUES ('anon', ?, ?)").bind(await sha256Hex("t".repeat(43)), now),
      env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, user_id) VALUES ('claimed', ?, ?, 'user_a')").bind(await sha256Hex("c".repeat(43)), now),
      env.DB.prepare("UPDATE pages SET owner_id = 'anon' WHERE id = ?").bind(orphan),
      env.DB.prepare("INSERT INTO grants (page_id, email, role, created_at) VALUES (?, 'ben@example.com', 'collaborator', ?)").bind(orphan, now),
    ]);
    const hashes = async () => (await env.DB.prepare("SELECT token_hash FROM owners").all<{ token_hash: string }>()).results.map((r) => r.token_hash);
    const before = await hashes();

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0003"))!;
    for (const q of migration.queries) await env.DB.prepare(q).run();

    const after = await hashes();
    expect(after).toHaveLength(before.length);
    for (const h of after) expect(before).not.toContain(h);
    expect(new Set(after).size).toBe(after.length);
    expect((await call(`/p/${orphan}`)).status).toBe(410);
    expect((await call(`/p/${kept}`)).status).toBe(200);
    const list = (await (await call("/api/pages", { token: a.at })).json()) as { pages: { id: string }[] };
    expect(list.pages.map((p) => p.id)).toEqual([kept]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE page_id = ?").bind(orphan).first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT blocked FROM owners WHERE id = 'anon'").first("blocked")).toBe(1);
    expect(await env.DB.prepare("SELECT blocked FROM owners WHERE id = 'claimed'").first("blocked")).toBe(0);
  });
});

describe("grants", () => {
  it("the owner grants a page by email; only that account gets in, under its account name", async () => {
    const owner = await account("user_o", "olga@example.com", "Olga");
    const id = await accountPage(owner.at);
    expect((await grantTo(owner.at, id, " Ana@Example.com ")).status).toBe(201);
    expect((await grantTo(owner.at, id, "ana@example.com")).status).toBe(200);
    const list = (await (await call(`/api/pages/${id}/grants`, { token: owner.at })).json()) as { grants: { email: string; role: string }[] };
    expect(list.grants).toMatchObject([{ email: "ana@example.com", role: "collaborator" }]);

    addUser("user_a", "ana@example.com", "Ana", "Lima");
    addUser("user_b", "ben@example.com", "Ben");
    const ana = (await sessionCookie("user_a")).cookie;
    const ben = (await sessionCookie("user_b")).cookie;

    const res = await assetToken(id, undefined, { cookie: ana });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as Answer;
    expect(answer).toMatchObject({ name: "Ana Lima", owner: false });
    expect((await call(`/p/${id}/a/${answer.token}/`)).status).toBe(200);

    // No grant: 403 on the asset token and the socket, as without an account.
    expect((await assetToken(id, undefined, { cookie: ben })).status).toBe(403);
    const refused = await open(`/p/${id}/sync`, { protocols: ["austere-sync.1"], cookie: ben });
    expect(refused instanceof Response && refused.status).toBe(403);

    // Notes carry the account's name, whatever the client declares.
    const sock = await reviewerSocket(id, { cookie: ana });
    await sock.pull(0);
    expect((await sock.mutate("addNote", { ...note("hi"), name: "Owner" })).error).toBeUndefined();
    const o = await ownerSocket(owner.at, id);
    const [changes] = await o.pull(0);
    expect((changes.rows.find((r) => r.type === "note") as NoteRow).author).toBe("Ana Lima");
    o.close();
  });

  it("the owner's own account in the browser is the owner on the page, without `publish login`", async () => {
    const owner = await account("user_o", "olga@example.com", "Olga");
    const one = await accountPage(owner.at);
    const two = await accountPage(owner.at);
    const { cookie } = await sessionCookie("user_o");
    for (const id of [one, two]) {
      const answer = (await (await assetToken(id, undefined, { cookie })).json()) as Answer;
      expect(answer).toMatchObject({ name: "Owner", owner: true });
    }
  });

  it("removing a grant refuses the account at once: asset token, artifact, and its open socket", async () => {
    const owner = await account("user_o", "olga@example.com");
    const id = await accountPage(owner.at);
    await grantTo(owner.at, id, "ana@example.com");
    addUser("user_a", "ana@example.com", "Ana");
    const { cookie } = await sessionCookie("user_a");
    const { token } = (await (await assetToken(id, undefined, { cookie })).json()) as Answer;
    const sock = await reviewerSocket(id, { cookie });
    await sock.pull(0);

    const del = await call(`/api/pages/${id}/grants/${encodeURIComponent("ana@example.com")}`, { method: "DELETE", token: owner.at });
    expect(del.status).toBe(204);
    await sock.take((f: ReceivedFrame) => f.t === "error" && f.code === "forbidden");
    expect((await sock.closedWith()).code).toBe(1008);
    expect((await call(`/p/${id}/a/${token}/`)).status).toBe(403);
    expect((await assetToken(id, undefined, { cookie })).status).toBe(403);
    expect((await call(`/api/pages/${id}/grants/ana%40example.com`, { method: "DELETE", token: owner.at })).status).toBe(404);
  });

  it("only the owner manages grants; a bad email is 400", async () => {
    const owner = await account("user_o", "olga@example.com");
    const id = await accountPage(owner.at);
    const other = await account("user_b", "ben@example.com");
    expect((await grantTo(other.at, id, "x@example.com")).status).toBe(404);
    expect((await grantTo(owner.at, id, "not an email")).status).toBe(400);
    expect((await call(`/api/pages/${id}/grants`, { token: await newOwner() })).status).toBe(404);
  });

  it("an account named like a reserved name is shown by its email; the open link cannot declare `Owner`", async () => {
    const owner = await account("user_o", "olga@example.com");
    const id = await accountPage(owner.at);
    await grantTo(owner.at, id, "mallory@example.com");
    addUser("user_m", "mallory@example.com", "Owner");
    const answer = (await (await assetToken(id, undefined, { cookie: (await sessionCookie("user_m")).cookie })).json()) as Answer;
    expect(answer).toMatchObject({ name: "mallory@example.com", owner: false });

    const token = await newOwner();
    const open = await publish(token, { args: { unlisted: true } });
    const r = await reviewerSocket(open.id);
    await r.pull(0);
    await r.mutate("addNote", { ...note("hi"), name: " owner " });
    const o = await ownerSocket(token, open.id);
    const [changes] = await o.pull(0);
    expect((changes.rows.find((x) => x.type === "note") as NoteRow).author).toBe("Reviewer");
    o.close();
  });
});

describe("the browser session", () => {
  it("an expired access token is refreshed once; the new cookie holds the rotated refresh token", async () => {
    const owner = await account("user_o", "olga@example.com");
    const id = await accountPage(owner.at);
    const expired = await accessToken("user_o", { exp: Math.floor(Date.now() / 1000) - 120 });
    const { cookie, rt } = await sessionCookie("user_o", { at: expired });

    const res = await assetToken(id, undefined, { cookie });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Answer).owner).toBe(true);
    expect(stub.calls.filter((c) => c.endsWith("refresh_token")).length).toBe(1);
    const set = /^austere_session=([A-Za-z0-9_-]+);/.exec(res.headers.get("set-cookie") ?? "");
    expect(set).not.toBeNull();
    expect(res.headers.get("set-cookie")).toMatch(/Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
    const next = (await unseal<SessionData>(env, SESSION_COOKIE, set![1]))!;
    expect(next.rt).not.toBe(rt);
    expect(stub.refresh.has(rt)).toBe(false);
    expect(stub.refresh.has(next.rt)).toBe(true);
    expect((await verifyAccessToken(env, next.at)).ok).toBe(true);

    // The new cookie works without another refresh.
    expect((await assetToken(id, undefined, { cookie: `austere_session=${set![1]}` })).status).toBe(200);
    expect(stub.calls.filter((c) => c.endsWith("refresh_token")).length).toBe(1);

    // The old cookie's refresh token was used: WorkOS refuses it, the session ends and the cookie is cleared.
    const stale = await assetToken(id, undefined, { cookie });
    expect(stale.status).toBe(403);
    expect(stale.headers.get("set-cookie")).toMatch(/^austere_session=; Path=\/; .*Max-Age=0/);
  });

  it("WorkOS down during a refresh: signed out for this request, the cookie is kept", async () => {
    const owner = await account("user_o", "olga@example.com");
    const id = await accountPage(owner.at);
    const { cookie } = await sessionCookie("user_o", { at: await accessToken("user_o", { exp: Math.floor(Date.now() / 1000) - 120 }) });
    stub.down = true;
    const res = await assetToken(id, undefined, { cookie });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await assetToken(id, undefined, { cookie })).status).toBe(200);
  });

  it("a tampered cookie is cleared", async () => {
    const owner = await account("user_o", "olga@example.com");
    const id = await accountPage(owner.at);
    const res = await assetToken(id, undefined, { cookie: `austere_session=${"A".repeat(200)}` });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toMatch(/^austere_session=; /);
  });
});

describe("/auth/*", () => {
  it("login redirects to AuthKit with a state the callback checks, then lands back with the session", async () => {
    addUser("user_a", "ana@example.com", "Ana");
    const res = await call("/auth/login?return_to=/p/abc");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(`${API}/user_management/authorize`);
    expect(to.searchParams.get("client_id")).toBe("client_test");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(to.searchParams.get("provider")).toBe("authkit");
    const state = to.searchParams.get("state")!;
    const stateCookie = /^(austere_auth=[^;]+);/.exec(res.headers.get("set-cookie")!)![1];
    expect(res.headers.get("set-cookie")).toContain("Path=/auth; HttpOnly");

    stub.codes.set("code_1", "user_a");
    const wrong = await call(`/auth/callback?code=code_1&state=other`, { headers: { cookie: stateCookie } });
    expect(wrong.status).toBe(400);
    stub.codes.set("code_1", "user_a");
    const back = await call(`/auth/callback?code=code_1&state=${state}`, { headers: { cookie: stateCookie } });
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/p/abc");
    const cookies = back.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(session).toMatch(/; Path=\/; HttpOnly; SameSite=Lax; /);
    expect(cookies.some((c) => c.startsWith(`${STATE_COOKIE}=;`))).toBe(true);
    const row = await env.DB.prepare("SELECT email, name FROM users WHERE id = 'user_a'").first();
    expect(row).toEqual({ email: "ana@example.com", name: "Ana" });
  });

  it("return_to only goes to a same-origin path", async () => {
    for (const bad of ["https://evil.test/", "//evil.test/", "/\\evil.test"]) {
      const res = await call(`/auth/login?return_to=${encodeURIComponent(bad)}`);
      const state = new URL(res.headers.get("location")!).searchParams.get("state");
      const sealed = /^austere_auth=([^;]+);/.exec(res.headers.get("set-cookie")!)![1];
      expect((await unseal<{ state: string; returnTo: string }>(env, STATE_COOKIE, sealed))).toMatchObject({ state, returnTo: "/" });
    }
  });

  it("logout clears the cookie and ends the AuthKit session", async () => {
    addUser("user_a", "ana@example.com");
    const { cookie } = await sessionCookie("user_a");
    const res = await call("/auth/logout", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${API}/user_management/sessions/logout?session_id=session_user_a&return_to=${encodeURIComponent(`${ORIGIN}/`)}`);
    expect(res.headers.get("set-cookie")).toMatch(/^austere_session=; Path=\/; .*Max-Age=0/);
  });

  it("config gives the CLI the client id and API base; accounts off is 503", async () => {
    expect(await (await call("/auth/config")).json()).toEqual({ clientId: "client_test", apiBase: API });
    const off = { ...env, WORKOS_CLIENT_ID: undefined, WORKOS_API_KEY: undefined } as Env;
    expect((await call("/auth/config", { env: off })).status).toBe(503);
    expect((await call("/auth/login", { env: off })).status).toBe(503);
  });

  it("the shell tells the chrome where to sign in", async () => {
    const { id } = await publish(await newOwner());
    const html = await (await call(`/p/${id}`)).text();
    expect(html).toContain(`"signIn":"/auth/login?return_to=%2Fp%2F${id}"`);
  });
});

describe("dashboard", () => {
  it("signed out: a sign-in link; signed in: my pages, their grants, and pages shared with me", async () => {
    expect(await (await call("/")).text()).toContain('href="/auth/login?return_to=%2F"');
    const owner = await account("user_o", "olga@example.com", "Olga");
    const id = await accountPage(owner.at);
    const { cookie } = await sessionCookie("user_o");

    const add = await call(`/dash/pages/${id}/grants`, { method: "POST", headers: { cookie, origin: ORIGIN }, body: new URLSearchParams({ email: "ana@example.com" }) });
    expect(add.status).toBe(303);
    const foreign = await call(`/dash/pages/${id}/grants`, { method: "POST", headers: { cookie, origin: "https://evil.test" }, body: new URLSearchParams({ email: "eve@example.com" }) });
    expect(foreign.status).toBe(403);

    const res = await call("/", { headers: { cookie } });
    const html = await res.text();
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self' https://workos.test");
    expect(html).toContain("olga@example.com");
    expect(html).toContain(`href="/p/${id}"`);
    expect(html).toContain("ana@example.com");
    expect(html).not.toContain("eve@example.com");

    addUser("user_a", "ana@example.com", "Ana");
    const shared = await (await call("/", { headers: { cookie: (await sessionCookie("user_a")).cookie } })).text();
    expect(shared).toContain("Shared with you");
    expect(shared).toContain(`href="/p/${id}"`);

    const rm = await call(`/dash/pages/${id}/grants/remove`, { method: "POST", headers: { cookie, origin: ORIGIN }, body: new URLSearchParams({ email: "ana@example.com" }) });
    expect(rm.status).toBe(303);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM grants").first<{ n: number }>())!.n).toBe(0);
  });

  it("grant and revoke answer 303 with a code, never the email, and the notice shows in the page's entry", async () => {
    const owner = await account("user_o", "olga@example.com");
    const id = await accountPage(owner.at);
    const { cookie } = await sessionCookie("user_o");
    const post = (path: string, email: string) => call(path, { method: "POST", headers: { cookie, origin: ORIGIN }, body: new URLSearchParams({ email }) });
    const where = (res: Response) => res.headers.get("location");
    const entry = `/?page=${id}`;

    const granted = await post(`/dash/pages/${id}/grants`, "Ana@Example.com");
    expect([granted.status, where(granted)]).toEqual([303, `${entry}&done=granted#page-${id}`]);
    const exists = await post(`/dash/pages/${id}/grants`, "ana@example.com");
    expect(where(exists)).toBe(`${entry}&done=exists#page-${id}`);
    const badEmail = await post(`/dash/pages/${id}/grants`, "not an email");
    expect([badEmail.status, where(badEmail)]).toEqual([303, `${entry}&error=email#page-${id}`]);
    const revoked = await post(`/dash/pages/${id}/grants/remove`, "ana@example.com");
    expect(where(revoked)).toBe(`${entry}&done=revoked#page-${id}`);
    const again = await post(`/dash/pages/${id}/grants/remove`, "ana@example.com");
    expect(where(again)).toBe(`${entry}&done=revoked#page-${id}`);

    for (let i = 0; i < 100; i++) await env.DB.prepare("INSERT INTO grants (page_id, email, role, created_at) VALUES (?, ?, 'collaborator', ?)").bind(id, `u${i}@example.com`, i).run();
    const full = await post(`/dash/pages/${id}/grants`, "late@example.com");
    expect(where(full)).toBe(`${entry}&error=limit#page-${id}`);

    const missing = await post(`/dash/pages/nope/grants`, "ana@example.com");
    expect([missing.status, where(missing)]).toEqual([303, "/?error=gone"]);
    await env.DB.prepare("UPDATE pages SET taken_down = 1 WHERE id = ?").bind(id).run();
    expect(where(await post(`/dash/pages/${id}/grants`, "ana@example.com"))).toBe("/?error=gone");

    const notice = async (query: string) => (await (await call(`/${query}`, { headers: { cookie } })).text()).match(/class="notice[^"]*" id="[^"]*" role="\w+">([^<]*)</)?.[1];
    await env.DB.prepare("UPDATE pages SET taken_down = 0 WHERE id = ?").bind(id).run();
    expect(await notice(`?page=${id}&done=granted`)).toBe("Access granted. They open the page after they sign in with that email.");
    expect(await notice(`?page=${id}&done=exists`)).toBe("That email already has access.");
    expect(await notice(`?page=${id}&done=revoked`)).toBe("Access revoked. Any tab they have open on this page loses access now.");
    expect(await notice(`?page=${id}&error=email`)).toBe("Enter an email address, like name@example.com.");
    expect(await notice(`?page=${id}&error=limit`)).toBe("This page has 100 grants, the most it can have. Revoke one first.");
    expect(await notice("?error=gone")).toBe("That page expired or was taken down.");
    // Unknown codes, and a page that is not in the list, show nothing.
    expect(await notice(`?page=${id}&done=bogus`)).toBeUndefined();
    expect(await notice(`?page=${id}&error=granted`)).toBeUndefined();
    expect(await notice("?page=other&done=granted")).toBeUndefined();
    const bad = await (await call(`/?page=${id}&error=email`, { headers: { cookie } })).text();
    expect(bad).toContain('aria-invalid="true"');
  });

  it("signed in: private head (no canonical, Open Graph or JSON-LD), site shell, no old inline styles", async () => {
    addUser("user_o", "olga@example.com");
    const res = await call("/", { headers: { cookie: (await sessionCookie("user_o")).cookie } });
    const html = await res.text();
    expect(html).toContain("<title>Your pages · austere</title>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).not.toMatch(/rel="canonical"|og:|twitter:|ld\+json/);
    expect(html).toContain('action="/auth/logout"');
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self'");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("empty states: no pages shows the login and publish commands; nothing shared shows its text", async () => {
    addUser("user_o", "olga@example.com");
    const html = await (await call("/", { headers: { cookie: (await sessionCookie("user_o")).cookie } })).text();
    expect(html).toContain("No pages yet.");
    expect(html).toContain("Pages you publish while the CLI is signed in as olga@example.com show up here.");
    expect(html).toContain("<code>austere-axi cloud login</code>");
    expect(html).toContain("<code>austere-axi publish &lt;file&gt;</code>");
    expect(html).toContain("New to austere-axi? Install guide");
    expect(html).toContain("Nothing shared with you yet. When an owner grants olga@example.com, the page shows up here.");
  });

  it("shared with you: the owner's name, else email, and the expiry", async () => {
    const named = await account("user_o", "olga@example.com", "Olga", "Ruiz");
    const plain = await account("user_p", "pat@example.com");
    const one = await accountPage(named.at);
    const two = await accountPage(plain.at);
    await grantTo(named.at, one, "ana@example.com");
    await grantTo(plain.at, two, "ana@example.com");
    await env.DB.prepare("UPDATE pages SET expires_at = ? WHERE id = ?").bind(Date.now() + 30 * 3600_000, one).run();
    addUser("user_a", "ana@example.com");
    const html = await (await call("/", { headers: { cookie: (await sessionCookie("user_a")).cookie } })).text();
    expect(html).toContain("Olga Ruiz");
    expect(html).toContain("pat@example.com");
    expect(html).toContain('<time class="soon"');
    expect(html).toContain("Expires in 2 days");
  });

  it("each owned page's register lists only its own grants", async () => {
    const owner = await account("user_o", "olga@example.com");
    const one = await accountPage(owner.at);
    const two = await accountPage(owner.at);
    await grantTo(owner.at, one, "ana@example.com");
    await grantTo(owner.at, two, "bo@example.com");
    const html = await (await call("/", { headers: { cookie: (await sessionCookie("user_o")).cookie } })).text();
    const entry = (id: string) => html.slice(html.indexOf(`id="page-${id}"`), html.indexOf("</article>", html.indexOf(`id="page-${id}"`)));
    expect(entry(one)).toContain("ana@example.com");
    expect(entry(one)).not.toContain("bo@example.com");
    expect(entry(two)).toContain("bo@example.com");
    expect(entry(two)).toContain("Revoke access for bo@example.com");
  });

  it("a page deleted by its owner takes its grants with it", async () => {
    const owner = await account("user_o", "olga@example.com");
    const id = await createPage(owner.at);
    await grantTo(owner.at, id, "ana@example.com");
    const sock = await ownerSocket(owner.at, id);
    expect((await sock.mutate("delete", {})).error).toBeUndefined();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM grants").first<{ n: number }>())!.n).toBe(0);
  });
});
