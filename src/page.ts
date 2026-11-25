// The page object: one SQLite-backed Durable Object per page. It owns the page's private op
// log, the current rows (page, note, reply, acl) and the idempotency keys, applies mutations,
// and serves the change feed over hibernatable WebSockets. Frames are validated only by
// `parseClientFrame` from austere-axi/sync; the wire protocol is in austere-axi's
// docs/hosted-share-links.md, "Sync, access and presence".
import { DurableObject } from "cloudflare:workers";
import { MUTATION_ROLE, SUBPROTOCOL, SYNC_VERSION, grantId, parseClientFrame } from "austere-axi/sync";
import type {
  AckFrame,
  AclRow,
  ChangesFrame,
  ClientPresence,
  ErrorCode,
  ErrorFrame,
  HelloFrame,
  Mutation,
  MutationArgs,
  MutationKey,
  NoteRow,
  NoteState,
  PageRow,
  Role,
  Row,
  ServerFrame,
  ServerPresence,
  SyncError,
  ViewerBye,
  ViewerHello,
} from "austere-axi/sync";
import type { Env } from "./env";
import { accessHolds } from "./accounts";
import { RATE_LIMITS, RETENTION_MS, take } from "./limits";
import { HTML_TYPE, JS_TYPE, objectKey, scriptSrcError, setPageObjects } from "./objects";
import { EXPIRE_MS, FRAMES_PER_SECOND, colourFor, declaredName, viewerName, type ViewerState } from "./presence";
import { versionAllowed } from "./runtime";
import { IDENTITY_HEADER, OWNER_NAME, refusal, type AccountAccess, type Identity } from "./sync";
import { randomId, sha256B64url } from "./util";

/** Rows per `changes` frame of a pull. */
export const PULL_BATCH = 500;
const MAX_PACKS = 16;
const MAX_TITLE = 200;
/** How long an asset token (the sandboxed frame's credential) is valid. */
export const ASSET_TOKEN_MS = 10 * 60 * 1000;
/** How long an owner sign-in code (`POST /api/pages/:id/login`) can be traded at `/p/:id?login=<code>`. */
export const OWNER_LOGIN_MS = 60_000;
/** How long an owner session (the `austere_owner` cookie) lasts. */
export const OWNER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export { OWNER_NAME };

/** What each socket's attachment holds; it survives hibernation. */
interface SocketState {
  role: Role;
  owner?: string;
  ipHash: string;
  /** The socket finished a pull and gets live `changes` frames. */
  live: boolean;
  /** A reviewer let in by an invite: its name, token hash and expiry. Revoke, re-grant or expiry closes the socket. */
  invite?: { name: string; hash: string; expiresAt: number | null };
  /**
   * A reviewer socket let in by the owner's sign-in session (the `austere_owner` cookie): its
   * hash and expiry. Expiry closes it; it outranks any invite offered with it.
   */
  session?: { hash: string; expiresAt: number };
  /** A reviewer socket of a signed-in account: the owner, or a collaborator with a grant. Removing the grant closes it. */
  account?: AccountAccess;
  /** A reviewer let in only because the page was unlisted: a publish that clears `unlisted` closes it. */
  viaUnlisted?: boolean;
  /** Set by the socket's first `hello`, removed by `bye`, close, or a `publish` that turns presence off. */
  viewer?: ViewerState;
  /** Presence frames in the current second (epoch seconds), for FRAMES_PER_SECOND. */
  rate?: { second: number; count: number };
}

/** Who may read a page as a reviewer: an invite (by name), the open link, or nobody (`status`). */
export type ReviewerAccess = { invite: { name: string; hash: string; expiresAt: number | null } | null } | { status: 403 | 404; message: string };

/** A granted asset token. `title` reaches the chrome only here, never in the public shell. */
export type AssetToken = { token: string; expiresAt: number; name: string | null; title: string; owner: boolean };

/** The answer to `POST /p/:id/asset-token`. */
export type AssetTokenAnswer = AssetToken | { status: 403 | 404; message: string };

/** The answer to `POST /api/pages/:id/login`. */
export type OwnerLoginAnswer = { code: string; ttlMs: number } | { status: 404; message: string };

/** A mutation either fails, or is applied by `apply` inside the storage transaction. */
type Outcome = { error: SyncError } | { apply: () => Row[]; after?: () => Promise<void> };

