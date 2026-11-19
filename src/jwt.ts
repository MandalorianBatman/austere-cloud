// WorkOS access tokens: RS256 JWTs signed by the keys at `<api>/sso/jwks/<client id>`. The key set
// is cached per isolate, so a verify makes no network call; an unknown `kid` refetches it, at most
// once per JWKS_REFETCH_MS.
import type { Env } from "./env";

export const DEFAULT_WORKOS_API = "https://api.workos.com";
/** How long a fetched key set is used before it is fetched again. */
export const JWKS_TTL_MS = 60 * 60 * 1000;
/** The least time between two fetches of the key set, so tokens with made-up `kid`s cannot drive fetches. */
export const JWKS_REFETCH_MS = 5 * 60 * 1000;
/** Clock skew allowed on `exp`, `nbf` and `iat`. */
export const CLOCK_SKEW_S = 30;

export interface AccessClaims {
  /** The WorkOS user id. */
  sub: string;
  /** The WorkOS session id, for logout. */
  sid?: string;
  exp: number;
}

export type VerifyResult = { ok: true; claims: AccessClaims } | { ok: false; reason: "malformed" | "signature" | "expired" | "issuer" | "audience" | "unconfigured" };

export function workosApi(env: Env): string {
  return (env.WORKOS_API_BASE || DEFAULT_WORKOS_API).replace(/\/+$/, "");
}

/**
 * The issuers a token may name: `WORKOS_ISSUER` (comma-separated) when set, else the two WorkOS
 * uses for the API host, `<api>` and `<api>/user_management/<client id>`.
 */
export function issuers(env: Env): string[] {
  if (env.WORKOS_ISSUER) return env.WORKOS_ISSUER.split(",").map((s) => s.trim()).filter(Boolean);
  const api = workosApi(env);
  return [api, `${api}/user_management/${env.WORKOS_CLIENT_ID}`];
}

interface KeySet {
  url: string;
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

let cache: KeySet | null = null;
let inflight: Promise<KeySet> | null = null;

/** Test hook: forget the cached key set. */
export function resetJwksCache(): void {
  cache = null;
  inflight = null;
}

async function fetchKeys(url: string): Promise<KeySet> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS ${url} answered ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string; use?: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid || (jwk.use && jwk.use !== "sig")) continue;
    const { kid, use: _use, alg: _alg, key_ops: _ops, ...rest } = jwk;
    keys.set(kid, await crypto.subtle.importKey("jwk", { ...rest, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  return { url, keys, fetchedAt: Date.now() };
}

/** The key for `kid`: from the cache, else from a (rate-limited, shared) refetch. Null when the set has no such key. */
async function keyFor(url: string, kid: string): Promise<CryptoKey | null> {
  const now = Date.now();
  const fresh = cache && cache.url === url && now - cache.fetchedAt < JWKS_TTL_MS;
  const hit = fresh ? cache!.keys.get(kid) : undefined;
  if (hit) return hit;
  if (fresh && now - cache!.fetchedAt < JWKS_REFETCH_MS) return null;
  inflight ??= fetchKeys(url).finally(() => (inflight = null));
  try {
    cache = await inflight;
  } catch (e) {
    // Keep a stale set over none: a WorkOS outage should not sign everyone out at once.
    if (!cache || cache.url !== url) throw e;
    console.error(e);
  }
  return cache.keys.get(kid) ?? null;
}

function b64urlBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Verifies a WorkOS access token: RS256 signature by a key of the client's JWKS, `exp`/`nbf`/`iat`
 * (with CLOCK_SKEW_S), `iss` (see `issuers`), and the audience: `client_id` (what WorkOS sets) or
 * `aud` must be WORKOS_CLIENT_ID. `expired` is only given for a token that is otherwise valid.
 */
export async function verifyAccessToken(env: Env, token: string, now = Date.now()): Promise<VerifyResult> {
  if (!env.WORKOS_CLIENT_ID) return { ok: false, reason: "unconfigured" };
  if (token.length > 8192 || !JWT_RE.test(token)) return { ok: false, reason: "malformed" };
  const [h, p, s] = token.split(".");
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "malformed" };
  const key = await keyFor(`${workosApi(env)}/sso/jwks/${encodeURIComponent(env.WORKOS_CLIENT_ID)}`, header.kid);
  if (!key) return { ok: false, reason: "signature" };
  const signed = new TextEncoder().encode(`${h}.${p}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(s) as BufferSource, signed))) return { ok: false, reason: "signature" };

  if (typeof payload.iss !== "string" || !issuers(env).includes(payload.iss)) return { ok: false, reason: "issuer" };
  const aud = payload.aud;
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (payload.client_id !== env.WORKOS_CLIENT_ID && !audiences.includes(env.WORKOS_CLIENT_ID)) return { ok: false, reason: "audience" };
  if (typeof payload.sub !== "string" || !payload.sub || typeof payload.exp !== "number") return { ok: false, reason: "malformed" };
  const t = now / 1000;
  if (typeof payload.nbf === "number" && payload.nbf > t + CLOCK_SKEW_S) return { ok: false, reason: "malformed" };
  if (typeof payload.iat === "number" && payload.iat > t + CLOCK_SKEW_S) return { ok: false, reason: "malformed" };
  if (payload.exp <= t - CLOCK_SKEW_S) return { ok: false, reason: "expired" };
  return { ok: true, claims: { sub: payload.sub, sid: typeof payload.sid === "string" ? payload.sid : undefined, exp: payload.exp } };
}
