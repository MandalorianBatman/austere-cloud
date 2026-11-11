// Owner routes: /api/owners and /api/pages. Owners authenticate with a bearer
// token; only its SHA-256 is stored.
import type { Env } from "./env";
import { HOUR, LIMITS, hit, ipHash } from "./limits";
import { parseUpload, type PackMeta, type Upload } from "./upload";
import { HttpError, PAGE_ID_RE, b64url, json, randomId, sha256Hex } from "./util";

export const RETENTION_MS = 30 * 24 * HOUR;

export const pageKey = (id: string) => `pages/${id}/index.html`;
export const packKey = (sha: string) => `packs/${sha}.js`;

interface Owner {
  id: string;
}

async function authenticate(env: Env, request: Request): Promise<Owner> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) throw new HttpError(401, "missing bearer token");
  const row = await env.DB.prepare("SELECT id, blocked FROM owners WHERE token_hash = ?")
    .bind(await sha256Hex(m[1]))
    .first<{ id: string; blocked: number }>();
  if (!row) throw new HttpError(401, "invalid token");
  if (row.blocked) throw new HttpError(403, "this owner is blocked");
  return { id: row.id };
}

const pageUrl = (request: Request, id: string) => `${new URL(request.url).origin}/p/${id}`;

async function createOwner(env: Env, request: Request): Promise<Response> {
  await hit(env, `owner:ip:${await ipHash(env, request)}`, LIMITS.newOwnersPerIp);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at) VALUES (?, ?, ?)")
    .bind(randomId(), await sha256Hex(token), Date.now())
    .run();
  return json({ token }, 201);
}

async function storeBlobs(env: Env, id: string, up: Upload): Promise<void> {
  await env.PAGES.put(pageKey(id), up.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  for (const p of up.packs) {
    // Content-addressed, so an existing blob is identical.
    if (!(await env.PAGES.head(packKey(p.sha256)))) {
      await env.PAGES.put(packKey(p.sha256), p.code, { httpMetadata: { contentType: "text/javascript; charset=utf-8" } });
    }
  }
}

const packsJson = (up: Upload) => JSON.stringify(up.packs.map(({ sha256, name, version }) => ({ sha256, name, version })));

async function publishLimits(env: Env, request: Request, owner: Owner): Promise<void> {
  await hit(env, `pub:owner:${owner.id}`, LIMITS.publishesPerOwner);
  await hit(env, `pub:ip:${await ipHash(env, request)}`, LIMITS.publishesPerIp);
}

async function createPage(env: Env, request: Request): Promise<Response> {
  const owner = await authenticate(env, request);
  await publishLimits(env, request, owner);
  const up = await parseUpload(request, env);
  const id = randomId();
  const now = Date.now();
  const expiresAt = now + RETENTION_MS;
  await storeBlobs(env, id, up);
  await env.DB.prepare(
    `INSERT INTO pages (id, owner_id, title, cli_version, auto, bytes, packs, created_at, published_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`,
  )
    .bind(id, owner.id, up.title, up.cliVersion, up.auto ? 1 : 0, up.bytes, packsJson(up), now, expiresAt)
    .run();
  return json({ id, url: pageUrl(request, id), expiresAt }, 201);
}

/** The owner's live page, or 404. Other owners' pages are indistinguishable from missing ones. */
async function ownPage(env: Env, owner: Owner, id: string): Promise<void> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM pages WHERE id = ? AND owner_id = ? AND taken_down = 0 AND expires_at > ?")
    .bind(id, owner.id, Date.now())
    .first();
  if (!row) throw new HttpError(404, "page not found");
}

async function updatePage(env: Env, request: Request, id: string): Promise<Response> {
  const owner = await authenticate(env, request);
  await ownPage(env, owner, id);
  await publishLimits(env, request, owner);
  const up = await parseUpload(request, env);
  const now = Date.now();
  const expiresAt = now + RETENTION_MS;
  await storeBlobs(env, id, up);
  await env.DB.prepare(
    "UPDATE pages SET title = ?, cli_version = ?, auto = ?, bytes = ?, packs = ?, published_at = ?, expires_at = ? WHERE id = ?",
  )
    .bind(up.title, up.cliVersion, up.auto ? 1 : 0, up.bytes, packsJson(up), now, expiresAt, id)
    .run();
  return json({ id, url: pageUrl(request, id), expiresAt });
}

async function deletePage(env: Env, request: Request, id: string): Promise<Response> {
  const owner = await authenticate(env, request);
  await ownPage(env, owner, id);
  const row = await env.DB.prepare("SELECT packs FROM pages WHERE id = ?").bind(id).first<{ packs: string }>();
  await env.PAGES.delete(pageKey(id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notes WHERE page_id = ?").bind(id),
    env.DB.prepare("DELETE FROM replies WHERE page_id = ?").bind(id),
    env.DB.prepare("DELETE FROM pages WHERE id = ?").bind(id),
  ]);
  // Pack blobs are shared by sha: drop one only when no remaining page lists it.
  for (const { sha256 } of JSON.parse(row?.packs ?? "[]") as PackMeta[]) {
    const used = await env.DB.prepare("SELECT 1 AS ok FROM pages, json_each(pages.packs) AS p WHERE json_extract(p.value, '$.sha256') = ? LIMIT 1")
      .bind(sha256)
      .first();
    if (!used) await env.PAGES.delete(packKey(sha256));
  }
  return new Response(null, { status: 204 });
}

async function listPages(env: Env, request: Request): Promise<Response> {
  const owner = await authenticate(env, request);
  const { results } = await env.DB.prepare(
    `SELECT id, title, expires_at, (SELECT COUNT(*) FROM notes WHERE notes.page_id = pages.id) AS notes
     FROM pages WHERE owner_id = ? AND taken_down = 0 AND expires_at > ? ORDER BY created_at DESC`,
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
  const one = /^\/api\/pages\/([^/]+)$/.exec(path);
  if (one) {
    const id = one[1];
    // A malformed id can't exist; skip straight to 404 (after auth, so tokens aren't probed anonymously).
    if (!PAGE_ID_RE.test(id)) {
      await authenticate(env, request);
      throw new HttpError(404, "page not found");
    }
    if (m === "PUT") return updatePage(env, request, id);
    if (m === "DELETE") return deletePage(env, request, id);
    return methodNotAllowed("PUT, DELETE");
  }
  return null;
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method not allowed" }, 405, { allow });
}