const fail = (code: ErrorCode, message: string, retryAfter?: number): Outcome => ({
  error: retryAfter === undefined ? { code, message } : { code, message, retryAfter },
});

/** A row as written: the server sets `v` and `seq`. */
type RowInput = Row extends infer R ? (R extends Row ? Omit<R, "v" | "seq"> : never) : never;

/** Longest `project` name and `relPath` kept. */
const MAX_PROJECT = 200;
const MAX_REL_PATH = 1000;

/**
 * The sync v2 fields of a `publish`, which the parser keeps as unknown fields: a non-empty string, cut to length, else
 * null (not sent, or not usable). Both or neither: a path with no project would not say where the page belongs.
 */
function placement(args: object): { project: string | null; relPath: string | null } {
  const { project, relPath } = args as { project?: unknown; relPath?: unknown };
  const p = typeof project === "string" ? project.trim().slice(0, MAX_PROJECT) : "";
  const r = typeof relPath === "string" ? relPath.trim().slice(0, MAX_REL_PATH) : "";
  return p && r ? { project: p, relPath: r } : { project: null, relPath: null };
}

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
      -- Invites by name. Only the token's SHA-256 (base64url) is stored, and it never leaves the server.
      CREATE TABLE IF NOT EXISTS invites (
        name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0
      );
      -- Asset tokens (SHA-256, base64url) for the sandboxed frame. invite_hash is NULL for the open link;
      -- session_hash is set for tokens issued to the owner's sign-in session, account (JSON) for a signed-in
      -- account's (both added below for older objects).
      CREATE TABLE IF NOT EXISTS asset_tokens (token_hash TEXT PRIMARY KEY, invite_hash TEXT, expires_at INTEGER NOT NULL, session_hash TEXT, account TEXT);
      -- Single-use owner sign-in codes and the owner sessions they start. Only SHA-256 (base64url) is stored.
      CREATE TABLE IF NOT EXISTS owner_logins (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    `);
    // Objects created before owner sign-in (or accounts) lack these asset_tokens columns; their rows keep NULL.
    const cols = this.sql.exec<{ name: string }>("PRAGMA table_info(asset_tokens)").toArray();
    if (!cols.some((c) => c.name === "session_hash")) this.sql.exec("ALTER TABLE asset_tokens ADD COLUMN session_hash TEXT");
    if (!cols.some((c) => c.name === "account")) this.sql.exec("ALTER TABLE asset_tokens ADD COLUMN account TEXT");
  }

  /** The Worker's hand-off of an upgraded, already authenticated socket. */
  async fetch(request: Request): Promise<Response> {
    const identity = JSON.parse(request.headers.get(IDENTITY_HEADER) ?? "null") as Identity | null;
    if (!identity) return refusal(403, "no identity");
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('page', ?)", identity.page);
    const state: SocketState = { role: identity.role, owner: identity.owner, ipHash: identity.ipHash, live: false };
    if (identity.role === "reviewer") {
      // A signed-in account (owner or collaborator) wins, then the owner's live page sign-in, then any invite offered with them.
      const session = identity.session === undefined ? null : this.liveSession(identity.session);
      if (identity.account) {
        const page = this.pageRow();
        if (!page || page.deleted) return refusal(404, "page not found");
        state.account = identity.account;
      } else if (session) state.session = session;
      else {
        const access = this.reviewerAccess(identity.invite);
        if ("status" in access) return refusal(access.status, access.message);
        if (access.invite) state.invite = access.invite;
        else state.viaUnlisted = true;
      }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(state);
    if (state.session) await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": SUBPROTOCOL } });
  }

  /**
   * Reviewer access by invite token hash: a live invite, else the open link when the page is
   * unlisted, else 403. A wrong, revoked or expired token on an unlisted page is the open link.
   */
  private reviewerAccess(inviteHash: string | undefined): ReviewerAccess {
    const page = this.pageRow();
    if (!page || page.deleted) return { status: 404, message: "page not found" };
    const invite = inviteHash === undefined ? null : this.liveInvite(inviteHash);
    if (invite) return { invite };
    if (page.unlisted) return { invite: null };
    return { status: 403, message: inviteHash === undefined ? "this page needs an invite" : "this invite is not valid" };
  }

  private liveInvite(hash: string): { name: string; hash: string; expiresAt: number | null } | null {
    const row = this.sql
      .exec<{ name: string; expires_at: number | null }>(
        "SELECT name, expires_at FROM invites WHERE token_hash = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)",
        hash,
        Date.now(),
      )
      .toArray()[0];
    return row ? { name: row.name, hash, expiresAt: row.expires_at } : null;
  }

  /** The live owner session with this token hash, on a page that is not deleted. */
  private liveSession(hash: string): { hash: string; expiresAt: number } | null {
    const row = this.sql.exec<{ expires_at: number }>("SELECT expires_at FROM owner_sessions WHERE token_hash = ? AND expires_at > ?", hash, Date.now()).toArray()[0];
    if (!row) return null;
    const page = this.pageRow();
    return page && !page.deleted ? { hash, expiresAt: row.expires_at } : null;
  }

  /** RPC for `POST /api/pages/:id/login` (the Worker checked the owner): a single-use sign-in code; only its hash is kept. */
  async ownerLogin(page: string): Promise<OwnerLoginAnswer> {
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('page', ?)", page);
    const row = this.pageRow();
    if (!row || row.deleted) return { status: 404, message: "page not found" };
    const code = randomId(32);
    const hash = await sha256B64url(code);
    const now = Date.now();
    this.sql.exec("DELETE FROM owner_logins WHERE expires_at <= ?", now);
    this.sql.exec("INSERT INTO owner_logins (code_hash, expires_at) VALUES (?, ?)", hash, now + OWNER_LOGIN_MS);
    return { code, ttlMs: OWNER_LOGIN_MS };
  }

  /**
   * RPC for `GET /p/:id?login=<code>`: consumes a live sign-in code and starts an owner session;
   * null for a used, expired or unknown code. Only the session token's hash is kept.
   */
  async ownerSession(page: string, codeHash: string): Promise<{ token: string; expiresAt: number } | null> {
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('page', ?)", page);
    const row = this.pageRow();
    if (!row || row.deleted) return null;
    const token = randomId(32);
    const hash = await sha256B64url(token);
    // No await from here on: the code is consumed and the session written in one go, so a code works once.
    const now = Date.now();
    this.sql.exec("DELETE FROM owner_logins WHERE expires_at <= ?", now);
    if (!this.sql.exec("DELETE FROM owner_logins WHERE code_hash = ? RETURNING code_hash", codeHash).toArray().length) return null;
    const expiresAt = now + OWNER_SESSION_MS;
    this.sql.exec("DELETE FROM owner_sessions WHERE expires_at <= ?", now);
    this.sql.exec("INSERT INTO owner_sessions (token_hash, expires_at) VALUES (?, ?)", hash, expiresAt);
    return { token, expiresAt };
  }

  /** RPC for `POST /p/:id/asset-token` with the owner cookie: an owner asset token, or null when the session is not live. */
  async ownerAssetToken(page: string, sessionHash: string): Promise<AssetToken | null> {
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('page', ?)", page);
    const session = this.liveSession(sessionHash);
    return session ? this.issueAssetToken(null, session.hash) : null;
  }

  /** RPC for `POST /p/:id/asset-token`: trades reviewer access for a short-lived, page-scoped asset token. */
  async assetToken(page: string, inviteHash: string | undefined): Promise<AssetTokenAnswer> {
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('page', ?)", page);
    const access = this.reviewerAccess(inviteHash);
    if ("status" in access) return access;
    return this.issueAssetToken(access.invite, null);
  }

  /** RPC for `POST /p/:id/asset-token` with a signed-in account the Worker found to be the owner or a collaborator. */
  async accountAssetToken(page: string, account: AccountAccess): Promise<AssetToken> {
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('page', ?)", page);
    return this.issueAssetToken(null, null, account);
  }

  /** An asset token for an invite (null: the open link), an owner session, or an account. */
  private async issueAssetToken(invite: { name: string; hash: string } | null, sessionHash: string | null, account: AccountAccess | null = null): Promise<AssetToken> {
    const token = randomId(32);
    const hash = await sha256B64url(token);
    const now = Date.now();
    const expiresAt = now + ASSET_TOKEN_MS;
    this.sql.exec("DELETE FROM asset_tokens WHERE expires_at <= ?", now);
    this.sql.exec(
      "INSERT INTO asset_tokens (token_hash, invite_hash, session_hash, account, expires_at) VALUES (?, ?, ?, ?, ?)",
      hash,
      invite?.hash ?? null,
      sessionHash,
      account && JSON.stringify(account),
      expiresAt,
    );
    const title = this.pageRow()?.title ?? "";
    if (account) return { token, expiresAt, name: account.name, title, owner: account.owner };
    if (sessionHash !== null) return { token, expiresAt, name: OWNER_NAME, title, owner: true };
    return { token, expiresAt, name: invite?.name ?? null, title, owner: false };
  }

  /**
   * RPC for `GET /p/:id/a/<assetToken>/`: whether the token is unexpired and what it was issued
   * against still holds (the account's grant or ownership, the owner session or invite is live, or
   * the page is still unlisted).
   */
  async assetAllowed(tokenHash: string): Promise<boolean> {
    const row = this.sql
      .exec<{ invite_hash: string | null; session_hash: string | null; account: string | null }>(
        "SELECT invite_hash, session_hash, account FROM asset_tokens WHERE token_hash = ? AND expires_at > ?",
        tokenHash,
        Date.now(),
      )
      .toArray()[0];
    if (!row) return false;
    const page = this.pageRow();
    if (!page || page.deleted) return false;
    if (row.account !== null) return accessHolds(this.env, this.pageId(), JSON.parse(row.account) as AccountAccess);
    if (row.session_hash !== null) return this.liveSession(row.session_hash) !== null;
    return row.invite_hash === null ? page.unlisted : this.liveInvite(row.invite_hash) !== null;
  }

  /** RPC after a grant is removed: closes the sockets of every account that no longer has access. */
  async accessChanged(): Promise<void> {
    const page = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'page'").toArray()[0]?.value;
    if (!page) return;
    const checked = new Map<string, boolean>();
    for (const s of this.ctx.getWebSockets()) {
      const account = attachment(s).account;
      if (account && !checked.has(account.user)) checked.set(account.user, await accessHolds(this.env, page, account));
    }
    this.closeReviewers((s) => s.account !== undefined && checked.get(s.account.user) === false, "your access to this page was removed");
  }

  /** Sends `error` `forbidden` to every reviewer socket `pred` picks, and closes it (1008). */
  private closeReviewers(pred: (s: SocketState) => boolean, message: string): void {
    for (const s of this.ctx.getWebSockets()) {
      const state = attachment(s);
      if (state.role !== "reviewer" || !pred(state)) continue;
      this.send(s, errorFrame("forbidden", message));
      this.leave(s);
      s.close(1008, "forbidden");
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const expired = expiredAccess(attachment(ws), Date.now());
    if (expired) {
      this.send(ws, errorFrame("forbidden", expired));
      this.leave(ws);
      return ws.close(1008, "forbidden");
    }
    this.touch(ws);
    if (typeof message !== "string") return this.send(ws, errorFrame("invalid", "frames are JSON text"));
    const parsed = parseClientFrame(message);
    if (!parsed.ok) {
      if (parsed.error.code === "upgrade_required") {
        this.send(ws, errorFrame(parsed.error.code, parsed.error.message));
        this.leave(ws);
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
    return this.presence(ws, frame);
  }

  webSocketClose(ws: WebSocket): void {
    this.leave(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.leave(ws);
  }

  /** Runs `task` after every earlier mutation. An unexpected failure closes the socket (1011), so the client re-sends. */
  private serial(ws: WebSocket, task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((e) => {
      console.error(e);
      try {
        this.leave(ws);
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
        return this.grant(m.args);
      case "revoke":
        return this.revoke(m.args.name);
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
    // `project` and `rel_path` (sync v2) live here only, never in the `page` row reviewers get. A publish that sends
    // neither (an older CLI, or one that could not place the file) keeps what is stored: COALESCE.
    const placed = placement(args);
    await this.env.DB.prepare(
      "UPDATE pages SET title = ?, cli_version = ?, html = ?, auto = ?, bytes = ?, published_at = ?, expires_at = ?, project = COALESCE(?, project), rel_path = COALESCE(?, rel_path) WHERE id = ?",
    )
      .bind(page.title, page.cliVersion, page.html, page.auto ? 1 : 0, bytes, now, page.expiresAt, placed.project, placed.relPath, id)
      .run();
    await setPageObjects(this.env, id, [args.html, ...packs.map((p) => p.sha256)]);
    return {
      apply: () => [this.put(page)],
      after: async () => {
        if (!page.presence) await this.endPresence();
        // Sockets that came in through the open link lose access when it closes.
        if (!page.unlisted) this.closeReviewers((s) => s.viaUnlisted === true, "this page now needs an invite");
      },
    };
  }

  private async addNote(args: MutationArgs["addNote"], state: SocketState): Promise<Outcome> {
    const page = this.pageRow();
    if (!page || page.deleted) return fail("invalid", "the page is not published");
    const id = this.pageId();
    // Accounts and invited reviewers are counted each on their own, the signed-in owner as one, the open link per IP.
    const who = state.account ? `u:${state.account.user}` : state.session ? "owner" : state.invite ? `i:${state.invite.name}` : state.ipHash;
    const retry = await take(this.env, `note:${id}:${who}`, RATE_LIMITS.notesPerReviewerPerPage);
    if (retry !== null) return fail("rate_limited", "note limit reached for this page; try again later", retry);
    // An account goes by its name (the owner's: `Owner`), an invited reviewer by the invite, the page sign-in by `Owner`; the open link names itself.
    const author = assignedName(state) ?? declaredName(args.name);
    const note = { type: "note", id: randomId(12), author, items: args.items, at: Date.now(), state: page.auto ? "released" : "held" } as const;
    return {
      apply: () => [this.put(note)],
      after: async () => {
        await this.env.DB.prepare("UPDATE pages SET notes = notes + 1 WHERE id = ?").bind(id).run();
      },
    };
  }

  /**
   * Creates invite `name`, or gives it a new token and expiry. A new token closes the sockets
   * that came in with the old one; the same token only moves the expiry (and revives a revoked
   * invite). `grantedAt` is when the current token was granted: a re-grant of the same token keeps it,
   * so an owner peer can tell its own token's grant from a re-grant elsewhere.
   */
  private grant(args: MutationArgs["grant"]): Outcome {
    const now = Date.now();
    if (args.expiresAt !== null && args.expiresAt <= now) return fail("invalid", "grant.expiresAt is in the past");
    const taken = this.sql.exec<{ name: string }>("SELECT name FROM invites WHERE token_hash = ?", args.tokenHash).toArray()[0];
    if (taken && taken.name !== args.name) return fail("invalid", "grant.tokenHash belongs to another invite");
    const sameToken = taken?.name === args.name ? this.row<AclRow>("acl", args.name) : null;
    // `grant` names the token by a hash prefix, so owner peers can tell whose link is live; never the token or the full hash.
    const acl = {
      type: "acl",
      id: args.name,
      name: args.name,
      grantedAt: sameToken?.grantedAt ?? now,
      expiresAt: args.expiresAt,
      revoked: false,
      grant: grantId(args.tokenHash),
    } as const;
    return {
      apply: () => {
        this.sql.exec(
          `INSERT INTO invites (name, token_hash, expires_at, revoked) VALUES (?, ?, ?, 0)
           ON CONFLICT (name) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, revoked = 0`,
          args.name,
          args.tokenHash,
          args.expiresAt,
        );
        return [this.put(acl)];
      },
      after: async () => {
        this.closeReviewers((s) => s.invite?.name === args.name && s.invite.hash !== args.tokenHash, "this invite was replaced");
        for (const s of this.ctx.getWebSockets()) {
          const state = attachment(s);
          if (state.invite?.name !== args.name) continue;
          s.serializeAttachment({ ...state, invite: { ...state.invite, expiresAt: args.expiresAt } } satisfies SocketState);
        }
        await this.scheduleAlarm();
      },
    };
  }

  /** Revokes invite `name` and closes its sockets. An already revoked invite stays as it is. */
  private revoke(name: string): Outcome {
    const acl = this.row<AclRow>("acl", name);
    if (!acl) return fail("invalid", `invite ${name} does not exist`);
    if (acl.revoked) return { apply: () => [] };
    return {
      apply: () => {
        this.sql.exec("UPDATE invites SET revoked = 1 WHERE name = ?", name);
        return [this.put({ ...acl, revoked: true })];
      },
      after: async () => {
        this.closeReviewers((s) => s.invite?.name === name, "this invite was revoked");
        await this.scheduleAlarm();
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
    await this.env.DB.batch([this.env.DB.prepare("DELETE FROM pages WHERE id = ?").bind(id), this.env.DB.prepare("DELETE FROM grants WHERE page_id = ?").bind(id)]);
    this.send(ws, ackFrame(key));
    const page = this.pageRow();
    const sockets = this.ctx.getWebSockets();
    if (page) {
      const seq = this.counter() + 1;
      const frame: ChangesFrame = { v: SYNC_VERSION, t: "changes", rows: [{ ...page, deleted: true, seq }], cursor: seq };
      for (const s of sockets) this.send(s, frame);
    }
    for (const s of sockets) s.close(1000, "page deleted");
    await this.ctx.storage.deleteAlarm();
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

  // ── presence: socket attachments only, never the op log or the rows ──

  /** Presence runs while the published page has `presence: true`. */
  private presenceOn(): boolean {
    const page = this.pageRow();
    return !!page && page.presence && !page.deleted;
  }

  /** Every socket that is a viewer, with its viewer. */
  private viewers(): [WebSocket, ViewerState][] {
    const out: [WebSocket, ViewerState][] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const v = attachment(ws).viewer;
      if (v) out.push([ws, v]);
    }
    return out;
  }

  /** Sends a presence frame to every viewer but `from`. */
  private toOthers(from: WebSocket, frame: ServerPresence): void {
    for (const [ws] of this.viewers()) if (ws !== from) this.send(ws, frame);
  }

  private setViewer(ws: WebSocket, viewer: ViewerState | undefined): void {
    const { viewer: _, ...rest } = attachment(ws);
    ws.serializeAttachment(viewer ? { ...rest, viewer } : rest);
  }

  /** Any frame from a viewer is its heartbeat. A viewer that had gone silent is announced again. */
  private touch(ws: WebSocket): void {
    const v = attachment(ws).viewer;
    if (!v) return;
    const { gone, ...viewer } = v;
    viewer.last = Date.now();
    this.setViewer(ws, viewer);
    if (gone) {
      this.toOthers(ws, helloFrame(viewer, false));
      this.ctx.waitUntil(this.scheduleAlarm());
    }
  }

  private async presence(ws: WebSocket, frame: ClientPresence): Promise<void> {
    const state = attachment(ws);
    const second = Math.floor(Date.now() / 1000);
    const count = state.rate?.second === second ? state.rate.count + 1 : 1;
    ws.serializeAttachment({ ...state, rate: { second, count } } satisfies SocketState);
    if (count > FRAMES_PER_SECOND || !this.presenceOn()) return;
    if (frame.t === "hello") return this.join(ws, frame);
    if (frame.t === "bye") return this.leave(ws);
    const viewer = state.viewer;
    if (!viewer) return; // no presence before `hello`
    if (frame.t === "status") {
      if (frame.status === viewer.status) return; // a heartbeat
      this.setViewer(ws, { ...viewer, status: frame.status });
      return this.toOthers(ws, { v: SYNC_VERSION, t: "status", viewer: viewer.id, status: frame.status });
    }
    if (frame.statement === viewer.focus) return;
    this.setViewer(ws, { ...viewer, focus: frame.statement });
    this.toOthers(ws, { v: SYNC_VERSION, t: "focus", viewer: viewer.id, statement: frame.statement });
  }

  /** The socket's `hello`: the roster to it (the others, then its own entry, `self`), its entry to the others. */
  private async join(ws: WebSocket, hello: HelloFrame): Promise<void> {
    const state = attachment(ws);
    // On the open link a second hello may carry a name the reviewer has just given (the chrome's name prompt).
    const name = viewerName(state.role, assignedName(state), hello.name);
    // Another socket under the same name shares its colour; other names present keep theirs.
    const others = this.viewers().flatMap(([s, v]) => (s === ws ? [] : [v]));
    const colour =
      state.viewer?.name === name ? state.viewer.colour : (others.find((v) => v.name === name)?.colour ?? colourFor(name, new Set(others.map((v) => v.colour))));
    const viewer: ViewerState = state.viewer
      ? { ...state.viewer, name, colour, status: hello.status }
      : { id: randomId(8), name, colour, role: state.role, status: hello.status, focus: null, last: Date.now() };
    this.setViewer(ws, viewer);
    for (const [s, v] of this.viewers()) if (s !== ws && !v.gone) this.send(ws, helloFrame(v, false));
    this.send(ws, helloFrame(viewer, true));
    this.toOthers(ws, helloFrame(viewer, false));
    await this.scheduleAlarm();
  }

  /** The socket stops being a viewer (`bye`, close): the others get `bye`. */
  private leave(ws: WebSocket): void {
    const viewer = attachment(ws).viewer;
    if (!viewer) return;
    this.setViewer(ws, undefined);
    if (!viewer.gone) this.toOthers(ws, byeFrame(viewer.id));
  }

  /** A `publish` turned presence off: every viewer gets `bye` for every viewer, then nothing more. */
  private async endPresence(): Promise<void> {
    const viewers = this.viewers();
    for (const [ws] of viewers) this.setViewer(ws, undefined);
    for (const [ws] of viewers) for (const [, v] of viewers) this.send(ws, byeFrame(v.id));
    await this.scheduleAlarm();
  }

  /**
   * The object's one alarm serves two deadlines: the next invite or open owner-session expiry,
   * and the next viewer that would go silent (presence). Set to the earlier; deleted when there is neither.
   */
  private async scheduleAlarm(): Promise<void> {
    const now = Date.now();
    const invite = this.sql.exec<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM invites WHERE revoked = 0 AND expires_at > ?", now).one().at;
    let next = invite ?? Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const session = attachment(ws).session;
      if (session) next = Math.min(next, session.expiresAt);
    }
    for (const [, v] of this.viewers()) if (!v.gone) next = Math.min(next, v.last + EXPIRE_MS);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, now));
  }

  /**
   * Closes the reviewer sockets of invites and owner sessions that have expired; viewers silent
   * for EXPIRE_MS go (the others get `bye`); then re-arms for the next deadline.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.closeReviewers((s) => s.invite?.expiresAt != null && s.invite.expiresAt <= now, "this invite has expired");
    this.closeReviewers((s) => s.session !== undefined && s.session.expiresAt <= now, "this sign-in has expired");
    this.sql.exec("DELETE FROM asset_tokens WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM owner_logins WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM owner_sessions WHERE expires_at <= ?", now);
    for (const [ws, v] of this.viewers()) {
      if (v.gone || now - v.last < EXPIRE_MS) continue;
      this.setViewer(ws, { ...v, gone: true });
      this.toOthers(ws, byeFrame(v.id));
    }
    await this.scheduleAlarm();
  }
}

function attachment(ws: WebSocket): SocketState {
  return ws.deserializeAttachment() as SocketState;
}

/** Why a reviewer socket's credential has run out (its invite or the owner's session), or null. */
function expiredAccess(s: SocketState, now: number): string | null {
  if (s.invite?.expiresAt != null && s.invite.expiresAt <= now) return "this invite has expired";
  if (s.session && s.session.expiresAt <= now) return "this sign-in has expired";
  return null;
}

/** A reviewer socket's name when the server sets it: the account's, `Owner` for the owner's page sign-in, else the invite name. */
function assignedName(s: SocketState): string | undefined {
  return s.account?.name ?? (s.session ? OWNER_NAME : s.invite?.name);
}

function ackFrame(key: MutationKey, error?: SyncError): AckFrame {
  const frame: AckFrame = { v: SYNC_VERSION, t: "ack", clientId: key.clientId, n: key.n };
  if (error) frame.error = error;
  return frame;
}

function helloFrame(v: ViewerState, self: boolean): ViewerHello {
  return { v: SYNC_VERSION, t: "hello", viewer: { id: v.id, name: v.name, colour: v.colour, role: v.role }, status: v.status, focus: v.focus, self };
}

function byeFrame(viewer: string): ViewerBye {
  return { v: SYNC_VERSION, t: "bye", viewer };
}

function errorFrame(code: ErrorCode, message: string): ErrorFrame {
  return { v: SYNC_VERSION, t: "error", code, message };
}
