import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { PresenceStatus, ReceivedFrame, ViewerBye, ViewerFocus, ViewerHello, ViewerStatus } from "austere-axi/sync";
import { describe, expect, it } from "vitest";
import { type Client, newOwner, ownerSocket, publish, reviewerSocket } from "./helpers";

const isHello = (f: ReceivedFrame): f is ViewerHello => f.t === "hello";
const isBye = (f: ReceivedFrame): f is ViewerBye => f.t === "bye";
const isPresence = (f: ReceivedFrame) => ["hello", "status", "focus", "bye"].includes(f.t);

/** A published page and its owner token. */
async function page(args = {}) {
  const token = await newOwner();
  const { id, ack } = await publish(token, { args });
  expect(ack.error).toBeUndefined();
  return { token, id };
}

function hello(c: Client, status: PresenceStatus = "viewing", name?: string) {
  c.sendRaw(name === undefined ? { v: 1, t: "hello", status } : { v: 1, t: "hello", status, name });
}

/** Joins and returns the roster the socket was sent, its own entry last. */
async function join(c: Client, name?: string, status: PresenceStatus = "viewing"): Promise<ViewerHello[]> {
  hello(c, status, name);
  const roster: ViewerHello[] = [];
  for (;;) {
    const f = await c.take(isHello);
    roster.push(f);
    if (f.self) return roster;
  }
}

/** Every frame the server sent these sockets so far is buffered: each one's pull answer comes after them. */
async function settle(...cs: Client[]) {
  for (const c of cs) await c.pull(1 << 30);
}

const stub = (id: string) => env.PAGE.get(env.PAGE.idFromName(id));

