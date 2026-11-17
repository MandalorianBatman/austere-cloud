const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function hex(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** SHA-256 as base64url (43 characters): how invite and asset tokens are stored. */
export async function sha256B64url(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

export async function hmacHex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

export const PAGE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const SHA_RE = /^[0-9a-f]{64}$/;

/** The owner's page-scoped sign-in cookie (`Path=/p/<id>`): a session token, 32 random bytes base64url. */
export const OWNER_COOKIE = "austere_owner";
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The well-formed `austere_owner` token in the request's Cookie header, or null. */
export function ownerCookie(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== OWNER_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (SESSION_TOKEN_RE.test(value)) return value;
  }
  return null;
}

/** Thrown by handlers to produce an error response. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
