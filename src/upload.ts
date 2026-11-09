// Reading and validating the publish body (POST /api/pages, PUT /api/pages/:id).
import type { Env } from "./env";
import { distPath, versionAllowed } from "./runtime";
import { HttpError, SHA_RE, sha256Hex } from "./util";

/** Cap on the (gzip) request body. */
export const MAX_UPLOAD_BYTES = 1024 * 1024;
/** Cap on the decompressed JSON, so a small gzip bomb can't exhaust memory. */
export const MAX_INFLATED_BYTES = 16 * 1024 * 1024;
const MAX_PACKS = 16;
const MAX_TITLE = 200;

export interface PackMeta {
  sha256: string;
  name: string;
  version: string;
}

export interface Upload {
  cliVersion: string;
  title: string;
  html: string;
  auto: boolean;
  /** Uploaded packs that the html actually references. */
  packs: (PackMeta & { code: string })[];
  /** Size of the request body on the wire. */
  bytes: number;
}

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

async function readBody(request: Request): Promise<{ text: string; bytes: number }> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `upload is ${declared} bytes; the limit is ${MAX_UPLOAD_BYTES} bytes after gzip`);
  }
  const raw = await readCapped(request.body, MAX_UPLOAD_BYTES, "upload (gzip body)");
  let bytes = raw;
  // The magic-number check tolerates a runtime that already inflated the body.
  if (/gzip/i.test(request.headers.get("content-encoding") ?? "") && raw[0] === 0x1f && raw[1] === 0x8b) {
    const inflated = new Blob([raw as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    try {
      bytes = await readCapped(inflated as ReadableStream<Uint8Array>, MAX_INFLATED_BYTES, "inflated upload");
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "body is not valid gzip");
    }
  }
  return { text: new TextDecoder().decode(bytes), bytes: raw.byteLength };
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

/** Returns the pack shas the html references. Throws 400 on a src that is neither /rt/<v>/<asset> nor /pk/<sha>.js. */
export function checkScriptSrcs(html: string, cliVersion: string, uploaded: Set<string>): Set<string> {
  const used = new Set<string>();
  for (const src of scriptSrcs(html)) {
    const rt = /^\/rt\/([^/]+)\/(.+)$/.exec(src);
    if (rt && rt[1] === cliVersion && distPath(rt[2])) continue;
    const pk = /^\/pk\/([0-9a-f]{64})\.js$/.exec(src);
    if (pk && uploaded.has(pk[1])) {
      used.add(pk[1]);
      continue;
    }
    throw new HttpError(400, `script src ${JSON.stringify(src.slice(0, 200))} is not allowed; use /rt/${cliVersion}/<asset> or an uploaded /pk/<sha256>.js pack`);
  }
  return used;
}

export async function parseUpload(request: Request, env: Env): Promise<Upload> {
  const { text, bytes } = await readBody(request);
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");

  const cliVersion = body.cliVersion;
  if (typeof cliVersion !== "string" || !versionAllowed(env, cliVersion)) {
    throw new HttpError(400, `cliVersion must be a release version of at least ${env.MIN_CLI_VERSION}; upgrade austere-axi`);
  }
  if (typeof body.html !== "string" || !body.html) throw new HttpError(400, "html must be a non-empty string");
  if (body.title != null && typeof body.title !== "string") throw new HttpError(400, "title must be a string");
  if (body.auto != null && typeof body.auto !== "boolean") throw new HttpError(400, "auto must be a boolean");
  const rawPacks = body.packs ?? [];
  if (!Array.isArray(rawPacks) || rawPacks.length > MAX_PACKS) throw new HttpError(400, `packs must be an array of at most ${MAX_PACKS}`);

  const packs = new Map<string, PackMeta & { code: string }>();
  for (const p of rawPacks) {
    if (
      !p ||
      typeof p.sha256 !== "string" ||
      !SHA_RE.test(p.sha256) ||
      typeof p.code !== "string" ||
      typeof p.name !== "string" ||
      typeof p.version !== "string" ||
      p.name.length > 100 ||
      p.version.length > 50
    ) {
      throw new HttpError(400, "each pack needs sha256 (hex), name, version and code");
    }
    if ((await sha256Hex(p.code)) !== p.sha256) {
      throw new HttpError(400, `pack ${p.name}@${p.version}: code does not match its sha256`);
    }
    packs.set(p.sha256, { sha256: p.sha256, name: p.name, version: p.version, code: p.code });
  }

  const used = checkScriptSrcs(body.html, cliVersion, new Set(packs.keys()));
  return {
    cliVersion,
    title: (body.title?.trim() || "Untitled").slice(0, MAX_TITLE),
    html: body.html,
    auto: body.auto === true,
    packs: [...packs.values()].filter((p) => used.has(p.sha256)),
    bytes,
  };
}
