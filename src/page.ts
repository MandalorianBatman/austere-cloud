// The page object: one SQLite-backed Durable Object per page. It owns the page's private op
// log, the current rows (page, note, reply, acl) and the idempotency keys, applies mutations,
// and serves the change feed over hibernatable WebSockets. Frames are validated only by
// `parseClientFrame` from austere-axi/sync; the wire protocol is in austere-axi's
// docs/hosted-share-links.md, "Sync, access and presence".
import { DurableObject } from "cloudflare:workers";
import { LIMITS, MUTATION_ROLE, SUBPROTOCOL, SYNC_VERSION, parseClientFrame } from "austere-axi/sync";
import type {
  AckFrame,
  ChangesFrame,
  ErrorCode,
  ErrorFrame,
  Mutation,
  MutationArgs,
  MutationKey,
  NoteRow,
  NoteState,
  PageRow,
  Role,
  Row,
  ServerFrame,
  SyncError,
} from "austere-axi/sync";
import type { Env } from "./env";
import { RATE_LIMITS, RETENTION_MS, take } from "./limits";
import { HTML_TYPE, JS_TYPE, objectKey, scriptSrcError, setPageObjects } from "./objects";
import { versionAllowed } from "./runtime";
import { IDENTITY_HEADER, refusal, type Identity } from "./sync";
import { randomId } from "./util";

/** Rows per `changes` frame of a pull. */
export const PULL_BATCH = 500;
const MAX_PACKS = 16;
const MAX_TITLE = 200;

/** What each socket's attachment holds; it survives hibernation. */
interface SocketState {
  role: Role;
  owner?: string;
  ipHash: string;
  /** The socket finished a pull and gets live `changes` frames. */
  live: boolean;
  /** A reviewer let in only because the page was unlisted: a publish that clears `unlisted` closes it. */
  viaUnlisted?: boolean;
}

/** A mutation either fails, or is applied by `apply` inside the storage transaction. */
type Outcome = { error: SyncError } | { apply: () => Row[]; after?: () => Promise<void> };

const fail = (code: ErrorCode, message: string, retryAfter?: number): Outcome => ({
  error: retryAfter === undefined ? { code, message } : { code, message, retryAfter },
});

/** A row as written: the server sets `v` and `seq`. */
type RowInput = Row extends infer R ? (R extends Row ? Omit<R, "v" | "seq"> : never) : never;

