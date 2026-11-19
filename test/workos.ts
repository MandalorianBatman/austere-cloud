// A WorkOS stub for tests: a test-only RSA key and JWKS at https://workos.test, access tokens it
// signs, users, and the authenticate endpoint (code exchange, refresh with single-use refresh tokens).
// No real key or secret: vitest.config.ts points WORKOS_API_BASE here.
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { resetJwksCache } from "../src/jwt";
import { SESSION_COOKIE, seal } from "../src/session";
import { b64url } from "../src/util";

export const API = "https://workos.test";
export const CLIENT_ID = "client_test";
export const KID = "test-key-1";

const enc = new TextEncoder();
const b64json = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));

async function rsaPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

/** The key the JWKS publishes, and another one nobody publishes (for forged tokens). */
export const keys = { good: await rsaPair(), other: await rsaPair() };

export interface StubUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

export const stub = {
  users: new Map<string, StubUser>(),
  /** Live refresh tokens: token → user id. Each works once. */
  refresh: new Map<string, string>(),
  /** Browser sign-in codes: code → user id. */
  codes: new Map<string, string>(),
  /** Requests that reached the stub: "METHOD /path" (grant_type added for authenticate). */
  calls: [] as string[],
  /** Next authenticate answers 500 (WorkOS down). */
  down: false,
};

type Claims = Record<string, unknown>;

/** A signed access token. `over` replaces or (with undefined) removes claims; `key`/`kid` sign otherwise. */
export async function accessToken(sub: string, over: Claims = {}, { key = keys.good.privateKey, kid = KID, alg = "RS256" } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Claims = { iss: API, sub, client_id: CLIENT_ID, sid: `session_${sub}`, jti: crypto.randomUUID(), iat: now, exp: now + 300, ...over };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  const head = `${b64json({ alg, kid, typ: "JWT" })}.${b64json(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(head)));
  return `${head}.${b64url(sig)}`;
}

export function addUser(id: string, email: string, first: string | null = null, last: string | null = null): StubUser {
  const u = { id, email, first_name: first, last_name: last };
  stub.users.set(id, u);
  return u;
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function tokensFor(userId: string): Promise<Response> {
  const rt = `rt_${crypto.randomUUID()}`;
  stub.refresh.set(rt, userId);
  return answer({ user: { object: "user", ...stub.users.get(userId) }, access_token: await accessToken(userId), refresh_token: rt });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === `/sso/jwks/${CLIENT_ID}`) {
    stub.calls.push(`GET ${url.pathname}`);
    const jwk = await crypto.subtle.exportKey("jwk", keys.good.publicKey);
    return answer({ keys: [{ ...(jwk as JsonWebKey), kid: KID, use: "sig", alg: "RS256" }] });
  }
  const user = /^\/user_management\/users\/([^/]+)$/.exec(url.pathname);
  if (user) {
    stub.calls.push(`GET ${url.pathname}`);
    if (req.headers.get("authorization") !== "Bearer sk_test_stub") return answer({ message: "unauthorized" }, 401);
    const u = stub.users.get(decodeURIComponent(user[1]));
    return u ? answer({ object: "user", ...u }) : answer({ message: "not found" }, 404);
  }
  if (url.pathname === "/user_management/authenticate" && req.method === "POST") {
    const body = (await req.json()) as Record<string, string>;
    stub.calls.push(`POST ${url.pathname} ${body.grant_type}`);
    if (stub.down) {
      stub.down = false;
      return answer({ error: "server_error" }, 500);
    }
    if (body.client_id !== CLIENT_ID || body.client_secret !== "sk_test_stub") return answer({ error: "invalid_client" }, 401);
    if (body.grant_type === "authorization_code") {
      const uid = stub.codes.get(body.code);
      stub.codes.delete(body.code);
      return uid ? tokensFor(uid) : answer({ error: "invalid_grant" }, 400);
    }
    if (body.grant_type === "refresh_token") {
      const uid = stub.refresh.get(body.refresh_token);
      stub.refresh.delete(body.refresh_token); // single use: rotation
      return uid ? tokensFor(uid) : answer({ error: "invalid_grant" }, 400);
    }
  }
  return answer({ message: `stub has no ${req.method} ${url.pathname}` }, 404);
}

/** Routes fetches to https://workos.test into the stub; call in beforeEach. */
export function installWorkos(): void {
  stub.users.clear();
  stub.refresh.clear();
  stub.codes.clear();
  stub.calls.length = 0;
  stub.down = false;
  resetJwksCache();
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return req.url.startsWith(API) ? handle(req) : real(input, init);
  });
}

/** A browser's `austere_session` cookie for the user: a fresh access token (or `at`) and a live refresh token. */
export async function sessionCookie(userId: string, { at, rt }: { at?: string; rt?: string } = {}): Promise<{ cookie: string; rt: string }> {
  const refresh = rt ?? `rt_${crypto.randomUUID()}`;
  if (!rt) stub.refresh.set(refresh, userId);
  const sealed = await seal(env, SESSION_COOKIE, { uid: userId, sid: `session_${userId}`, at: at ?? (await accessToken(userId)), rt: refresh });
  return { cookie: `${SESSION_COOKIE}=${sealed}`, rt: refresh };
}
