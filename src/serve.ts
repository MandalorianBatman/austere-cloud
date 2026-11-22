// Public serving: the chrome shell (/p/:id), the owner's sign-in (/p/:id?login=<code>), the
// sandboxed artifact (/p/:id/a/<assetToken>/) and pack objects (/pk/<sha>.js).
import type { Env } from "./env";
import { JS_TYPE, objectKey } from "./objects";
import { OWNER_SESSION_MS } from "./page";
import { signInUrl } from "./session";
import { accountsConfigured } from "./workos";
import { OWNER_COOKIE, PAGE_ID_RE, SHA_RE, sha256B64url } from "./util";

const PRIVATE = { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "referrer-policy": "no-referrer" };
const plain = (text: string, status: number) => new Response(text, { status, headers: PRIVATE });
const NOT_FOUND = () => plain("not found", 404);
const GONE = () => plain("gone", 410);
const FORBIDDEN = () => plain("forbidden", 403);
const ASSET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** What the shell calls every page: the real title is only in the asset-token answer, after access is granted. */
const SHELL_TITLE = "Shared page";
const LOGIN_FAILED = "This sign-in link was used already or has expired. Run `austere-axi publish login <file>` for a new one.";

export interface PageRow {
  id: string;
  owner_id: string;
  /** The account that holds the page's owner; null for an anonymous owner from before RLM-434 (blocked by migration 0003). */
  owner_user_id: string | null;
  title: string;
  cli_version: string;
  /** SHA-256 of the page HTML object; null until the first publish. */
  html: string | null;
  published_at: number | null;
}

/**
 * A page that is unexpired, `gone` when it was taken down (the page, its id or its owner),
 * or null when there is nothing at that id. The page may not be published yet.
 */
export async function livePage(env: Env, id: string): Promise<PageRow | "gone" | null> {
  if (!PAGE_ID_RE.test(id)) return null;
  const row = await env.DB.prepare(
    `SELECT p.id, p.owner_id, o.user_id AS owner_user_id, p.title, p.cli_version, p.html, p.published_at, p.expires_at,
            (p.taken_down OR o.blocked OR EXISTS (SELECT 1 FROM blocked_ids b WHERE b.page_id = p.id)) AS gone
     FROM pages p JOIN owners o ON o.id = p.owner_id WHERE p.id = ?`,
  )
    .bind(id)
    .first<PageRow & { expires_at: number; gone: number }>();
  if (!row) {
    const tomb = await env.DB.prepare("SELECT 1 AS ok FROM blocked_ids WHERE page_id = ?").bind(id).first();
    return tomb ? "gone" : null;
  }
  if (row.gone) return "gone";
  return row.expires_at > Date.now() ? row : null;
}

/** `livePage`, but only once published. */
async function publishedPage(env: Env, id: string): Promise<(PageRow & { html: string; published_at: number }) | "gone" | null> {
  const page = await livePage(env, id);
  if (page === "gone") return page;
  return page && page.html !== null && page.published_at !== null ? { ...page, html: page.html, published_at: page.published_at } : null;
}

function b64(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

async function shell(env: Env, id: string): Promise<Response> {
  const page = await publishedPage(env, id);
  if (page === "gone") return GONE();
  if (!page) return NOT_FOUND();
  const base = `/p/${page.id}`;
  const boot = {
    id: page.id,
    title: SHELL_TITLE,
    file: "",
    name: SHELL_TITLE,
    // A prefix: the chrome trades its invite at `${base}/asset-token` and loads `${artifactUrl}<assetToken>/`.
    artifactUrl: `${base}/a/`,
    version: page.cli_version,
    viewer: { role: "reviewer", name: "" },
    // `signIn`: where the chrome sends a viewer without access (accounts on); a top-level navigation, so the CSP needs nothing for it.
    hosted: { base, report: `${base}/report`, publishedAt: page.published_at, ...(accountsConfigured(env) ? { signIn: signInUrl(base) } : {}) },
  };
  const bootScript = `window.__AUSTERE__=${JSON.stringify(boot).replace(/</g, "\\u003c")}`;
  // `script-src 'self'` blocks inline scripts, so the boot script is allowed by hash.
  const hash = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bootScript)));
  const rt = `/rt/${page.cli_version}`;
  const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>${SHELL_TITLE} · austere</title>
<link rel="stylesheet" href="${rt}/chrome/chrome.css">
<script>${bootScript}</script>
<script src="${rt}/chrome/chrome.js" defer></script>
</head>
<body></body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'self' 'sha256-${hash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    },
  });
}

/**
 * `GET /p/:id?login=<code>`: trades a live owner sign-in code (`POST /api/pages/:id/login`) for the
 * page-scoped `austere_owner` session cookie, then redirects to the bare page URL so the code
 * leaves the address bar. A code works once.
 */
async function ownerSignIn(request: Request, env: Env, id: string, code: string): Promise<Response> {
  const page = await publishedPage(env, id);
  if (page === "gone") return GONE();
  if (!page) return NOT_FOUND();
  const session = ASSET_TOKEN_RE.test(code) ? await env.PAGE.get(env.PAGE.idFromName(id)).ownerSession(id, await sha256B64url(code)) : null;
  if (!session) return plain(LOGIN_FAILED, 403);
  const base = `/p/${page.id}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      ...PRIVATE,
      location: base,
      "set-cookie": `${OWNER_COOKIE}=${session.token}; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=${OWNER_SESSION_MS / 1000}${secure}`,
    },
  });
}

/** The artifact, for a live asset token of this page only. */
async function artifact(env: Env, id: string, token: string): Promise<Response> {
  const page = await publishedPage(env, id);
  if (page === "gone") return GONE();
  if (!page) return NOT_FOUND();
  if (!ASSET_TOKEN_RE.test(token)) return FORBIDDEN();
  if (!(await env.PAGE.get(env.PAGE.idFromName(id)).assetAllowed(await sha256B64url(token)))) return FORBIDDEN();
  const obj = await env.PAGES.get(objectKey(page.html));
  if (!obj) return NOT_FOUND();
  return new Response(obj.body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // `sandbox` without allow-same-origin gives the page an opaque origin even when opened directly.
      "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'none'",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    },
  });
}

/** A JS object some page's publish names as a pack. */
async function pack(env: Env, sha: string): Promise<Response> {
  if (!SHA_RE.test(sha)) return NOT_FOUND();
  const named = await env.DB.prepare("SELECT 1 AS ok FROM page_objects WHERE sha = ? LIMIT 1").bind(sha).first();
  if (!named) return NOT_FOUND();
  const obj = await env.PAGES.get(objectKey(sha));
  if (!obj || obj.httpMetadata?.contentType !== JS_TYPE) return NOT_FOUND();
  return new Response(obj.body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // Content-addressed: the bytes behind a sha never change.
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/** Handles GET /p/:id (and its `?login=` trade), /p/:id/a/<assetToken>/ and /pk/<sha>.js; null for other paths. */
export async function handleServe(request: Request, env: Env, path: string): Promise<Response | null> {
  const page = /^\/p\/([^/]+)(\/a\/(?:([^/]*)\/)?)?$/.exec(path);
  const pk = /^\/pk\/([^/]+)\.js$/.exec(path);
  if (!page && !pk) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (pk) return pack(env, pk[1]);
  if (page![2]) return artifact(env, page![1], page![3] ?? "");
  const login = new URL(request.url).searchParams.get("login");
  if (login !== null && request.method === "GET") return ownerSignIn(request, env, page![1], login);
  return shell(env, page![1]);
}
