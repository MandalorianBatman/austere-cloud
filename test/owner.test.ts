// Owner sign-in (RLM-384): a single-use code from POST /api/pages/:id/login, traded at
// /p/:id?login=<code> for a page-scoped `austere_owner` session cookie.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { syncProtocols } from "austere-axi/sync";
import type { NoteRow, ReceivedFrame, ViewerHello } from "austere-axi/sync";
import { describe, expect, it } from "vitest";
import { OWNER_LOGIN_MS } from "../src/page";
import { assetToken, call, createPage, grant, invite, newOwner, open, ownerSocket, publish, reviewerSocket } from "./helpers";

const stub = (id: string) => env.PAGE.get(env.PAGE.idFromName(id));
const LOGIN_FAILED = "This sign-in link was used already or has expired. Run `austere-axi publish login <file>` for a new one.";

type Answer = { token: string; expiresAt: number; name: string | null; title: string; owner: boolean };

function login(id: string, token?: string): Promise<Response> {
  return call(`/api/pages/${id}/login`, { method: "POST", token });
}

async function code(id: string, token: string): Promise<string> {
  const res = await login(id, token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { code: string; ttlMs: number };
  expect(body.ttlMs).toBe(OWNER_LOGIN_MS);
  expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return body.code;
}

/** Trades a fresh code; returns the Cookie header the browser would send back. */
async function signIn(id: string, token: string): Promise<string> {
  const res = await call(`/p/${id}?login=${await code(id, token)}`);
  expect(res.status).toBe(303);
  const cookie = /^austere_owner=([A-Za-z0-9_-]{43});/.exec(res.headers.get("set-cookie") ?? "");
  expect(cookie).not.toBeNull();
  return `austere_owner=${cookie![1]}`;
}

async function ownedPage(title = "Owner plan") {
  const token = await newOwner();
  const { id, ack } = await publish(token, { args: { title } });
  expect(ack.error).toBeUndefined();
  return { token, id };
}

describe("POST /api/pages/:id/login", () => {
  it("needs the bearer token of the page's owner and a published page", async () => {
    const { token, id } = await ownedPage();
    expect((await login(id)).status).toBe(401);
    expect(await (await login(id, "nope")).json()).toEqual({ error: "invalid token" });
    const other = await newOwner();
    const theirs = await login(id, other);
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: "page not found" });
    expect((await login(await createPage(token), token)).status).toBe(404); // not published yet
    expect((await login("A".repeat(22), token)).status).toBe(404);
    expect((await call(`/api/pages/${id}/login`, { token })).status).toBe(405);
    expect((await call(`/api/pages/${id}/login`, { token })).headers.get("allow")).toBe("POST");
    await env.DB.prepare("UPDATE pages SET taken_down = 1 WHERE id = ?").bind(id).run();
    expect((await login(id, token)).status).toBe(410);
  });

  it("stores only the code's hash", async () => {
    const { token, id } = await ownedPage();
    const c = await code(id, token);
    const rows = await runInDurableObject(stub(id), (_o, state) => state.storage.sql.exec("SELECT * FROM owner_logins").toArray());
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(c);
  });
});

