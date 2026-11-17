import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { LIMITS, syncProtocols } from "austere-axi/sync";
import type { NoteRow, PageRow, ReceivedFrame, ReplyRow } from "austere-axi/sync";
import { describe, expect, it } from "vitest";
import { CLI, PAGE_HTML, call, createPage, newOwner, open, ownerSocket, publish, publishArgs, putObject, refusalCode, reviewerSocket } from "./helpers";

const note = (text: string) => ({ items: [{ kind: "message" as const, text }] });
const isError = (code: string) => (f: ReceivedFrame) => f.t === "error" && f.code === code;

/** A published unlisted page (open link, no invite needed) with an owner socket that has pulled. */
async function published(args = {}) {
  const token = await newOwner();
  const { id, ack } = await publish(token, { args: { unlisted: true, ...args } });
  expect(ack.error).toBeUndefined();
  const owner = await ownerSocket(token, id);
  await owner.pull(0);
  return { token, id, owner };
}

describe("round trip", () => {
  it("reviewer note reaches the owner live; the owner's reply reaches the reviewer", async () => {
    const { id, owner } = await published();
    const reviewer = await reviewerSocket(id);
    const [first] = await reviewer.pull(0);
    expect(first.rows.map((r) => r.type)).toEqual(["page"]);
    const page = first.rows[0] as PageRow;
    expect(page).toMatchObject({ v: 1, id, seq: 1, title: "Plan", cliVersion: CLI, deleted: false, auto: false });
    expect(first.cursor).toBe(1);

    const ack = await reviewer.mutate("addNote", { ...note("Why now?"), name: "Ana" });
    expect(ack).toEqual({ v: 1, t: "ack", clientId: reviewer.clientId, n: 1 });

    const live = await owner.changes();
    expect(live.cursor).toBe(2);
    const row = live.rows[0] as NoteRow;
    expect(row).toMatchObject({ type: "note", seq: 2, author: "Ana", state: "held", items: [{ kind: "message", text: "Why now?" }] });
    // The sender gets its own row through the feed too.
    expect((await reviewer.changes()).rows[0]).toEqual(row);

    expect((await owner.mutate("addReply", { text: "Because." })).error).toBeUndefined();
    const reply = (await reviewer.changes()).rows[0] as ReplyRow;
    expect(reply).toMatchObject({ type: "reply", seq: 3, text: "Because." });
    expect((await owner.changes()).rows[0]).toEqual(reply);

    // The note count feeds GET /api/pages.
    const { notes } = (await env.DB.prepare("SELECT notes FROM pages WHERE id = ?").bind(id).first<{ notes: number }>())!;
    expect(notes).toBe(1);
  });

  it("reconnecting with after=<cursor> gets only newer rows, each once in its latest state", async () => {
    const { id, owner } = await published();
    const reviewer = await reviewerSocket(id);
    const [first] = await reviewer.pull(0);
    await reviewer.mutate("addNote", note("one"));
    const noteId = (await owner.changes()).rows[0].id;
    reviewer.close();

    await owner.mutate("addReply", { text: "r1" });
    await owner.mutate("releaseNote", { note: noteId });
    const again = await reviewerSocket(id);
    const frames = await again.pull(first.cursor);
    expect(frames).toHaveLength(1);
    expect(frames[0].rows.map((r) => [r.type, r.seq])).toEqual([
      ["reply", 3],
      ["note", 4],
    ]);
    expect((frames[0].rows[1] as NoteRow).state).toBe("released");
    expect(frames[0].cursor).toBe(4);
    expect((await again.pull(4))[0]).toMatchObject({ rows: [], cursor: 4 });
  });

  // 520 round trips in sequence: the default 5 s is too tight when every test file runs at once.
  it("pages a large pull in frames of 500 with more:true", { timeout: 30_000 }, async () => {
    const { owner } = await published();
    for (let i = 0; i < 520; i++) await owner.mutate("addReply", { text: `r${i}` });
    await owner.take((f) => f.t === "changes" && f.cursor === 521); // the last live frame
    owner.frames.length = 0;
    const frames = await owner.pull(0);
    expect(frames.map((f) => [f.rows.length, f.cursor, f.more])).toEqual([
      [500, 500, true],
      [21, 521, undefined],
    ]);
  });

  it("answers a cursor ahead of the page with reset:true from 0", async () => {
    const { owner } = await published();
    const [f] = await owner.pull(99);
    expect(f).toMatchObject({ reset: true, cursor: 1 });
    expect(f.rows.map((r) => r.seq)).toEqual([1]);
  });

  it("keeps socket identity in the attachment across hibernation", async () => {
    const { id, owner } = await published();
    const reviewer = await reviewerSocket(id);
    await reviewer.pull(0);
    await evictDurableObject(env.PAGE.get(env.PAGE.idFromName(id)));
    // Still a reviewer, still live, after the object was evicted and woken by the frame.
    expect((await reviewer.mutate("addReply", { text: "x" })).error?.code).toBe("forbidden");
    await reviewer.mutate("addNote", note("after eviction"));
    expect(((await owner.changes()).rows[0] as NoteRow).items).toEqual([{ kind: "message", text: "after eviction" }]);
  });
});