export class PageObject extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Mutations run one at a time, including their awaits on D1 and R2. */
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.init();
  }

  private init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- The private op log: every applied mutation, as sent. Never leaves the server.
      CREATE TABLE IF NOT EXISTS ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, client_id TEXT NOT NULL, n INTEGER NOT NULL,
        name TEXT NOT NULL, role TEXT NOT NULL, args TEXT NOT NULL, ip_hash TEXT NOT NULL
      );
      -- Current state of each row; seq is the page's counter at its last change.
      CREATE TABLE IF NOT EXISTS rows (type TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY (type, id));
      -- The answer given to each (clientId, n); error is NULL when it was applied.
      CREATE TABLE IF NOT EXISTS acks (client_id TEXT NOT NULL, n INTEGER NOT NULL, error TEXT, PRIMARY KEY (client_id, n));
    `);
  }

  /** The Worker's hand-off of an upgraded, already authenticated socket. */
  async fetch(request: Request): Promise<Response> {
    const identity = JSON.parse(request.headers.get(IDENTITY_HEADER) ?? "null") as Identity | null;
    if (!identity) return refusal(403, "no identity");
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('page', ?)", identity.page);
    if (identity.role === "reviewer") {
      const page = this.pageRow();
      if (!page || page.deleted) return refusal(404, "page not found");
      if (!identity.pageIdAccess && !page.unlisted) return refusal(403, "this page needs an invite");
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const state: SocketState = {
      role: identity.role,
      owner: identity.owner,
      ipHash: identity.ipHash,
      live: false,
      viaUnlisted: identity.role === "reviewer" && !identity.pageIdAccess,
    };
    server.serializeAttachment(state);
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": SUBPROTOCOL } });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return this.send(ws, errorFrame("invalid", "frames are JSON text"));
    const parsed = parseClientFrame(message);
    if (!parsed.ok) {
      if (parsed.error.code === "upgrade_required") {
        this.send(ws, errorFrame(parsed.error.code, parsed.error.message));
        return ws.close(1008, "upgrade required");
      }
      // A rejected mutation whose key is readable gets an ack, so its sender can drop it.
      const key = parsed.key;
      if (key) {
        return this.serial(ws, async () => {
          const stored = this.storedAck(key);
          return stored ? this.send(ws, stored) : this.answer(ws, key, null, { error: parsed.error });
        });
      }
      return this.send(ws, errorFrame(parsed.error.code, parsed.error.message));
    }
    const frame = parsed.value;
    if (frame.t === "pull") return this.pull(ws, frame.after);
    if (frame.t === "mutation") return this.serial(ws, () => this.mutate(ws, frame));
    // Presence frames (hello/status/focus/bye) arrive with RLM-315; until then they are dropped.
  }

  /** Runs `task` after every earlier mutation. An unexpected failure closes the socket (1011), so the client re-sends. */
  private serial(ws: WebSocket, task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((e) => {
      console.error(e);
      try {
        ws.close(1011, "internal error");
      } catch {
        // already closing
      }
    });
    this.queue = run;
    return run;
  }

  private async mutate(ws: WebSocket, m: Mutation): Promise<void> {
    const key = { clientId: m.clientId, n: m.n };
    const stored = this.storedAck(key);
    if (stored) return this.send(ws, stored);
    const state = attachment(ws);
    if (MUTATION_ROLE[m.name] !== state.role) {
      return this.answer(ws, key, null, fail("forbidden", `${m.name} is sent by the ${MUTATION_ROLE[m.name]}`));
    }
    if (m.name === "delete") return this.deletePage(ws, key);
    return this.answer(ws, key, { m, state }, await this.run(m, state));
  }

  private run(m: Exclude<Mutation, Mutation<"delete">>, state: SocketState): Promise<Outcome> | Outcome {
    switch (m.name) {
      case "publish":
        return this.publish(m.args, state);
      case "addNote":
        return this.addNote(m.args, state);
      case "releaseNote":
        return this.settleNote(m.args.note, "released");
      case "discardNote":
        return this.settleNote(m.args.note, "discarded");
      case "addReply":
        return { apply: () => [this.put({ type: "reply", id: randomId(12), text: m.args.text, at: Date.now() })] };
      case "grant":
      case "revoke":
        return fail("invalid", `${m.name}: invites are not available on this server yet`);
    }
  }

  /**
   * Stores and sends the answer to mutation `key`. An applied mutation commits its rows, its op
   * and its ack in one transaction, then goes out live. `rate_limited` is not stored.
   */
  private async answer(ws: WebSocket, key: MutationKey, op: { m: Mutation; state: SocketState } | null, outcome: Outcome): Promise<void> {
    if ("error" in outcome) {
      if (outcome.error.code !== "rate_limited") {
        this.sql.exec("INSERT INTO acks (client_id, n, error) VALUES (?, ?, ?)", key.clientId, key.n, JSON.stringify(outcome.error));
      }
      return this.send(ws, ackFrame(key, outcome.error));
    }
    const rows = this.ctx.storage.transactionSync(() => {
      const rows = outcome.apply();
      if (op) {
        this.sql.exec(
          "INSERT INTO ops (at, client_id, n, name, role, args, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
          Date.now(),
          key.clientId,
          key.n,
          op.m.name,
          op.state.role,
          JSON.stringify(op.m.args),
          op.state.ipHash,
        );
      }
      this.sql.exec("INSERT INTO acks (client_id, n, error) VALUES (?, ?, NULL)", key.clientId, key.n);
      return rows;
    });
    this.send(ws, ackFrame(key));
    this.broadcast(rows);
    await outcome.after?.();
  }

  private storedAck(key: MutationKey): AckFrame | null {
    const row = this.sql.exec<{ error: string | null }>("SELECT error FROM acks WHERE client_id = ? AND n = ?", key.clientId, key.n).toArray()[0];
    if (!row) return null;
    return ackFrame(key, row.error === null ? undefined : (JSON.parse(row.error) as SyncError));
  }

  private async publish(args: MutationArgs["publish"], state: SocketState): Promise<Outcome> {
    if (!versionAllowed(this.env, args.cliVersion)) {
      return fail("invalid", `cliVersion must be a release version of at least ${this.env.MIN_CLI_VERSION}; upgrade austere-axi`);
    }
    if (args.packs.length > MAX_PACKS) return fail("invalid", `a page may name at most ${MAX_PACKS} packs`);
    const html = await this.env.PAGES.get(objectKey(args.html));
    if (!html) return fail("invalid", `page html ${args.html} was not uploaded`);
    if (html.httpMetadata?.contentType !== HTML_TYPE) {
      await html.body.cancel();
      return fail("invalid", `object ${args.html} is not text/html`);
    }
    const text = await html.text();
    let bytes = html.size;
    for (const p of args.packs) {
      const head = await this.env.PAGES.head(objectKey(p.sha256));
      if (!head) return fail("invalid", `pack ${p.name}@${p.version} (${p.sha256}) was not uploaded`);
      if (head.httpMetadata?.contentType !== JS_TYPE) return fail("invalid", `object ${p.sha256} is not text/javascript`);
      bytes += head.size;
    }
    const packs = args.packs.map(({ sha256, name, version }) => ({ sha256, name, version }));
    const srcError = scriptSrcError(text, args.cliVersion, new Set(packs.map((p) => p.sha256)));
    if (srcError) return fail("invalid", srcError);

    const retry =
      (await take(this.env, `pub:owner:${state.owner}`, RATE_LIMITS.publishesPerOwner)) ??
      (await take(this.env, `pub:ip:${state.ipHash}`, RATE_LIMITS.publishesPerIp));
    if (retry !== null) return fail("rate_limited", "publish limit reached; try again later", retry);

    const id = this.pageId();
    const now = Date.now();
    const page = {
      type: "page",
      id,
      title: args.title.trim().slice(0, MAX_TITLE) || "Untitled",
      cliVersion: args.cliVersion,
      html: args.html,
      packs,
      auto: args.auto,
      unlisted: args.unlisted,
      presence: args.presence,
      publishedAt: now,
      expiresAt: now + RETENTION_MS,
      deleted: false,
    } as const;
    // The D1 index first: should the commit below not happen, the client re-sends and this repeats.
    await this.env.DB.prepare("UPDATE pages SET title = ?, cli_version = ?, html = ?, auto = ?, bytes = ?, published_at = ?, expires_at = ? WHERE id = ?")
      .bind(page.title, page.cliVersion, page.html, page.auto ? 1 : 0, bytes, now, page.expiresAt, id)
      .run();
    await setPageObjects(this.env, id, [args.html, ...packs.map((p) => p.sha256)]);
    return {
      apply: () => [this.put(page)],
      // Sockets that came in through the open link lose access when it closes.
      after: async () => {
        if (page.unlisted) return;
        for (const s of this.ctx.getWebSockets()) {
          if (!attachment(s).viaUnlisted) continue;
          this.send(s, errorFrame("forbidden", "this page now needs an invite"));
          s.close(1008, "forbidden");
        }
      },
    };
  }

  private async addNote(args: MutationArgs["addNote"], state: SocketState): Promise<Outcome> {
    const page = this.pageRow();
    if (!page || page.deleted) return fail("invalid", "the page is not published");
    const id = this.pageId();
    const retry = await take(this.env, `note:${id}:${state.ipHash}`, RATE_LIMITS.notesPerIpPerPage);
    if (retry !== null) return fail("rate_limited", "note limit reached for this page; try again later", retry);
    const author = [...(args.name ?? "").trim()].slice(0, LIMITS.nameChars).join("") || "Reviewer";
    const note = { type: "note", id: randomId(12), author, items: args.items, at: Date.now(), state: page.auto ? "released" : "held" } as const;
    return {
      apply: () => [this.put(note)],
      after: async () => {
        await this.env.DB.prepare("UPDATE pages SET notes = notes + 1 WHERE id = ?").bind(id).run();
      },
    };
  }

  /** `held` → `to`. A note that was already released or discarded stays as it is. */
  private settleNote(noteId: string, to: Exclude<NoteState, "held">): Outcome {
    const note = this.row<NoteRow>("note", noteId);
    if (!note) return fail("invalid", `note ${noteId} does not exist`);
    if (note.state !== "held") return { apply: () => [] };
    return { apply: () => [this.put({ ...note, state: to })] };
  }

  /**
   * Sends the deleted page row to every socket, closes them (1000), and deletes the page's
   * storage, D1 row and object references. Nothing is stored: later handshakes get 404.
   */
  private async deletePage(ws: WebSocket, key: MutationKey): Promise<void> {
    const id = this.pageId();
    await setPageObjects(this.env, id, []);
    await this.env.DB.prepare("DELETE FROM pages WHERE id = ?").bind(id).run();
    this.send(ws, ackFrame(key));
    const page = this.pageRow();
    const sockets = this.ctx.getWebSockets();
    if (page) {
      const seq = this.counter() + 1;
      const frame: ChangesFrame = { v: SYNC_VERSION, t: "changes", rows: [{ ...page, deleted: true, seq }], cursor: seq };
      for (const s of sockets) this.send(s, frame);
    }
    for (const s of sockets) s.close(1000, "page deleted");
    await this.ctx.storage.deleteAll();
    this.init();
  }

  /** Every row the socket may see with `seq` after `after`, in frames of PULL_BATCH; then live frames. */
  private pull(ws: WebSocket, after: number): void {
    const state = attachment(ws);
    const counter = this.counter();
    const reset = after > counter;
    let from = reset ? 0 : after;
    const owner = state.role === "owner" ? 1 : 0;
    for (let first = true; ; first = false) {
      const batch = this.sql
        .exec<{ seq: number; body: string }>("SELECT seq, body FROM rows WHERE seq > ? AND (? OR type <> 'acl') ORDER BY seq LIMIT ?", from, owner, PULL_BATCH + 1)
        .toArray();
      const more = batch.length > PULL_BATCH;
      const rows = batch.slice(0, PULL_BATCH);
      const cursor = more ? rows[rows.length - 1].seq : counter;
      const frame: ChangesFrame = { v: SYNC_VERSION, t: "changes", rows: rows.map((r) => JSON.parse(r.body) as Row), cursor };
      if (more) frame.more = true;
      if (first && reset) frame.reset = true;
      this.send(ws, frame);
      if (!more) break;
      from = cursor;
    }
    if (!state.live) ws.serializeAttachment({ ...state, live: true } satisfies SocketState);
  }

  /** Sends changed rows to every live socket, each filtered to what it may see, at the page's counter. */
  private broadcast(rows: Row[]): void {
    if (!rows.length) return;
    const cursor = this.counter();
    for (const ws of this.ctx.getWebSockets()) {
      const state = attachment(ws);
      if (!state.live) continue;
      // acl rows are the owner's only.
      const visible = state.role === "owner" ? rows : rows.filter((r) => r.type !== "acl");
      this.send(ws, { v: SYNC_VERSION, t: "changes", rows: visible, cursor });
    }
  }

  /** Writes a row's new state at the next `seq`. Call inside the transaction. */
  private put(row: RowInput): Row {
    const full = { ...row, v: SYNC_VERSION, seq: this.counter() + 1 } as Row;
    this.sql.exec(
      "INSERT INTO rows (type, id, seq, body) VALUES (?, ?, ?, ?) ON CONFLICT (type, id) DO UPDATE SET seq = excluded.seq, body = excluded.body",
      full.type,
      full.id,
      full.seq,
      JSON.stringify(full),
    );
    return full;
  }

  private row<R extends Row>(type: R["type"], id: string): R | null {
    const r = this.sql.exec<{ body: string }>("SELECT body FROM rows WHERE type = ? AND id = ?", type, id).toArray()[0];
    return r ? (JSON.parse(r.body) as R) : null;
  }

  private pageRow(): PageRow | null {
    return this.row<PageRow>("page", this.pageId());
  }

  private pageId(): string {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'page'").one().value;
  }

  /** The page's counter: rows are only ever replaced at a higher seq, so it is the highest one. */
  private counter(): number {
    return this.sql.exec<{ c: number }>("SELECT COALESCE(MAX(seq), 0) AS c FROM rows").one().c;
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The socket is closing; the client pulls again after it reconnects.
    }
  }
}

function attachment(ws: WebSocket): SocketState {
  return ws.deserializeAttachment() as SocketState;
}

function ackFrame(key: MutationKey, error?: SyncError): AckFrame {
  const frame: AckFrame = { v: SYNC_VERSION, t: "ack", clientId: key.clientId, n: key.n };
  if (error) frame.error = error;
  return frame;
}

function errorFrame(code: ErrorCode, message: string): ErrorFrame {
  return { v: SYNC_VERSION, t: "error", code, message };
}
