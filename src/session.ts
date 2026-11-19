// The browser's account session: the `austere_session` cookie on `/` (HttpOnly, SameSite=Lax,
// Secure over https) holds the WorkOS access and refresh tokens, sealed with AES-GCM under a key
// derived from WORKOS_COOKIE_PASSWORD. Each request verifies the access token against the JWKS;
// an expired one is refreshed once and the new tokens are sealed into a new cookie (refresh tokens
// work once, so the response must carry it).
import type { Env } from "./env";
import { verifyAccessToken } from "./jwt";
import { WorkosRefused, accountsConfigured, refreshSession } from "./workos";
import { b64url } from "./util";

export const SESSION_COOKIE = "austere_session";
/** The sign-in's state and return path, between `/auth/login` and `/auth/callback`. */
export const STATE_COOKIE = "austere_auth";
/** How long the browser keeps the session cookie; WorkOS decides how long the session itself lives. */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
export const STATE_MAX_AGE_S = 10 * 60;

/** Where a signed-out viewer goes to sign in, then back to `returnTo` (a same-origin path). */
export function signInUrl(returnTo: string): string {
  return `/auth/login?${new URLSearchParams({ return_to: returnTo })}`;
}

export interface SessionData {
  /** WorkOS user id. */
  uid: string;
  /** WorkOS session id, for logout. */
  sid?: string;
  at: string;
  rt: string;
}

const enc = new TextEncoder();

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function sealKey(env: Env, purpose: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`${purpose}\u0000${env.WORKOS_COOKIE_PASSWORD}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `value` as JSON, encrypted and authenticated; `purpose` keeps one cookie's seal from opening as another. */
export async function seal(env: Env, purpose: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(env, purpose), enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64url(out);
}

/** What `seal` sealed, or null for anything tampered with, sealed for another purpose, or not a seal. */
export async function unseal<T>(env: Env, purpose: string, sealed: string): Promise<T | null> {
  if (!/^[A-Za-z0-9_-]{20,8192}$/.test(sealed)) return null;
  try {
    const bytes = fromB64url(sealed);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await sealKey(env, purpose), bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const secure = (request: Request) => (new URL(request.url).protocol === "https:" ? "; Secure" : "");

export function cookieHeader(request: Request, name: string, value: string, path: string, maxAge: number): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(request)}`;
}

export function sessionCookie(request: Request, sealed: string): string {
  return cookieHeader(request, SESSION_COOKIE, sealed, "/", SESSION_MAX_AGE_S);
}

export function clearSessionCookie(request: Request): string {
  return cookieHeader(request, SESSION_COOKIE, "", "/", 0);
}

export interface Session {
  /** The signed-in WorkOS user id, or null. */
  userId: string | null;
  sessionId?: string;
  /** Set when the tokens were refreshed, or the session is over: the response must send it. */
  setCookie?: string;
}

const SIGNED_OUT: Session = { userId: null };

/**
 * The signed-in account behind the request's session cookie. Signed out without a cookie or with
 * accounts off; a cookie that does not unseal, or a session WorkOS ended, is cleared. A failure that
 * may pass (WorkOS or its JWKS unreachable) is signed out but keeps the cookie, so the next request tries again.
 */
export async function readSession(env: Env, request: Request): Promise<Session> {
  if (!accountsConfigured(env)) return SIGNED_OUT;
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return SIGNED_OUT;
  const ended: Session = { userId: null, setCookie: clearSessionCookie(request) };
  const data = await unseal<SessionData>(env, SESSION_COOKIE, raw);
  if (!data || typeof data.at !== "string" || typeof data.rt !== "string" || typeof data.uid !== "string") return ended;
  try {
    const v = await verifyAccessToken(env, data.at);
    if (v.ok) return v.claims.sub === data.uid ? { userId: data.uid, sessionId: v.claims.sid ?? data.sid } : ended;
    if (v.reason !== "expired") return ended;
    const next = await refreshSession(env, data.rt);
    const nv = await verifyAccessToken(env, next.accessToken);
    if (!nv.ok || nv.claims.sub !== data.uid) return ended;
    const sid = nv.claims.sid ?? data.sid;
    const sealed = await seal(env, SESSION_COOKIE, { uid: data.uid, sid, at: next.accessToken, rt: next.refreshToken } satisfies SessionData);
    return { userId: data.uid, sessionId: sid, setCookie: sessionCookie(request, sealed) };
  } catch (e) {
    if (e instanceof WorkosRefused) return ended;
    console.error(e);
    return SIGNED_OUT;
  }
}

/** `res` with the session's Set-Cookie, when it has one (a WebSocket handshake's 101 included). */
export function withSession(res: Response, session: Session): Response {
  if (!session.setCookie) return res;
  const headers = new Headers(res.headers);
  headers.append("set-cookie", session.setCookie);
  if (res.webSocket) return new Response(null, { status: res.status, webSocket: res.webSocket, headers });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