describe("GET /p/:id?login=<code>", () => {
  it("trades a live code once for a page-scoped owner cookie and redirects to the page", async () => {
    const { token, id } = await ownedPage();
    const c = await code(id, token);
    const res = await call(`/p/${id}?login=${c}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/p/${id}`);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^austere_owner=[A-Za-z0-9_-]{43}; Path=/p/${id}; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$`));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const sessions = await runInDurableObject(stub(id), (_o, state) => state.storage.sql.exec("SELECT * FROM owner_sessions").toArray());
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(cookie.slice("austere_owner=".length, cookie.indexOf(";")));

    const again = await call(`/p/${id}?login=${c}`);
    expect(again.status).toBe(403);
    expect(again.headers.get("content-type")).toContain("text/plain");
    expect(await again.text()).toBe(LOGIN_FAILED);
  });

  it("refuses an expired, unknown, malformed or another page's code; 404/410 follow the page", async () => {
    const { token, id } = await ownedPage();
    const expired = await code(id, token);
    await runInDurableObject(stub(id), (_o, state) => state.storage.sql.exec("UPDATE owner_logins SET expires_at = ?", Date.now() - 1));
    for (const c of [expired, "A".repeat(43), "short", ""]) {
      const res = await call(`/p/${id}?login=${c}`);
      expect(res.status, c).toBe(403);
      expect(await res.text()).toBe(LOGIN_FAILED);
    }
    const other = await publish(token);
    expect((await call(`/p/${other.id}?login=${await code(id, token)}`)).status).toBe(403);
    expect((await call(`/p/${"A".repeat(22)}?login=${await code(id, token)}`)).status).toBe(404);
    const unpublished = await createPage(token);
    expect((await call(`/p/${unpublished}?login=${"A".repeat(43)}`)).status).toBe(404);
    const live = await code(id, token);
    await env.DB.prepare("UPDATE pages SET taken_down = 1 WHERE id = ?").bind(id).run();
    expect((await call(`/p/${id}?login=${live}`)).status).toBe(410);
  });

  it("without the login param is the normal shell", async () => {
    const { id } = await ownedPage();
    const res = await call(`/p/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("the owner cookie", () => {
  it("wins the asset token over any invite: name Owner, owner true, the title; it serves the artifact", async () => {
    const { token, id } = await ownedPage("Owner plan");
    const ana = await invite(token, id, "Ana");
    const cookie = await signIn(id, token);
    for (const inv of [undefined, ana, "not a token"]) {
      const res = await assetToken(id, inv, { cookie });
      expect(res.status, String(inv)).toBe(200);
      const answer = (await res.json()) as Answer;
      expect(answer).toMatchObject({ name: "Owner", owner: true, title: "Owner plan" });
      expect((await call(`/p/${id}/a/${answer.token}/`)).status).toBe(200);
    }
  });

  it("an expired session is ignored, and its asset tokens stop working", async () => {
    const { token, id } = await ownedPage();
    const cookie = await signIn(id, token);
    const { token: asset } = (await (await assetToken(id, undefined, { cookie })).json()) as Answer;
    await runInDurableObject(stub(id), (_o, state) => state.storage.sql.exec("UPDATE owner_sessions SET expires_at = ?", Date.now() - 1));
    const res = await assetToken(id, undefined, { cookie });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("this page needs an invite");
    expect((await call(`/p/${id}/a/${asset}/`)).status).toBe(403);
    // An invite still works alongside a dead cookie.
    const ana = await invite(token, id, "Ana");
    expect(await (await assetToken(id, ana, { cookie })).json()).toMatchObject({ name: "Ana", owner: false });
  });

  it("belongs to one page: a session of page A is not owner on page B", async () => {
    const { token, id: a } = await ownedPage();
    const { id: b } = await publish(token, { args: { title: "Other" } });
    const cookie = await signIn(a, token);
    expect((await assetToken(b, undefined, { cookie })).status).toBe(403);
    const sock = await open(`/p/${b}/sync`, { protocols: syncProtocols({}), cookie });
    expect(sock instanceof Response && sock.status).toBe(403);
  });

  it("lets the reviewer socket in as Owner, over an offered invite; notes and presence say Owner", async () => {
    const { token, id } = await ownedPage();
    const owner = await ownerSocket(token, id);
    await owner.pull(0);
    const ana = await grant(owner, "Ana");
    await owner.changes();
    const cookie = await signIn(id, token);
    const sock = await reviewerSocket(id, { invite: ana, cookie });
    const [first] = await sock.pull(0);
    expect(first.rows.map((r) => r.type)).toEqual(["page"]); // still a reviewer: no acl rows
    expect((await sock.mutate("addNote", { items: [{ kind: "message", text: "from me" }], name: "Mallory" })).error).toBeUndefined();
    expect(((await owner.changes()).rows[0] as NoteRow).author).toBe("Owner");
    sock.sendRaw({ v: 1, t: "hello", name: "Mallory", status: "viewing" });
    const self = await sock.take((f: ReceivedFrame): f is ViewerHello => f.t === "hello" && f.self);
    expect(self.viewer).toMatchObject({ name: "Owner", role: "reviewer" });
    // Revoking the invite it also offered does not close it.
    await owner.mutate("revoke", { name: "Ana" });
    expect((await sock.mutate("addNote", { items: [{ kind: "message", text: "still here" }] })).error).toBeUndefined();
    expect(sock.closed).toBeNull();
  });

  it("closes the owner's reviewer socket once the session expires", async () => {
    const { token, id } = await ownedPage();
    const sock = await reviewerSocket(id, { cookie: await signIn(id, token) });
    await sock.pull(0);
    expect(await runInDurableObject(stub(id), (_o, state) => state.storage.getAlarm())).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    // The page object's clock can't be faked: age the session in the socket's attachment instead.
    await runInDurableObject(stub(id), (_o, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { session?: { expiresAt: number } };
        if (att.session) ws.serializeAttachment({ ...att, session: { ...att.session, expiresAt: Date.now() - 1 } });
      }
    });
    sock.sendRaw({ v: 1, t: "pull", after: 0 });
    expect(await sock.take((f) => f.t === "error" && f.code === "forbidden")).toMatchObject({ message: "this sign-in has expired" });
    expect((await sock.closedWith()).code).toBe(1008);
  });

  it("dies with the page: delete ends the session", async () => {
    const { token, id } = await ownedPage();
    const cookie = await signIn(id, token);
    const owner = await ownerSocket(token, id);
    expect((await owner.mutate("delete", {})).error).toBeUndefined();
    expect((await assetToken(id, undefined, { cookie })).status).toBe(404);
    const rows = await runInDurableObject(stub(id), (_o, state) => state.storage.sql.exec("SELECT * FROM owner_sessions").toArray());
    expect(rows).toHaveLength(0);
  });
});

describe("asset-token answers carry the title and owner flag", () => {
  it("invite and open link: owner false", async () => {
    const { token, id } = await ownedPage("Invite plan");
    const ana = await invite(token, id, "Ana");
    expect(await (await assetToken(id, ana)).json()).toMatchObject({ name: "Ana", title: "Invite plan", owner: false });
    const open = await publish(token, { args: { title: "Open plan", unlisted: true } });
    expect(await (await assetToken(open.id)).json()).toMatchObject({ name: null, title: "Open plan", owner: false });
  });
});

describe("existing page objects", () => {
  it("gain asset_tokens.session_hash without losing rows", async () => {
    const { token, id } = await ownedPage();
    const ana = await invite(token, id, "Ana");
    const { token: asset } = (await (await assetToken(id, ana)).json()) as Answer;
    // Rebuild the table as it was before owner sign-in, keeping the row, then run init again.
    await runInDurableObject(stub(id), (o, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE old_tokens (token_hash TEXT PRIMARY KEY, invite_hash TEXT, expires_at INTEGER NOT NULL)");
      sql.exec("INSERT INTO old_tokens SELECT token_hash, invite_hash, expires_at FROM asset_tokens");
      sql.exec("DROP TABLE asset_tokens");
      sql.exec("ALTER TABLE old_tokens RENAME TO asset_tokens");
      (o as unknown as { init(): void }).init();
      const cols = sql.exec<{ name: string }>("PRAGMA table_info(asset_tokens)").toArray().map((c) => c.name);
      expect(cols).toContain("session_hash");
    });
    expect((await call(`/p/${id}/a/${asset}/`)).status).toBe(200);
  });
});
