// Owner routes under /api. Pages change through mutations on the page object's socket
// (/api/pages/:id/sync), not here. Every route takes either owner credential (src/auth.ts).
import type { Env } from "./env";
import { addGrant, claimOwner, listGrants, normalEmail, removeGrant } from "./accounts";
import { authenticate, ownsPage, type Owner } from "./auth";
import { RATE_LIMITS, UNPUBLISHED_MS, hit, ipHash } from "./limits";
import { objectKey, putObject } from "./objects";
import { livePage, type PageRow } from "./serve";
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

export interface OwnedPage {
  id: string;
  title: string;
  expires_at: number;
  notes: number;
}

/** The owner's published, unexpired pages, newest first: an account's are those of every owner it holds. */
export async function ownedPages(env: Env, owner: Owner): Promise<OwnedPage[]> {
  const whose = owner.user ? "owner_id IN (SELECT id FROM owners WHERE user_id = ?1)" : "owner_id = ?1";
  const { results } = await env.DB.prepare(
    `SELECT id, title, expires_at, notes FROM pages
     WHERE ${whose} AND published_at IS NOT NULL AND taken_down = 0 AND expires_at > ?2 ORDER BY created_at DESC`,
  )
    .bind(owner.user?.id ?? owner.id, Date.now())
    .all<OwnedPage>();
  return results;
}

async function listPages(env: Env, request: Request): Promise<Response> {
  const rows = await ownedPages(env, await authenticate(env, request));
  return json({
    pages: rows.map((r) => ({ id: r.id, title: r.title, url: pageUrl(request, r.id), expiresAt: r.expires_at, notes: r.notes })),
  });
}

/** The owner's page `id`, published unless `unpublished`. Another owner's page is indistinguishable from a missing one. */
export async function ownedPage(env: Env, owner: Owner, id: string, { unpublished = false } = {}): Promise<PageRow> {
  const page = await livePage(env, id);
  if (page === "gone") throw new HttpError(410, "this page was taken down");
  if (!page || !ownsPage(owner, page) || (!unpublished && page.published_at === null)) throw new HttpError(404, "page not found");
  return page;
}

/**
 * A single-use code that signs the owner in on their own page in the browser
 * (`/p/:id?login=<code>`, see serve.ts).
 */
async function ownerLogin(env: Env, request: Request, id: string): Promise<Response> {
  await ownedPage(env, await authenticate(env, request), id);
  const answer = await env.PAGE.get(env.PAGE.idFromName(id)).ownerLogin(id);
  if ("status" in answer) throw new HttpError(answer.status, answer.message);
  return json(answer);
}

/** GET /api/me: who the credential is; `user` is null for an anonymous owner token. */
async function me(env: Env, request: Request): Promise<Response> {
  const owner = await authenticate(env, request);
  const user = owner.user && { id: owner.user.id, email: owner.user.email, name: owner.user.name };
  return json({ user, pages: (await ownedPages(env, owner)).length });
}

/** POST /api/owners/claim `{ token }` with an access token: the account takes over an anonymous owner and its pages. */
async function claim(env: Env, request: Request): Promise<Response> {
  const owner = await authenticate(env, request);
  if (!owner.user) throw new HttpError(403, "claiming an owner token needs an account access token");
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof body?.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw new HttpError(400, "token must be an owner token");
  return json(await claimOwner(env, owner.user.id, body.token));
}

/** GET /api/pages/:id/html: the page HTML as last published, for `clone`. */
async function pageHtml(env: Env, request: Request, id: string): Promise<Response> {
  const page = await ownedPage(env, await authenticate(env, request), id);
  const obj = await env.PAGES.get(objectKey(page.html!));
  if (!obj) throw new HttpError(404, "page html not found");
  return new Response(obj.body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** /api/pages/:id/grants[/:email]: the accounts besides the owner that may open the page. */
async function grants(env: Env, request: Request, id: string, email: string | undefined): Promise<Response> {
  const m = request.method;
  if (email === undefined && m !== "GET" && m !== "POST") return methodNotAllowed("GET, POST");
  if (email !== undefined && m !== "DELETE") return methodNotAllowed("DELETE");
  await ownedPage(env, await authenticate(env, request), id, { unpublished: true });
  if (m === "GET") return json({ grants: await listGrants(env, id) });
  if (m === "POST") {
    const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
    const e = normalEmail(body?.email);
    const created = await addGrant(env, id, e);
    return json({ email: e, role: "collaborator", created }, created ? 201 : 200);
  }
  let raw: string;
  try {
    raw = decodeURIComponent(email!);
  } catch {
    throw new HttpError(400, "email must be an email address");
  }
  if (!(await removeGrant(env, id, normalEmail(raw)))) throw new HttpError(404, "no such grant");
  return new Response(null, { status: 204 });
}

/** Handles /api/*; returns null for paths it doesn't own. */
export async function handleApi(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = request.method;
  if (path === "/api/owners") return m === "POST" ? createOwner(env, request) : methodNotAllowed("POST");
  if (path === "/api/owners/claim") return m === "POST" ? claim(env, request) : methodNotAllowed("POST");
  if (path === "/api/me") return m === "GET" ? me(env, request) : methodNotAllowed("GET");
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
  const login = /^\/api\/pages\/([^/]+)\/login$/.exec(path);
  if (login) return m === "POST" ? ownerLogin(env, request, login[1]) : methodNotAllowed("POST");
  const html = /^\/api\/pages\/([^/]+)\/html$/.exec(path);
  if (html) return m === "GET" ? pageHtml(env, request, html[1]) : methodNotAllowed("GET");
  const grant = /^\/api\/pages\/([^/]+)\/grants(?:\/([^/]+))?$/.exec(path);
  if (grant) return grants(env, request, grant[1], grant[2]);
  return null;
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method not allowed" }, 405, { allow });
}