describe("idempotency", () => {
  it("applies a duplicate (clientId, n) once and answers it the same way", async () => {
    const { id, owner } = await published();
    const reviewer = await reviewerSocket(id);
    await reviewer.pull(0);
    const a = await reviewer.mutate("addNote", note("once"), 7);
    const b = await reviewer.mutate("addNote", note("once"), 7);
    expect(b).toEqual(a);
    // Also from a new socket with the same clientId (a reconnect).
    const again = await reviewerSocket(id, { clientId: reviewer.clientId });
    expect(await again.mutate("addNote", note("once"), 7)).toEqual(a);
    const [f] = await owner.pull(0);
    expect(f.rows.filter((r) => r.type === "note")).toHaveLength(1);
  });

  it("replays a stored rejection", async () => {
    const { owner } = await published();
    const first = await owner.mutate("releaseNote", { note: "missing" }, 3);
    expect(first.error).toMatchObject({ code: "invalid" });
    expect(await owner.mutate("releaseNote", { note: "missing" }, 3)).toEqual(first);
  });
});

describe("roles and credentials", () => {
  it("rejects owner mutations from a reviewer socket with forbidden", async () => {
    const { id, owner } = await published();
    const reviewer = await reviewerSocket(id);
    await reviewer.pull(0);
    for (const [name, args] of [
      ["addReply", { text: "hi" }],
      ["releaseNote", { note: "x" }],
      ["discardNote", { note: "x" }],
      ["publish", publishArgs("a".repeat(64))],
      ["delete", {}],
    ] as const) {
      const ack = await reviewer.mutate(name, args as never);
      expect(ack.error?.code, name).toBe("forbidden");
    }
    expect((await owner.mutate("addNote", note("me"))).error?.code).toBe("forbidden");
    const [f] = await owner.pull(0);
    expect(f.rows.map((r) => r.type)).toEqual(["page"]);
  });

  it("refuses the owner socket without a valid owner token, or for another owner's page", async () => {
    const token = await newOwner();
    const id = await createPage(token);
    const path = `/api/pages/${id}/sync?cli=${CLI}`;
    for (const protocols of [["austere-sync.1"], syncProtocols({ owner: "x".repeat(43) }), syncProtocols({ invite: token })]) {
      const res = (await open(path, { protocols })) as Response;
      expect(res.status, protocols.join()).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "forbidden", message: expect.any(String) } });
    }
    const other = await newOwner("198.51.100.20");
    expect(((await open(path, { protocols: syncProtocols({ owner: other }) })) as Response).status).toBe(404);
  });

  it("answers austere-sync.1 and never echoes the credential", async () => {
    const token = await newOwner();
    const id = await createPage(token);
    const res = await call(`/api/pages/${id}/sync?cli=${CLI}`, {
      headers: { upgrade: "websocket", "sec-websocket-protocol": syncProtocols({ owner: token }).join(", ") },
    });
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe("austere-sync.1");
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it("426s without the subprotocol, without an upgrade, or for a CLI below MIN_CLI_VERSION", async () => {
    const token = await newOwner();
    const id = await createPage(token);
    const owner = syncProtocols({ owner: token });
    const cases: [string, Parameters<typeof open>[1]][] = [
      [`/api/pages/${id}/sync?cli=${CLI}`, { protocols: [`austere-owner.${token}`] }],
      [`/api/pages/${id}/sync?cli=0.8.1`, { protocols: owner }],
      [`/api/pages/${id}/sync`, { protocols: owner }],
    ];
    for (const [path, init] of cases) {
      const res = (await open(path, init)) as Response;
      expect(res.status, path).toBe(426);
      expect(await refusalCode(res)).toBe("upgrade_required");
    }
    expect((await call(`/api/pages/${id}/sync?cli=${CLI}`)).status).toBe(426);
  });

  it("reviewer socket: foreign Origin 403; unpublished 404; no invite 403 unless unlisted", async () => {
    const token = await newOwner();
    const unpublished = await createPage(token);
    expect(((await open(`/p/${unpublished}/sync`, { protocols: ["austere-sync.1"] })) as Response).status).toBe(404);
    // The owner can still connect to publish it.
    (await ownerSocket(token, unpublished)).close();

    const { id } = await publish(token);
    const foreign = (await open(`/p/${id}/sync`, { protocols: ["austere-sync.1"], origin: "https://evil.example" })) as Response;
    expect(foreign.status).toBe(403);

    const refused = (await open(`/p/${id}/sync`, { protocols: ["austere-sync.1"] })) as Response;
    expect(refused.status).toBe(403);
    expect(await refusalCode(refused)).toBe("forbidden");

    const { id: open2 } = await publish(token, { args: { unlisted: true } });
    const viaLink = await open(`/p/${open2}/sync`, { protocols: ["austere-sync.1"] });
    if (viaLink instanceof Response) throw new Error(`unlisted page refused: ${viaLink.status}`);
    // A publish that clears `unlisted` closes the sockets that came in through the open link.
    await publish(token, { id: open2, args: { unlisted: false } });
    await viaLink.take(isError("forbidden"));
    expect((await viaLink.closedWith()).code).toBe(1008);
    expect(((await open(`/p/${open2}/sync`, { protocols: ["austere-sync.1"] })) as Response).status).toBe(403);
  });
});

