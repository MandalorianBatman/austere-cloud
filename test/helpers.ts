import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index";
import { sha256Hex } from "../src/util";

export const CLI = "0.4.1";
export const ORIGIN = "https://austere.test";

export async function call(path: string, init: RequestInit & { ip?: string; token?: string; json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", init.ip ?? "203.0.113.1");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("content-type", "application/json");
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(ORIGIN + path, { ...init, headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function newOwner(ip?: string): Promise<string> {
  const res = await call("/api/owners", { method: "POST", ip });
  if (res.status !== 201) throw new Error(`owner create failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

export const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Plan</title>
<script src="/rt/${CLI}/austere.js"></script></head>
<body><script type="text/openui">
root = Card([CardHeader("Hello")])
</script></body></html>`;

export function upload(over: Record<string, unknown> = {}) {
  return { cliVersion: CLI, title: "Plan", html: PAGE_HTML, ...over };
}

export async function publish(token: string, over: Record<string, unknown> = {}, ip?: string) {
  const res = await call("/api/pages", { method: "POST", token, json: upload(over), ip });
  return { res, body: (await res.clone().json()) as any };
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export { sha256Hex };
