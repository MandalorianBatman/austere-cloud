// Accounts (RLM-414): WorkOS access tokens verified against the JWKS, the CLI's bearer access
// token, claiming anonymous owner tokens, per-page grants, the browser session cookie and its
// refresh rotation, /auth/* and the dashboard. WorkOS is the stub in test/workos.ts.
import { env } from "cloudflare:workers";
import type { NoteRow, ReceivedFrame } from "austere-axi/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAccessToken } from "../src/jwt";
import { SESSION_COOKIE, STATE_COOKIE, unseal, type SessionData } from "../src/session";
import { ORIGIN, assetToken, call, createPage, newOwner, open, ownerSocket, publish, reviewerSocket } from "./helpers";
import { API, accessToken, addUser, installWorkos, keys, sessionCookie, stub } from "./workos";

beforeEach(installWorkos);
afterEach(() => vi.restoreAllMocks());

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
    // An anonymous owner token is no account.
    expect(await (await call("/api/me", { token: await newOwner() })).json()).toEqual({ user: null, pages: 0 });
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

describe("claiming an anonymous owner token", () => {
  it("pages published anonymously belong to the account after the claim; the old token keeps working", async () => {
    const token = await newOwner();
    const { id } = await publish(token);
    const a = await account("user_a", "ana@example.com");
    expect((await call(`/api/pages/${id}/html`, { token: a.at })).status).toBe(404);

    const res = await call("/api/owners/claim", { method: "POST", token: a.at, json: { token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pages: 1 });
    // Claiming again is a no-op.
    expect((await call("/api/owners/claim", { method: "POST", token: a.at, json: { token } })).status).toBe(200);

    const list = (await (await call("/api/pages", { token: a.at })).json()) as { pages: { id: string }[] };
    expect(list.pages.map((p) => p.id)).toEqual([id]);
    const sock = await ownerSocket(a.at, id);
    expect((await sock.mutate("addReply", { text: "from the account" })).error).toBeUndefined();
    sock.close();
    expect((await call("/api/pages", { token })).status).toBe(200);
  });

  it("a token another account claimed is 409; an unknown one 404; an owner token cannot claim", async () => {
    const token = await newOwner();
    const a = await account("user_a", "ana@example.com");
    const b = await account("user_b", "ben@example.com");
    expect((await call("/api/owners/claim", { method: "POST", token: a.at, json: { token } })).status).toBe(200);
    expect((await call("/api/owners/claim", { method: "POST", token: b.at, json: { token } })).status).toBe(409);
    expect((await call("/api/owners/claim", { method: "POST", token: b.at, json: { token: "x".repeat(43) } })).status).toBe(404);
    expect((await call("/api/owners/claim", { method: "POST", token: await newOwner(), json: { token } })).status).toBe(403);
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

  it("a page deleted by its owner takes its grants with it", async () => {
    const owner = await account("user_o", "olga@example.com");
    const id = await createPage(owner.at);
    await grantTo(owner.at, id, "ana@example.com");
    const sock = await ownerSocket(owner.at, id);
    expect((await sock.mutate("delete", {})).error).toBeUndefined();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM grants").first<{ n: number }>())!.n).toBe(0);
  });
});
