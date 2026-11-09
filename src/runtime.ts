// The pinned austere-axi runtime (/rt/<version>/<asset>): proxied from jsDelivr
// and cached, so hosted pages stay same-origin under `script-src 'self'`.
import type { Env } from "./env";

export const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Compares two x.y.z versions. Returns null when either is not a plain release version. */
export function compareVersions(a: string, b: string): number | null {
  const ma = VERSION_RE.exec(a);
  const mb = VERSION_RE.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function versionAllowed(env: Env, version: string): boolean {
  const c = compareVersions(version, env.MIN_CLI_VERSION);
  return c !== null && c >= 0;
}

/**
 * Maps a public asset path to its path inside the npm package's dist/, or null
 * when the asset is not on the allow-list. Packs are published as
 * dist/packs/<name>/pack.js but exposed as packs/<name>.js.
 */
export function distPath(asset: string): string | null {
  if (asset === "austere.js" || asset === "mermaid.min.js" || asset === "chrome/chrome.js" || asset === "chrome/chrome.css") {
    return asset;
  }
  const m = /^packs\/([a-z0-9][a-z0-9-]*)\.js$/.exec(asset);
  return m ? `packs/${m[1]}/pack.js` : null;
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export async function serveRuntime(request: Request, env: Env, ctx: ExecutionContext, version: string, asset: string): Promise<Response> {
  const dist = distPath(asset);
  if (!dist || !versionAllowed(env, version)) return new Response("not found", { status: 404 });
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + `/rt/${version}/${asset}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  const origin = env.RT_ORIGIN ?? "https://cdn.jsdelivr.net";
  const upstream = await fetch(`${origin}/npm/austere-axi@${version}/dist/${dist}`);
  if (upstream.status === 404) return new Response("not found", { status: 404 });
  if (!upstream.ok) return new Response("upstream error", { status: 502 });
  const body = await upstream.arrayBuffer();
  const res = new Response(body, {
    headers: {
      "content-type": TYPES[asset.slice(asset.lastIndexOf("."))] ?? "application/octet-stream",
      // A published version never changes.
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
