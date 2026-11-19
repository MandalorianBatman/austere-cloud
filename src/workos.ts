// The WorkOS User Management calls the Worker makes: the browser's code exchange and its refresh
// (confidential client, with WORKOS_API_KEY), and a user lookup for a CLI token seen for the first time.
// The CLI's device flow and its refresh go from the CLI to WorkOS directly, with the client id only.
import type { Env } from "./env";
import { workosApi } from "./jwt";
import { HttpError } from "./util";

export interface WorkosUser {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
}

export interface Authenticated {
  user: WorkosUser;
  accessToken: string;
  refreshToken: string;
}

/** A refused refresh (`invalid_grant`: used, revoked or expired) or code: the session is over. */
export class WorkosRefused extends Error {}

/** Accounts are on: every secret the browser flow needs is set. */
export function accountsConfigured(env: Env): boolean {
  return !!(env.WORKOS_CLIENT_ID && env.WORKOS_API_KEY && (env.WORKOS_COOKIE_PASSWORD ?? "").length >= 32);
}

export function requireAccounts(env: Env): void {
  if (!accountsConfigured(env)) throw new HttpError(503, "sign-in is not configured on this service");
}

function isUser(u: unknown): u is WorkosUser {
  return !!u && typeof u === "object" && typeof (u as WorkosUser).id === "string" && typeof (u as WorkosUser).email === "string";
}

async function authenticate(env: Env, body: Record<string, string>): Promise<Authenticated> {
  const res = await fetch(`${workosApi(env)}/user_management/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: env.WORKOS_CLIENT_ID, client_secret: env.WORKOS_API_KEY, ...body }),
  });
  const data = (await res.json().catch(() => null)) as { user?: unknown; access_token?: unknown; refresh_token?: unknown; error?: unknown } | null;
  if (res.status >= 400 && res.status < 500) throw new WorkosRefused(typeof data?.error === "string" ? data.error : `WorkOS answered ${res.status}`);
  if (!res.ok || !data || !isUser(data.user) || typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
    throw new Error(`WorkOS authenticate answered ${res.status}`);
  }
  return { user: data.user, accessToken: data.access_token, refreshToken: data.refresh_token };
}

/** `/auth/callback`: the AuthKit code for the user's tokens. */
export function exchangeCode(env: Env, code: string): Promise<Authenticated> {
  return authenticate(env, { grant_type: "authorization_code", code });
}

/** A browser session's refresh token for new tokens. Refresh tokens work once: the caller must keep the new one. */
export function refreshSession(env: Env, refreshToken: string): Promise<Authenticated> {
  return authenticate(env, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** The user behind a token's `sub`, from WorkOS (only for a user this service has not seen yet). */
export async function fetchUser(env: Env, id: string): Promise<WorkosUser> {
  const res = await fetch(`${workosApi(env)}/user_management/users/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${env.WORKOS_API_KEY}`, accept: "application/json" },
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok || !isUser(data)) throw new HttpError(502, `could not look up the account (WorkOS answered ${res.status})`);
  return data;
}

/** Where `/auth/login` sends the browser: AuthKit's hosted sign-in. */
export function authorizeUrl(env: Env, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: env.WORKOS_CLIENT_ID!, redirect_uri: redirectUri, response_type: "code", provider: "authkit", state });
  return `${workosApi(env)}/user_management/authorize?${q}`;
}

/** Where `/auth/logout` sends the browser, so the AuthKit session ends too. */
export function logoutUrl(env: Env, sessionId: string, returnTo: string): string {
  return `${workosApi(env)}/user_management/sessions/logout?${new URLSearchParams({ session_id: sessionId, return_to: returnTo })}`;
}