describe("limits and malformed frames", () => {
  it("rate-limits notes to 60 per hour per IP per page, unstored so a retry can succeed", async () => {
    const { id } = await published();
    const reviewer = await reviewerSocket(id, { ip: "192.0.2.9" });
    await reviewer.pull(0);
    for (let i = 1; i <= 60; i++) expect((await reviewer.mutate("addNote", note(`n${i}`))).error, String(i)).toBeUndefined();
    const over = await reviewer.mutate("addNote", note("61"), 61);
    expect(over.error).toMatchObject({ code: "rate_limited" });
    expect(over.error!.retryAfter).toBeGreaterThan(0);
    // Another IP is unaffected.
    const other = await reviewerSocket(id, { ip: "192.0.2.10" });
    expect((await other.mutate("addNote", note("hi"))).error).toBeUndefined();
    // Once the window has passed, the same (clientId, n) goes through: rate_limited was not stored.
    await env.DB.prepare("UPDATE limits SET window_start = window_start - 3600001 WHERE key LIKE 'note:%'").run();
    expect((await reviewer.mutate("addNote", note("61"), 61)).error).toBeUndefined();
  });

  it("too_large: note items over 4 KB get an ack; a frame over 64 KiB gets an error frame", async () => {
    const { id } = await published();
    const reviewer = await reviewerSocket(id);
    const big = await reviewer.mutate("addNote", note("x".repeat(LIMITS.noteItemsBytes)));
    expect(big.error).toMatchObject({ code: "too_large" });
    reviewer.sendRaw({ v: 1, t: "mutation", clientId: reviewer.clientId, n: 9, name: "addNote", args: note("x".repeat(LIMITS.frameBytes)) });
    expect(await reviewer.take(isError("too_large"))).toMatchObject({ t: "error" });
  });

  it("invalid: a readable key gets an ack, anything else an error frame; the socket stays open", async () => {
    const { owner } = await published();
    const nope = { v: 1, t: "mutation", clientId: owner.clientId, n: 40, name: "nope", args: {} };
    owner.sendRaw(nope);
    const first = await owner.take((f) => f.t === "ack" && f.n === 40);
    expect(first).toMatchObject({ error: { code: "invalid" } });
    owner.sendRaw(nope); // the same key again: the stored answer
    expect(await owner.take((f) => f.t === "ack" && f.n === 40)).toEqual(first);
    owner.sendRaw("{not json");
    await owner.take(isError("invalid"));
    owner.sendRaw({ v: 1, t: "teleport" });
    await owner.take(isError("invalid"));
    expect((await owner.mutate("revoke", { name: "Nobody" })).error?.code).toBe("invalid");
    expect((await owner.mutate("addReply", { text: "still open" })).error).toBeUndefined();
  });

  it("upgrade_required: v below MIN_SYNC_VERSION gets an error frame, then close 1008", async () => {
    const { owner } = await published();
    owner.sendRaw({ v: 0, t: "pull", after: 0 });
    await owner.take(isError("upgrade_required"));
    expect((await owner.closedWith()).code).toBe(1008);
  });
});

