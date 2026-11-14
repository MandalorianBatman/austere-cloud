// Owner routes under /api. Pages change through mutations on the page object's socket
// (/api/pages/:id/sync), not here.
import type { Env } from "./env";
import { authenticate } from "./auth";
import { RATE_LIMITS, UNPUBLISHED_MS, hit, ipHash } from "./limits";
import { putObject } from "./objects";
import { ownerSync } from "./sync";
import { HttpError, SHA_RE, b64url, json, randomId, sha256Hex } from "./util";

export const pageUrl = (request: Request, id: string) => `${new URL(request.url).origin}/p/${id}`;

async function createOwner(env: Env, request: Request): Promise<Response> {
  await hit(env, `owner:ip:${await ipHash(env, request)}`, RATE_LIMITS.newOwnersPerIp);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at) VALUES (?, ?, ?)")
    .bind(randomId(), await sha256Hex(token), Date.now())
    .run();
  return json({ token }, 201);
}

/** An empty page: reviewers get 404 until its first `publish` mutation. */
async function createPage(env: Env, request: Request): Promise<Response> {
  const owner = await authenticate(env, request);
  const id = randomId();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO pages (id, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, owner.id, now, now + UNPUBLISHED_MS)
    .run();
  return json({ id, url: pageUrl(request, id) }, 201);
}

async function listPages(env: Env, request: Request): Promise<Response> {
  const owner = await authenticate(env, request);
  const { results } = await env.DB.prepare(
    `SELECT id, title, expires_at, notes FROM pages
     WHERE owner_id = ? AND published_at IS NOT NULL AND taken_down = 0 AND expires_at > ? ORDER BY created_at DESC`,
  )
    .bind(owner.id, Date.now())
    .all<{ id: string; title: string; expires_at: number; notes: number }>();
  return json({
    pages: results.map((r) => ({ id: r.id, title: r.title, url: pageUrl(request, r.id), expiresAt: r.expires_at, notes: r.notes })),
  });
}

/** Handles /api/*; returns null for paths it doesn't own. */
export async function handleApi(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = request.method;
  if (path === "/api/owners") return m === "POST" ? createOwner(env, request) : methodNotAllowed("POST");
  if (path === "/api/pages") {
    if (m === "POST") return createPage(env, request);
    if (m === "GET") return listPages(env, request);
    return methodNotAllowed("GET, POST");
  }
  const obj = /^\/api\/objects\/([^/]+)$/.exec(path);
  if (obj) {
    if (m !== "PUT") return methodNotAllowed("PUT");
    await authenticate(env, request);
    if (!SHA_RE.test(obj[1])) throw new HttpError(400, "object name must be a lowercase hex sha256");
    return putObject(env, request, obj[1]);
  }
  const sync = /^\/api\/pages\/([^/]+)\/sync$/.exec(path);
  if (sync) return m === "GET" ? ownerSync(request, env, sync[1]) : methodNotAllowed("GET");
  return null;
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method not allowed" }, 405, { allow });
}
