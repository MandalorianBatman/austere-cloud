// WebSocket handshakes: check the credential and the page, then hand the socket to the page
// object. Credentials ride in Sec-WebSocket-Protocol (austere-axi/sync `readProtocols`).
import { readProtocols } from "austere-axi/sync";
import type { Credentials, ErrorCode, Role } from "austere-axi/sync";
import type { Env } from "./env";
import { ownerByToken } from "./auth";
import { ipHash } from "./limits";
import { versionAllowed } from "./runtime";
import { livePage } from "./serve";
import { HttpError, json, ownerCookie, sha256B64url } from "./util";

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
}

export const IDENTITY_HEADER = "x-austere-identity";

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
    const owner = creds.owner === undefined ? null : await ownerByToken(env, creds.owner);
    if (!owner) throw new HttpError(403, "missing or invalid owner token");
    const page = await livePage(env, id);
    if (page === "gone") throw new HttpError(410, "this page was taken down");
    // Another owner's page is indistinguishable from a missing one.
    if (!page || page.owner_id !== owner.id) throw new HttpError(404, "page not found");
    return toPage(env, { page: id, role: "owner", owner: owner.id, ipHash: await ipHash(env, request) });
  });
}

/** Reviewer routes are same-origin only: the chrome is the one client. */
function sameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) throw new HttpError(403, "foreign origin");
}

/** A published, unexpired page that is not taken down; throws 404 or 410. */
async function reviewablePage(env: Env, id: string): Promise<void> {
  const page = await livePage(env, id);
  if (page === "gone") throw new HttpError(410, "this page was taken down");
  if (!page || page.published_at === null) throw new HttpError(404, "page not found");
}

/**
 * GET /p/:id/sync: the reviewer chrome. The invite rides in Sec-WebSocket-Protocol; the owner's
 * sign-in session in the `austere_owner` cookie, which the page object prefers when it is live.
 */
export function reviewerSync(request: Request, env: Env, id: string): Promise<Response> {
  return guarded(async () => {
    sameOrigin(request);
    const creds = checkUpgrade(request);
    const page = await livePage(env, id);
    if (page === "gone") throw new HttpError(410, "this page was taken down");
    if (!page || page.published_at === null) throw new HttpError(404, "page not found");
    if (!versionAllowed(env, page.cli_version)) throw new HttpError(426, `this page needs republishing with austere-axi ${env.MIN_CLI_VERSION} or later`);
    const identity: Identity = { page: id, role: "reviewer", ipHash: await ipHash(env, request) };
    if (creds.invite !== undefined) identity.invite = await sha256B64url(creds.invite);
    const session = ownerCookie(request);
    if (session !== null) identity.session = await sha256B64url(session);
    return toPage(env, identity);
  });
}

export const INVITE_HEADER = "x-austere-invite";
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * POST /p/:id/asset-token: trades the owner's live sign-in session (the `austere_owner` cookie)
 * or else the invite (X-Austere-Invite) for the frame's asset token. A cookie that is not a live
 * session is ignored.
 */
export function assetToken(request: Request, env: Env, id: string): Promise<Response> {
  return guarded(async () => {
    sameOrigin(request);
    await reviewablePage(env, id);
    const stub = env.PAGE.get(env.PAGE.idFromName(id));
    const session = ownerCookie(request);
    if (session !== null) {
      const owner = await stub.ownerAssetToken(id, await sha256B64url(session));
      if (owner) return json(owner);
    }
    const invite = request.headers.get(INVITE_HEADER);
    if (invite !== null && !TOKEN_RE.test(invite)) throw new HttpError(403, "this invite is not valid");
    const answer = await stub.assetToken(id, invite === null ? undefined : await sha256B64url(invite));
    if ("status" in answer) throw new HttpError(answer.status, answer.message);
    return json(answer);
  });
}
