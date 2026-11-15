// Invite-only access (RLM-314): grant/revoke, the reviewer handshake, asset tokens, the open link.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { syncProtocols } from "austere-axi/sync";
import type { AclRow, NoteRow, ReceivedFrame } from "austere-axi/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifact, assetToken, call, grant, newOwner, open, ownerSocket, publish, refusalCode, reviewerSocket, sha256B64url } from "./helpers";

const note = (text: string) => ({ items: [{ kind: "message" as const, text }] });
const isError = (code: string) => (f: ReceivedFrame) => f.t === "error" && f.code === code;
const stub = (id: string) => env.PAGE.get(env.PAGE.idFromName(id));

/** An invite-only page with an owner socket that has pulled. */
async function invitePage() {
  const token = await newOwner();
  const { id, ack } = await publish(token);
  expect(ack.error).toBeUndefined();
  const owner = await ownerSocket(token, id);
  await owner.pull(0);
  return { token, id, owner };
}

async function refused(id: string, invite?: string): Promise<Response> {
  const res = await open(`/p/${id}/sync`, { protocols: syncProtocols({ invite }) });
  if (!(res instanceof Response)) throw new Error("handshake was accepted");
  return res;
}

describe("invite-only by default", () => {
  it("no invite: 403 on the socket, the asset token and the artifact; the shell stays public", async () => {
    const { id } = await invitePage();
    expect((await call(`/p/${id}`)).status).toBe(200);
    const sock = await refused(id);
    expect(sock.status).toBe(403);
    expect(await refusalCode(sock)).toBe("forbidden");
    expect((await refused(id, "x".repeat(43))).status).toBe(403);
    expect((await assetToken(id)).status).toBe(403);
    expect((await assetToken(id, "not a token")).status).toBe(403);
    expect((await assetToken(id, "x".repeat(43))).status).toBe(403);
    for (const path of [`/p/${id}/a/`, `/p/${id}/a/${"A".repeat(43)}/`, `/p/${id}/a/short/`]) {
      expect((await call(path)).status, path).toBe(403);
    }
  });

  it("a valid invite opens the artifact and the feed; notes carry the invite name", async () => {
    const { id, owner } = await invitePage();
    const ana = await grant(owner, "Ana");
    const acl = (await owner.changes()).rows[0] as AclRow;
    expect(acl).toMatchObject({ type: "acl", id: "Ana", name: "Ana", revoked: false, expiresAt: null });
    expect(JSON.stringify(acl)).not.toContain(await sha256B64url(ana)); // the hash never leaves the server

    const res = await assetToken(id, ana);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { token: string; expiresAt: number; name: string | null };
    expect(answer.name).toBe("Ana");
    expect(answer.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(answer.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(answer.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect((await call(`/p/${id}/a/${answer.token}/`)).status).toBe(200);

    const reviewer = await reviewerSocket(id, { invite: ana });
    const [first] = await reviewer.pull(0);
    expect(first.rows.map((r) => r.type)).toEqual(["page"]); // acl rows are the owner's only
    // A self-declared name is ignored on an invite.
    expect((await reviewer.mutate("addNote", { ...note("hi"), name: "Mallory" })).error).toBeUndefined();
    expect(((await owner.changes()).rows[0] as NoteRow).author).toBe("Ana");
  });

  it("revoke closes that invitee's sockets at once and refuses its token; other invites keep working", async () => {
    const { id, owner } = await invitePage();
    const ana = await grant(owner, "Ana");
    const ben = await grant(owner, "Ben");
    const a = await reviewerSocket(id, { invite: ana });
    const b = await reviewerSocket(id, { invite: ben });
    await a.pull(0);
    await b.pull(0);
    const { token: anaAsset } = (await (await assetToken(id, ana)).json()) as { token: string };

    expect((await owner.mutate("revoke", { name: "Ana" })).error).toBeUndefined();
    expect(await a.take(isError("forbidden"))).toMatchObject({ message: expect.stringContaining("revoked") });
    expect((await a.closedWith()).code).toBe(1008);
    expect(await refusalCode(await refused(id, ana))).toBe("forbidden");
    expect((await assetToken(id, ana)).status).toBe(403);
    expect((await call(`/p/${id}/a/${anaAsset}/`)).status).toBe(403); // an asset token dies with its invite
    owner.frames.length = 0;
    const acls = (await owner.pull(0))[0].rows.filter((r): r is AclRow => r.type === "acl");
    expect(acls.map((r) => [r.name, r.revoked])).toEqual([
      ["Ben", false],
      ["Ana", true],
    ]);

    expect((await b.mutate("addNote", note("still here"))).error).toBeUndefined();
    expect(b.closed).toBeNull();
    expect((await artifact(id, ben)).status).toBe(200);
    // Revoking again changes nothing; an unknown name is invalid.
    expect((await owner.mutate("revoke", { name: "Ana" })).error).toBeUndefined();
    expect((await owner.mutate("revoke", { name: "Zoe" })).error?.code).toBe("invalid");
  });

  it("granting a name again replaces its token (old link closed) and revives a revoked invite", async () => {
    const { id, owner } = await invitePage();
    const old = await grant(owner, "Ana");
    const sock = await reviewerSocket(id, { invite: old });
    await sock.pull(0);
    const fresh = await grant(owner, "Ana");
    await sock.take(isError("forbidden"));
    expect((await sock.closedWith()).code).toBe(1008);
    expect((await refused(id, old)).status).toBe(403);
    (await reviewerSocket(id, { invite: fresh })).close();

    await owner.mutate("revoke", { name: "Ana" });
    const again = await grant(owner, "Ana");
    expect((await artifact(id, again)).status).toBe(200);
  });

  it("grant rejects a past expiry and a token hash another invite holds", async () => {
    const { owner } = await invitePage();
    const tokenHash = await sha256B64url("t".repeat(43));
    expect((await owner.mutate("grant", { name: "Ana", tokenHash, expiresAt: Date.now() - 1 })).error?.code).toBe("invalid");
    expect((await owner.mutate("grant", { name: "Ana", tokenHash, expiresAt: null })).error).toBeUndefined();
    expect((await owner.mutate("grant", { name: "Ben", tokenHash, expiresAt: null })).error?.code).toBe("invalid");
  });

  it("an expired invite is refused, and its open socket is closed by the alarm", async () => {
    const { id, owner } = await invitePage();
    const soon = Date.now() + 1500;
    const ana = await grant(owner, "Ana", soon);
    const sock = await reviewerSocket(id, { invite: ana });
    await sock.pull(0);
    expect(await runInDurableObject(stub(id), (_o, state) => state.storage.getAlarm())).toBe(soon);

    // The alarm fires on the page object's real clock, which a test cannot fake.
    await sock.take(isError("forbidden"), 4000);
    expect((await sock.closedWith()).code).toBe(1008);
    expect(await refusalCode(await refused(id, ana))).toBe("forbidden");
    expect((await assetToken(id, ana)).status).toBe(403);
  });

  it("an expired invite's socket is closed on its next frame too", async () => {
    const { id, owner } = await invitePage();
    const ana = await grant(owner, "Ana", Date.now() + 300);
    const sock = await reviewerSocket(id, { invite: ana });
    await sock.pull(0);
    await runInDurableObject(stub(id), (_o, state) => state.storage.deleteAlarm());
    // Real time: the expiry is compared with the page object's own clock, which a test cannot fake.
    await scheduler.wait(320);
    sock.sendRaw({ v: 1, t: "pull", after: 0 });
    await sock.take(isError("forbidden"));
    expect((await sock.closedWith()).code).toBe(1008);
  });

  it("counts notes per invite, not per IP", async () => {
    const { id, owner } = await invitePage();
    const ana = await reviewerSocket(id, { invite: await grant(owner, "Ana"), ip: "192.0.2.7" });
    const ben = await reviewerSocket(id, { invite: await grant(owner, "Ben"), ip: "192.0.2.7" });
    for (let i = 1; i <= 60; i++) expect((await ana.mutate("addNote", note(`n${i}`))).error, String(i)).toBeUndefined();
    expect((await ana.mutate("addNote", note("61"))).error?.code).toBe("rate_limited");
    expect((await ben.mutate("addNote", note("same IP"))).error).toBeUndefined();
  });
});

describe("asset tokens", () => {
  it("expire, and belong to one page", async () => {
    const token = await newOwner();
    const a = await publish(token);
    const b = await publish(token);
    const owner = await ownerSocket(token, a.id);
    const ana = await grant(owner, "Ana");
    const { token: asset } = (await (await assetToken(a.id, ana)).json()) as { token: string };
    expect((await call(`/p/${a.id}/a/${asset}/`)).status).toBe(200);
    expect((await call(`/p/${b.id}/a/${asset}/`)).status).toBe(403);
    expect((await assetToken(b.id, ana)).status).toBe(403); // the invite is page-scoped too

    await runInDurableObject(stub(a.id), (_o, state) => state.storage.sql.exec("UPDATE asset_tokens SET expires_at = ?", Date.now() - 1));
    expect((await call(`/p/${a.id}/a/${asset}/`)).status).toBe(403);
  });

  it("asset-token is same-origin POST only, and 404/410 like the page", async () => {
    const { id, owner } = await invitePage();
    const ana = await grant(owner, "Ana");
    expect((await call(`/p/${id}/asset-token`, { headers: { "x-austere-invite": ana } })).status).toBe(405);
    const foreign = await call(`/p/${id}/asset-token`, { method: "POST", headers: { "x-austere-invite": ana, origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    expect((await assetToken("A".repeat(22), ana)).status).toBe(404);
    await env.DB.prepare("UPDATE pages SET taken_down = 1 WHERE id = ?").bind(id).run();
    expect((await assetToken(id, ana)).status).toBe(410);
  });
});

describe("unlisted pages", () => {
  it("work without an invite: asset token (name null), artifact, socket, self-named notes", async () => {
    const token = await newOwner();
    const { id } = await publish(token, { args: { unlisted: true } });
    const res = await assetToken(id);
    const answer = (await res.json()) as { token: string; name: string | null };
    expect(answer.name).toBeNull();
    expect((await call(`/p/${id}/a/${answer.token}/`)).status).toBe(200);
    const reviewer = await reviewerSocket(id);
    await reviewer.pull(0);
    expect((await reviewer.mutate("addNote", { ...note("hi"), name: "Pat" })).error).toBeUndefined();
    expect(((await reviewer.changes()).rows[0] as NoteRow).author).toBe("Pat");

    // Clearing `unlisted` ends the open link's asset tokens too.
    await publish(token, { id });
    expect((await call(`/p/${id}/a/${answer.token}/`)).status).toBe(403);
    expect((await assetToken(id)).status).toBe(403);
  });
});

describe("the invite token stays out of logs and Referer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is never logged, echoed or answered, and every page response sets no-referrer", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    }
    const { id, owner } = await invitePage();
    const ana = await grant(owner, "Ana");
    const bodies: string[] = [];
    const shell = await call(`/p/${id}`);
    expect(shell.headers.get("referrer-policy")).toBe("no-referrer");
    bodies.push(await shell.text());
    const tok = await assetToken(id, ana);
    bodies.push(await tok.clone().text(), JSON.stringify([...tok.headers]));
    const art = await call(`/p/${id}/a/${((await tok.json()) as { token: string }).token}/`);
    expect(art.headers.get("referrer-policy")).toBe("no-referrer");
    bodies.push(await art.text());
    const sock = await reviewerSocket(id, { invite: ana });
    await sock.pull(0);
    await owner.mutate("revoke", { name: "Ana" });
    await sock.closedWith();
    const refusal = await refused(id, ana);
    bodies.push(await refusal.text(), JSON.stringify([...refusal.headers]));
    bodies.push(JSON.stringify(sock.frames), JSON.stringify(await owner.pull(0)));

    for (const text of [...bodies, ...lines]) expect(text).not.toContain(ana);
    const ops = await runInDurableObject(stub(id), (_o, state) => state.storage.sql.exec("SELECT args FROM ops").toArray());
    expect(JSON.stringify(ops)).not.toContain(ana); // only the hash reaches storage
  });
});
