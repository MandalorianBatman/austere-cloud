// Public serving: the chrome shell (/p/:id), the sandboxed artifact (/p/:id/a/)
// and uploaded pack blobs (/pk/<sha>.js).
import type { Env } from "./env";
import { packKey, pageKey } from "./api";
import { PAGE_ID_RE, SHA_RE } from "./util";

const NOT_FOUND = () => new Response("not found", { status: 404, headers: { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" } });

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface PageRow {
  id: string;
  title: string;
  cli_version: string;
  published_at: number;
}

/** A page that is published, unexpired and not taken down. */
async function livePage(env: Env, id: string): Promise<PageRow | null> {
  if (!PAGE_ID_RE.test(id)) return null;
  return env.DB.prepare(
    `SELECT id, title, cli_version, published_at FROM pages
     WHERE id = ? AND taken_down = 0 AND expires_at > ? AND id NOT IN (SELECT page_id FROM blocked_ids)`,
  )
    .bind(id, Date.now())
    .first<PageRow>();
}

function b64(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

async function shell(env: Env, id: string): Promise<Response> {
  const page = await livePage(env, id);
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
      "content-security-policy": `default-src 'none'; script-src 'self' 'sha256-${hash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    },
  });
}

async function artifact(env: Env, id: string): Promise<Response> {
  const page = await livePage(env, id);
  if (!page) return NOT_FOUND();
  const obj = await env.PAGES.get(pageKey(id));
  if (!obj) return NOT_FOUND();
  return new Response(obj.body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // `sandbox` without allow-same-origin gives the page an opaque origin even when opened directly.
      "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    },
  });
}

async function pack(env: Env, sha: string): Promise<Response> {
  if (!SHA_RE.test(sha)) return NOT_FOUND();
  const obj = await env.PAGES.get(packKey(sha));
  if (!obj) return NOT_FOUND();
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