describe("mutations", () => {
  it("release and discard move held notes once; an auto page releases at once", async () => {
    const { id, owner } = await published();
    const reviewer = await reviewerSocket(id);
    await reviewer.mutate("addNote", { ...note("a"), name: "  " });
    await reviewer.mutate("addNote", { ...note("b"), name: "N".repeat(60) });
    const [a, b] = [(await owner.changes()).rows[0] as NoteRow, (await owner.changes()).rows[0] as NoteRow];
    expect(a.author).toBe("Reviewer");
    expect(b.author).toBe("N".repeat(LIMITS.nameChars));

    await owner.mutate("releaseNote", { note: a.id });
    await owner.mutate("discardNote", { note: b.id });
    expect(((await owner.changes()).rows[0] as NoteRow).state).toBe("released");
    expect(((await owner.changes()).rows[0] as NoteRow).state).toBe("discarded");
    // Settled notes stay as they are: no row change.
    expect((await owner.mutate("discardNote", { note: a.id })).error).toBeUndefined();
    const [f] = await owner.pull(0);
    expect((f.rows.find((r) => r.id === a.id) as NoteRow).state).toBe("released");
    expect(f.cursor).toBe(5);

    const auto = await published({ auto: true });
    const r2 = await reviewerSocket(auto.id);
    await r2.mutate("addNote", note("now"));
    expect(((await auto.owner.changes()).rows[0] as NoteRow).state).toBe("released");
  });

  it("publish rejects unknown objects, foreign scripts and old runtimes with invalid", async () => {
    const token = await newOwner();
    const id = await createPage(token);
    const owner = await ownerSocket(token, id);
    const bad = async (sha: string, over = {}) => (await owner.mutate("publish", publishArgs(sha, over))).error;
    expect(await bad("b".repeat(64))).toMatchObject({ code: "invalid", message: expect.stringContaining("not uploaded") });
    const evil = await putObject(token, PAGE_HTML.replace("</head>", `<script src="https://evil.example/x.js"></script></head>`));
    expect(await bad(evil.sha)).toMatchObject({ code: "invalid", message: expect.stringContaining("script src") });
    const ok = await putObject(token, PAGE_HTML);
    expect(await bad(ok.sha, { cliVersion: "0.8.1" })).toMatchObject({ code: "invalid", message: expect.stringContaining(CLI) });
    expect(await bad(ok.sha, { packs: [{ sha256: "c".repeat(64), name: "x", version: "1" }] })).toMatchObject({ code: "invalid" });
    const js = await putObject(token, "x();", "text/javascript");
    expect(await bad(js.sha)).toMatchObject({ code: "invalid", message: expect.stringContaining("not text/html") });
    expect((await call(`/p/${id}`)).status).toBe(404);
  });

  it("publish counts toward the 20-per-day owner limit", async () => {
    const token = await newOwner();
    const { id } = await publish(token);
    const owner = await ownerSocket(token, id);
    const { sha } = await putObject(token, PAGE_HTML);
    for (let i = 0; i < 19; i++) expect((await owner.mutate("publish", publishArgs(sha))).error, String(i)).toBeUndefined();
    const over = await owner.mutate("publish", publishArgs(sha));
    expect(over.error).toMatchObject({ code: "rate_limited" });
  });

  it("delete sends the deleted page row to every socket, closes them (1000), and refuses new ones", async () => {
    const { token, id, owner } = await published();
    const reviewer = await reviewerSocket(id);
    await reviewer.pull(0);
    await reviewer.mutate("addNote", note("bye"));
    await owner.changes();
    await reviewer.changes();

    expect((await owner.mutate("delete", {})).error).toBeUndefined();
    for (const c of [owner, reviewer]) {
      const f = await c.changes();
      expect(f.rows[0]).toMatchObject({ type: "page", id, deleted: true, title: "Plan", seq: 3 });
      expect((await c.closedWith()).code).toBe(1000);
    }
    expect(((await open(`/p/${id}/sync`, { protocols: ["austere-sync.1"] })) as Response).status).toBe(404);
    expect(((await open(`/api/pages/${id}/sync?cli=${CLI}`, { protocols: syncProtocols({ owner: token }) })) as Response).status).toBe(404);
    expect((await call(`/p/${id}`)).status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM page_objects").first("n")).toBe(0);
    expect((await env.PAGES.list({ prefix: "objects/" })).objects).toEqual([]);
  });

  it("refuses connections to a taken-down page with 410", async () => {
    const { token, id } = await published();
    await env.DB.prepare("UPDATE pages SET taken_down = 1 WHERE id = ?").bind(id).run();
    expect(((await open(`/p/${id}/sync`, { protocols: ["austere-sync.1"] })) as Response).status).toBe(410);
    expect(((await open(`/api/pages/${id}/sync?cli=${CLI}`, { protocols: syncProtocols({ owner: token }) })) as Response).status).toBe(410);
  });
});