describe("roster", () => {
  it("a joiner gets everyone present, marked self, and the others get the joiner", async () => {
    const { token, id } = await page();
    const ana = await reviewerSocket(id);
    const [anaSelf] = await join(ana, "  Ana  ");
    expect(anaSelf).toMatchObject({ v: 1, t: "hello", self: true, status: "viewing", focus: null, viewer: { name: "Ana", role: "reviewer" } });
    expect(anaSelf.viewer.colour).toMatch(/^#[0-9a-f]{6}$/);

    const owner = await ownerSocket(token, id);
    const roster = await join(owner, "ignored", "away");
    expect(roster.map((h) => [h.viewer.name, h.viewer.role, h.self])).toEqual([
      ["Ana", "reviewer", false],
      ["Owner", "owner", true],
    ]);
    expect(roster[0].viewer).toEqual(anaSelf.viewer);
    const ownerId = roster[1].viewer.id;
    expect(await ana.take(isHello)).toMatchObject({ self: false, status: "away", viewer: { id: ownerId, name: "Owner", role: "owner" } });

    // An empty name is "Reviewer"; the same name keeps its colour on another socket.
    const anon = await reviewerSocket(id);
    expect((await join(anon, " ")).at(-1)!.viewer.name).toBe("Reviewer");
    const ana2 = await reviewerSocket(id);
    const again = (await join(ana2, "Ana")).at(-1)!.viewer;
    expect(again.colour).toBe(anaSelf.viewer.colour);
    expect(again.id).not.toBe(anaSelf.viewer.id);
  });

  it("bye and a closed socket remove the viewer for the others", async () => {
    const { id } = await page();
    const [a, b, c] = [await reviewerSocket(id), await reviewerSocket(id), await reviewerSocket(id)];
    await join(a, "A");
    const bId = (await join(b, "B")).at(-1)!.viewer.id;
    const cId = (await join(c, "C")).at(-1)!.viewer.id;

    await settle(b);
    b.frames.length = 0;
    b.sendRaw({ v: 1, t: "bye" });
    expect(await a.take(isBye)).toEqual({ v: 1, t: "bye", viewer: bId });
    expect(await c.take(isBye)).toEqual({ v: 1, t: "bye", viewer: bId });

    c.close();
    expect(await a.take(isBye)).toEqual({ v: 1, t: "bye", viewer: cId });

    // B left the roster: a newcomer does not see it, and B gets no more presence.
    const d = await reviewerSocket(id);
    expect((await join(d, "D")).map((h) => h.viewer.name)).toEqual(["A", "D"]);
    await settle(a, b);
    expect(b.frames.filter(isPresence)).toEqual([]);
  });

  it("a socket gets no presence until its own hello", async () => {
    const { id } = await page();
    const [a, quiet] = [await reviewerSocket(id), await reviewerSocket(id)];
    await join(a, "A");
    a.sendRaw({ v: 1, t: "focus", statement: "intro" });
    a.sendRaw({ v: 1, t: "status", status: "writing" });
    // Status and focus before hello are dropped.
    quiet.sendRaw({ v: 1, t: "focus", statement: "intro" });
    await settle(a, quiet);
    expect(quiet.frames.filter(isPresence)).toEqual([]);
    expect(a.frames.filter(isPresence)).toEqual([]);
  });
});

describe("status and focus", () => {
  it("focus goes to the others and is cleared with null; a joiner gets the current focus", async () => {
    const { id } = await page();
    const [a, b] = [await reviewerSocket(id), await reviewerSocket(id)];
    const aId = (await join(a, "A")).at(-1)!.viewer.id;
    await join(b, "B");
    await a.take(isHello);

    a.sendRaw({ v: 1, t: "focus", statement: "intro" });
    expect(await b.take((f): f is ViewerFocus => f.t === "focus")).toEqual({ v: 1, t: "focus", viewer: aId, statement: "intro" });
    const c = await reviewerSocket(id);
    expect((await join(c, "C")).find((h) => h.viewer.id === aId)!.focus).toBe("intro");

    a.sendRaw({ v: 1, t: "focus", statement: null });
    expect(await b.take((f): f is ViewerFocus => f.t === "focus")).toEqual({ v: 1, t: "focus", viewer: aId, statement: null });
    expect(await c.take((f): f is ViewerFocus => f.t === "focus")).toMatchObject({ viewer: aId, statement: null });
    await settle(a);
    expect(a.frames.filter((f) => f.t === "focus")).toEqual([]); // not echoed to the sender
  });

  it("status changes go to the others; a repeated status is only a heartbeat", async () => {
    const { id } = await page();
    const [a, b] = [await reviewerSocket(id), await reviewerSocket(id)];
    const aId = (await join(a, "A")).at(-1)!.viewer.id;
    await join(b, "B");
    for (const status of ["writing", "writing", "away", "viewing"] as const) a.sendRaw({ v: 1, t: "status", status });
    await settle(a, b);
    const seen = b.frames.filter((f): f is ViewerStatus => f.t === "status");
    expect(seen.map((f) => [f.viewer, f.status])).toEqual([
      [aId, "writing"],
      [aId, "away"],
      [aId, "viewing"],
    ]);
  });

  it("drops presence frames over 10 a second from one socket", async () => {
    const { id } = await page();
    const [a, b] = [await reviewerSocket(id), await reviewerSocket(id)];
    await join(a, "A");
    await join(b, "B");
    await a.take(isHello);
    for (let i = 0; i < 40; i++) a.sendRaw({ v: 1, t: "focus", statement: `s${i}` });
    await settle(a, b);
    // The burst may straddle one second boundary.
    expect(b.frames.filter((f) => f.t === "focus").length).toBeLessThanOrEqual(20);
  });
});

describe("expiry", () => {
  it("a viewer silent for 60 s gets a bye to the others; its next frame brings it back", async () => {
    const { id } = await page();
    const [a, b] = [await reviewerSocket(id), await reviewerSocket(id)];
    const aId = (await join(a, "A")).at(-1)!.viewer.id;
    await join(b, "B");
    await settle(a, b);
    b.frames.length = 0;

    // A's last frame was 61 s ago; B's is recent.
    await runInDurableObject(stub(id), (_obj, state) => {
      for (const ws of state.getWebSockets()) {
        const s = ws.deserializeAttachment();
        if (s.viewer?.id === aId) ws.serializeAttachment({ ...s, viewer: { ...s.viewer, last: Date.now() - 61_000 } });
      }
    });
    expect(await runDurableObjectAlarm(stub(id))).toBe(true);
    expect(await b.take(isBye)).toEqual({ v: 1, t: "bye", viewer: aId });

    // A newcomer does not see A; A's heartbeat announces it again, with the same id.
    const c = await reviewerSocket(id);
    expect((await join(c, "C")).map((h) => h.viewer.name)).toEqual(["B", "C"]);
    a.sendRaw({ v: 1, t: "status", status: "viewing" });
    expect(await b.take((f) => isHello(f) && f.viewer.id === aId)).toMatchObject({ self: false, viewer: { id: aId, name: "A" } });
    expect(await c.take(isHello)).toMatchObject({ viewer: { id: aId } });
  });
});

describe("storage", () => {
  it("presence is never in the op log, the rows or the row feed", async () => {
    const { token, id } = await page();
    const owner = await ownerSocket(token, id);
    const [first] = await owner.pull(0);
    const a = await reviewerSocket(id);
    await join(a, "A");
    await join(owner);
    a.sendRaw({ v: 1, t: "focus", statement: "intro" });
    a.sendRaw({ v: 1, t: "status", status: "writing" });
    a.sendRaw({ v: 1, t: "bye" });
    await settle(a, owner);

    expect(owner.frames.filter((f) => f.t === "changes")).toEqual([]);
    const [again] = await owner.pull(0);
    expect(again.rows.map((r) => r.type)).toEqual(["page"]);
    expect(again.cursor).toBe(first.cursor);
    const counts = await runInDurableObject(stub(id), (_obj, state) => ({
      ops: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ops").one().n,
      acks: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM acks").one().n,
    }));
    expect(counts).toEqual({ ops: 1, acks: 1 }); // the publish
  });
});

describe("--no-presence", () => {
  it("a page published with presence:false sends no presence", async () => {
    const { token, id } = await page({ presence: false });
    const [a, b] = [await reviewerSocket(id), await reviewerSocket(id)];
    const owner = await ownerSocket(token, id);
    for (const c of [a, b, owner]) hello(c, "viewing", "X");
    a.sendRaw({ v: 1, t: "focus", statement: "intro" });
    b.sendRaw({ v: 1, t: "status", status: "writing" });
    await settle(a, b, owner);
    for (const c of [a, b, owner]) expect(c.frames.filter(isPresence)).toEqual([]);
  });

  it("a republish that turns presence off sends bye for every viewer, then stops", async () => {
    const { token, id } = await page();
    const [a, b] = [await reviewerSocket(id), await reviewerSocket(id)];
    const aId = (await join(a, "A")).at(-1)!.viewer.id;
    const bId = (await join(b, "B")).at(-1)!.viewer.id;
    await settle(a, b);
    a.frames.length = 0;
    b.frames.length = 0;

    expect((await publish(token, { id, args: { presence: false } })).ack.error).toBeUndefined();
    for (const c of [a, b]) {
      const byes = [await c.take(isBye), await c.take(isBye)].map((f) => f.viewer).sort();
      expect(byes).toEqual([aId, bId].sort());
    }
    hello(a, "viewing", "A");
    b.sendRaw({ v: 1, t: "focus", statement: "intro" });
    await settle(a, b);
    for (const c of [a, b]) expect(c.frames.filter(isPresence)).toEqual([]);
  });
});
