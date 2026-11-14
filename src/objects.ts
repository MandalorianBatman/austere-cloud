// Content-addressed objects (R2 `objects/<sha256>`): page HTML and pack JS. The owner uploads
// them with PUT /api/objects/:sha256; a `publish` mutation then names them, and `page_objects`
// counts which pages reference which objects.
import type { Env } from "./env";
import { distPath } from "./runtime";
import { HttpError, sha256Hex } from "./util";

/** Cap on the (gzip) request body. */
export const MAX_UPLOAD_BYTES = 1024 * 1024;
/** Cap on the decoded object, so a small gzip bomb can't exhaust memory. */
export const MAX_INFLATED_BYTES = 16 * 1024 * 1024;

export const objectKey = (sha: string) => `objects/${sha}`;

export const HTML_TYPE = "text/html; charset=utf-8";
export const JS_TYPE = "text/javascript; charset=utf-8";
const TYPES: Record<string, string> = { "text/html": HTML_TYPE, "text/javascript": JS_TYPE };

async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number, what: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  if (stream) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        await reader.cancel();
        throw new HttpError(413, `${what} exceeds the ${max} byte limit`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** The decoded request body. The 1 MB cap applies to the bytes on the wire. */
async function readBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `upload is ${declared} bytes; the limit is ${MAX_UPLOAD_BYTES} bytes after gzip`);
  }
  const raw = await readCapped(request.body, MAX_UPLOAD_BYTES, "upload (gzip body)");
  // The magic-number check tolerates a runtime that already inflated the body.
  if (!(/gzip/i.test(request.headers.get("content-encoding") ?? "") && raw[0] === 0x1f && raw[1] === 0x8b)) return raw;
  const inflated = new Blob([raw as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  try {
    return await readCapped(inflated as ReadableStream<Uint8Array>, MAX_INFLATED_BYTES, "inflated upload");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "body is not valid gzip");
  }
}

/** PUT /api/objects/:sha256 for an authenticated owner. Answers 204; an existing object is left as is. */
export async function putObject(env: Env, request: Request, sha: string): Promise<Response> {
  const type = TYPES[(request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()];
  if (!type) throw new HttpError(400, "content-type must be text/html or text/javascript");
  const bytes = await readBody(request);
  if ((await sha256Hex(bytes)) !== sha) throw new HttpError(400, "body does not match its sha256");
  // Content-addressed: an existing object has these bytes. Its type comes from its first upload.
  if (!(await env.PAGES.head(objectKey(sha)))) {
    await env.PAGES.put(objectKey(sha), bytes, { httpMetadata: { contentType: type } });
  }
  return new Response(null, { status: 204 });
}

const SCRIPT_TAG_RE = /<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The `src` of every <script> tag. A tag with a bare `src` attribute yields "". */
export function scriptSrcs(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.matchAll(SCRIPT_TAG_RE)) {
    for (const a of tag[1].matchAll(ATTR_RE)) {
      if (a[1].toLowerCase() === "src") out.push(a[2] ?? a[3] ?? a[4] ?? "");
    }
  }
  return out;
}

/** Why the html may not be published, or null: every src must be /rt/<cliVersion>/<asset> or a named /pk/<sha>.js. */
export function scriptSrcError(html: string, cliVersion: string, packs: Set<string>): string | null {
  for (const src of scriptSrcs(html)) {
    const rt = /^\/rt\/([^/]+)\/(.+)$/.exec(src);
    if (rt && rt[1] === cliVersion && distPath(rt[2])) continue;
    const pk = /^\/pk\/([0-9a-f]{64})\.js$/.exec(src);
    if (pk && packs.has(pk[1])) continue;
    return `script src ${JSON.stringify(src.slice(0, 200))} is not allowed; use /rt/${cliVersion}/<asset> or a /pk/<sha256>.js pack the publish names`;
  }
  return null;
}

/**
 * Makes `shas` the objects page `id` references, and deletes each object it stopped
 * referencing that no other page references. An empty list drops every reference.
 */
export async function setPageObjects(env: Env, id: string, shas: string[]): Promise<void> {
  const keep = [...new Set(shas)];
  const { results } = await env.DB.prepare("SELECT sha FROM page_objects WHERE page_id = ?").bind(id).all<{ sha: string }>();
  const dropped = results.map((r) => r.sha).filter((sha) => !keep.includes(sha));
  const stmts = keep.map((sha) => env.DB.prepare("INSERT OR IGNORE INTO page_objects (page_id, sha) VALUES (?, ?)").bind(id, sha));
  for (const sha of dropped) stmts.push(env.DB.prepare("DELETE FROM page_objects WHERE page_id = ? AND sha = ?").bind(id, sha));
  if (stmts.length) await env.DB.batch(stmts);
  for (const sha of dropped) {
    const used = await env.DB.prepare("SELECT 1 AS ok FROM page_objects WHERE sha = ? LIMIT 1").bind(sha).first();
    if (!used) await env.PAGES.delete(objectKey(sha));
  }
}
