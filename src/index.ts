import type { Env } from "./env";
import { handleApi } from "./api";
import { handleServe } from "./serve";
import { serveRuntime } from "./runtime";
import { HttpError, json } from "./util";

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path.startsWith("/api/")) {
    return (await handleApi(request, env, path)) ?? json({ error: "not found" }, 404);
  }

  const rt = /^\/rt\/([^/]+)\/(.+)$/.exec(path);
  if (rt) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
    return serveRuntime(request, env, ctx, rt[1], rt[2]);
  }

  return (await handleServe(request, env, path)) ?? new Response("not found", { status: 404 });
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
