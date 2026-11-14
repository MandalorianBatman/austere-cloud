// WebSocket handshakes: check the credential and the page, then hand the socket to the page
// object. Credentials ride in Sec-WebSocket-Protocol (austere-axi/sync `readProtocols`).
import { readProtocols } from "austere-axi/sync";
import type { Credentials, ErrorCode, Role } from "austere-axi/sync";
import type { Env } from "./env";
import { ownerByToken } from "./auth";
import { ipHash } from "./limits";
import { versionAllowed } from "./runtime";
import { livePage } from "./serve";
import { HttpError, json } from "./util";

/** Who a socket belongs to, set by the Worker and read by the page object. */
export interface Identity {
  page: string;
  role: Role;
  /** Owner id, on owner sockets. */
  owner?: string;
  ipHash: string;
  /** A reviewer may connect without an invite (PAGE_ID_AS_CREDENTIAL). */
  pageIdAccess: boolean;
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
    return toPage(env, { page: id, role: "owner", owner: owner.id, ipHash: await ipHash(env, request), pageIdAccess: false });
  });
}

/** GET /p/:id/sync: the reviewer chrome, same origin only. */
export function reviewerSync(request: Request, env: Env, id: string): Promise<Response> {
  return guarded(async () => {
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== new URL(request.url).origin) throw new HttpError(403, "foreign origin");
    checkUpgrade(request);
    const page = await livePage(env, id);
    if (page === "gone") throw new HttpError(410, "this page was taken down");
    if (!page || page.published_at === null) throw new HttpError(404, "page not found");
    if (!versionAllowed(env, page.cli_version)) throw new HttpError(426, `this page needs republishing with austere-axi ${env.MIN_CLI_VERSION} or later`);
    return toPage(env, {
      page: id,
      role: "reviewer",
      ipHash: await ipHash(env, request),
      pageIdAccess: env.PAGE_ID_AS_CREDENTIAL === "true",
    });
  });
}
