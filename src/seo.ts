// Crawler and brand files served from the Worker: /robots.txt, /sitemap.xml, /llms.txt, /favicon.svg, /og.png, /apple-touch-icon.png.

import OG_PNG from "./og.png";
import APPLE_ICON from "./apple-touch-icon.png";
import { FAVICON_SVG, ORIGIN } from "./site";

const ROBOTS = `User-agent: *
Allow: /
Disallow: /p/
Disallow: /api/
Disallow: /auth/
Disallow: /hub/
Disallow: /rt/
Disallow: /pk/
Sitemap: ${ORIGIN}/sitemap.xml
`;

// No <lastmod>: it would have to come from a real deploy time.
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${ORIGIN}/</loc></url>
<url><loc>${ORIGIN}/security</loc></url>
</urlset>
`;

const GH = "https://github.com/MandalorianBatman";
const LLMS = `# austere

> austere turns the plan, design or report your AI coding agent writes into a review page. austere cloud hosts that page with one named, revocable link per reviewer. Reviewers’ notes wait for the owner’s approval before they reach the agent.

- CLI: \`austere-axi\` on npm, open source (MIT), needs Node.js 22.18 or later
- Works with Claude Code, Codex, Cursor and Claude Desktop
- Pages are invite-only by default and stop being served 30 days after the last publish

## Docs

- [Install and quick start](${GH}/austere-axi/blob/main/docs/install.md): CLI, skills, Claude Code plugin, MCP server
- [Hosted pages](${GH}/austere-axi/blob/main/docs/hosted-pages.md): publish, invites, revoke, accounts
- [Security](${ORIGIN}/security): who can open a page, what the service stores
- [How it works](${GH}/austere-axi/blob/main/docs/how-it-works.md): the review loop
- [CLI reference](${GH}/austere-axi/blob/main/docs/cli.md): every command

## Source

- [austere-axi](${GH}/austere-axi): the CLI and review page
- [austere-cloud](${GH}/austere-cloud): the hosted service
`;

function text(body: string, type: string): Response {
  return new Response(body, {
    headers: { "content-type": type, "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" },
  });
}

function png(body: ArrayBuffer, cache: string): Response {
  return new Response(body, { headers: { "content-type": "image/png", "cache-control": cache, "x-content-type-options": "nosniff" } });
}

/** Handles the crawler and brand files; null for other paths. GET and HEAD only. */
export function handleSite(request: Request, path: string): Response | null {
  let res: Response;
  switch (path) {
    case "/robots.txt":
      res = text(ROBOTS, "text/plain; charset=utf-8");
      break;
    case "/sitemap.xml":
      res = text(SITEMAP, "application/xml; charset=utf-8");
      break;
    case "/llms.txt":
      res = text(LLMS, "text/plain; charset=utf-8");
      break;
    case "/favicon.svg":
      res = text(FAVICON_SVG, "image/svg+xml");
      break;
    case "/og.png":
      res = png(OG_PNG, "public, max-age=86400");
      break;
    case "/apple-touch-icon.png":
      res = png(APPLE_ICON, "public, max-age=86400");
      break;
    default:
      return null;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  return res;
}
