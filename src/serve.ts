// Public serving: the chrome shell (/p/:id), the sandboxed artifact (/p/:id/a/)
// and pack objects (/pk/<sha>.js).
import type { Env } from "./env";
import { JS_TYPE, objectKey } from "./objects";
import { PAGE_ID_RE, SHA_RE } from "./util";

const NOT_FOUND = () => new Response("not found", { status: 404, headers: { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" } });
const GONE = () => new Response("gone", { status: 410, headers: { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" } });

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface PageRow {
  id: string;
  owner_id: string;
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
    `SELECT p.id, p.owner_id, p.title, p.cli_version, p.html, p.published_at, p.expires_at,
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
    title: page.title,
    file: "",
    name: page.title,
    artifactUrl: `${base}/a/`,
    version: page.cli_version,
    viewer: { role: "reviewer", name: "" },
    hosted: { base, report: `${base}/report`, publishedAt: page.published_at },
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
<title>${escapeHtml(page.title)} · austere</title>
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

async function artifact(env: Env, id: string): Promise<Response> {
  const page = await publishedPage(env, id);
  if (page === "gone") return GONE();
  if (!page) return NOT_FOUND();
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

/** Handles GET /p/:id, /p/:id/a/ and /pk/<sha>.js; null for other paths. */
export async function handleServe(request: Request, env: Env, path: string): Promise<Response | null> {
  const page = /^\/p\/([^/]+)(\/a\/)?$/.exec(path);
  const pk = /^\/pk\/([^/]+)\.js$/.exec(path);
  if (!page && !pk) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (pk) return pack(env, pk[1]);
  return page![2] ? artifact(env, page![1]) : shell(env, page![1]);
}
