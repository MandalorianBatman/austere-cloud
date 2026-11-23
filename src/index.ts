import type { Env } from "./env";
import { handleApi } from "./api";
import { handleServe } from "./serve";
import { handleWeb } from "./web";
import { serveRuntime } from "./runtime";
import { handleSite } from "./seo";
import { HttpError, json } from "./util";
import { assetToken, reviewerSync } from "./sync";

export { PageObject } from "./page";

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path.startsWith("/api/")) {
    return (await handleApi(request, env, path)) ?? json({ error: "not found" }, 404);
  }

  const sync = /^\/p\/([^/]+)\/sync$/.exec(path);
  if (sync) return request.method === "GET" ? reviewerSync(request, env, sync[1]) : new Response("method not allowed", { status: 405 });

  const asset = /^\/p\/([^/]+)\/asset-token$/.exec(path);
  if (asset) return request.method === "POST" ? assetToken(request, env, asset[1]) : new Response("method not allowed", { status: 405, headers: { allow: "POST" } });

  const rt = /^\/rt\/([^/]+)\/(.+)$/.exec(path);
  if (rt) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
    return serveRuntime(request, env, ctx, rt[1], rt[2]);
  }

  const site = handleSite(request, path);
  if (site) return site;

  return (await handleWeb(request, env, path)) ?? (await handleServe(request, env, path)) ?? new Response("not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, e.headers);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
