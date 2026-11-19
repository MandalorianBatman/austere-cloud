// WebSocket handshakes: check the credential and the page, then hand the socket to the page
// object. Credentials ride in Sec-WebSocket-Protocol (austere-axi/sync `readProtocols`); the CLI
// sends an account's access token as `Authorization: Bearer` instead, since a JWT is no subprotocol.
import { readProtocols } from "austere-axi/sync";
import type { Credentials, ErrorCode, Role } from "austere-axi/sync";
import type { Env } from "./env";
import { displayName, ensureUser, pageRole } from "./accounts";
import { bearer, ownerByCredential, ownsPage } from "./auth";
import { ipHash } from "./limits";
import { versionAllowed } from "./runtime";
import { livePage, type PageRow } from "./serve";
import { readSession, withSession, type Session } from "./session";
import { HttpError, json, ownerCookie, sha256B64url } from "./util";

/** A signed-in account on a reviewer socket or asset token: who it is and what it is on the page. */
export interface AccountAccess {
  user: string;
  email: string;
  /** The name shown for it: `Owner` for the owner, else the account's (src/accounts.ts `displayName`). */
  name: string;
  owner: boolean;
}

/** Who a socket belongs to, set by the Worker and read by the page object. */
export interface Identity {
  page: string;
  role: Role;
  /** Owner id, on owner sockets. */
  owner?: string;
  ipHash: string;
  /** The SHA-256 (base64url) of the invite token a reviewer offered; the token itself stays in the Worker. */
  invite?: string;
  /** The SHA-256 (base64url) of the owner's sign-in session token (the `austere_owner` cookie), on reviewer sockets. */
  session?: string;
  /** The signed-in account (the `austere_session` cookie) when it is the owner or has a grant, on reviewer sockets. */
  account?: AccountAccess;
}

export const IDENTITY_HEADER = "x-austere-identity";

/** The name the owner goes by on a hosted page (roster, note author, asset-token answer). */
export const OWNER_NAME = "Owner";

// 404 and 410 have no code of their own in the closed ErrorCode set; clients act on the status.
const CODES: Record<number, ErrorCode> = { 403: "forbidden", 404: "invalid", 410: "forbidden", 413: "too_large", 426: "upgrade_required", 429: "rate_limited" };

/** A failed handshake: `{ error: { code, message } }`. */
export function refusal(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code: CODES[status] ?? "invalid", message } }, status, headers);
}

async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof HttpError) return refusal(e.status, e.message, e.headers);
    throw e;
  }
}

function checkUpgrade(request: Request): Credentials {
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") throw new HttpError(426, "expected a WebSocket upgrade");
  const creds = readProtocols(request.headers.get("sec-websocket-protocol"));
  if (!creds.sync) throw new HttpError(426, "offer the austere-sync.1 subprotocol");
  return creds;
}

function toPage(env: Env, identity: Identity): Promise<Response> {
  const stub = env.PAGE.get(env.PAGE.idFromName(identity.page));
  return stub.fetch("https://page.internal/sync", { headers: { upgrade: "websocket", [IDENTITY_HEADER]: JSON.stringify(identity) } });
}

/** GET /api/pages/:id/sync?cli=<version>: the owner peer. The page need not be published yet. */
export function ownerSync(request: Request, env: Env, id: string): Promise<Response> {
  return guarded(async () => {
    const creds = checkUpgrade(request);
    const cli = new URL(request.url).searchParams.get("cli") ?? "";
    if (!versionAllowed(env, cli)) throw new HttpError(426, `austere-axi ${cli || "(no ?cli=)"} is too old; ${env.MIN_CLI_VERSION} or later is required`);
    const credential = bearer(request) ?? creds.owner;
    const owner = credential === undefined ? null : await ownerByCredential(env, credential).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 401) return null;
      throw e;
    });
    if (!owner) throw new HttpError(403, "missing or invalid owner token");
    const page = await livePage(env, id);
    if (page === "gone") throw new HttpError(410, "this page was taken down");
    // Another owner's page is indistinguishable from a missing one.
    if (!page || !ownsPage(owner, page)) throw new HttpError(404, "page not found");
    return toPage(env, { page: id, role: "owner", owner: owner.id, ipHash: await ipHash(env, request) });
  });
}

/** Reviewer routes are same-origin only: the chrome is the one client. */
function sameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) throw new HttpError(403, "foreign origin");
}

/** A published, unexpired page that is not taken down; throws 404 or 410. */
async function reviewablePage(env: Env, id: string): Promise<PageRow> {
  const page = await livePage(env, id);
  if (page === "gone") throw new HttpError(410, "this page was taken down");
  if (!page || page.published_at === null) throw new HttpError(404, "page not found");
  return page;
}

/** The session's account on the page, when it is the owner or a collaborator there; null otherwise. */
export async function accountAccess(env: Env, page: PageRow, session: Session): Promise<AccountAccess | null> {
  if (!session.userId) return null;
  const user = await ensureUser(env, session.userId);
  const role = await pageRole(env, page, user);
  if (!role) return null;
  const owner = role === "owner";
  return { user: user.id, email: user.email, name: owner ? OWNER_NAME : displayName(user), owner };
}

/**
 * GET /p/:id/sync: the reviewer chrome. The invite rides in Sec-WebSocket-Protocol; the owner's
 * page sign-in in the `austere_owner` cookie and the account in `austere_session`. The page object
 * prefers the account, then the page sign-in, then the invite.
 */
export async function reviewerSync(request: Request, env: Env, id: string): Promise<Response> {
  const session = await readSession(env, request);
  const res = await guarded(async () => {
    sameOrigin(request);
    const creds = checkUpgrade(request);
    const page = await reviewablePage(env, id);
    if (!versionAllowed(env, page.cli_version)) throw new HttpError(426, `this page needs republishing with austere-axi ${env.MIN_CLI_VERSION} or later`);
    const identity: Identity = { page: id, role: "reviewer", ipHash: await ipHash(env, request) };
    if (creds.invite !== undefined) identity.invite = await sha256B64url(creds.invite);
    const cookie = ownerCookie(request);
    if (cookie !== null) identity.session = await sha256B64url(cookie);
    const account = await accountAccess(env, page, session);
    if (account) identity.account = account;
    return toPage(env, identity);
  });
  return withSession(res, session);
}

export const INVITE_HEADER = "x-austere-invite";
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * POST /p/:id/asset-token: trades, in this order, the signed-in account (owner or collaborator),
 * the owner's page sign-in (the `austere_owner` cookie) or the invite (X-Austere-Invite) for the
 * frame's asset token. A cookie that is not a live session is ignored.
 */
export async function assetToken(request: Request, env: Env, id: string): Promise<Response> {
  const session = await readSession(env, request);
  const res = await guarded(async () => {
    sameOrigin(request);
    const page = await reviewablePage(env, id);
    const stub = env.PAGE.get(env.PAGE.idFromName(id));
    const account = await accountAccess(env, page, session);
    if (account) return json(await stub.accountAssetToken(id, account));
    const cookie = ownerCookie(request);
    if (cookie !== null) {
      const owner = await stub.ownerAssetToken(id, await sha256B64url(cookie));
      if (owner) return json(owner);
    }
    const invite = request.headers.get(INVITE_HEADER);
    if (invite !== null && !TOKEN_RE.test(invite)) throw new HttpError(403, "this invite is not valid");
    const answer = await stub.assetToken(id, invite === null ? undefined : await sha256B64url(invite));
    if ("status" in answer) throw new HttpError(answer.status, answer.message);
    return json(answer);
  });
  return withSession(res, session);
}
