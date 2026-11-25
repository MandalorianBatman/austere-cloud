// Browser sign-in (AuthKit) and the owner hub:
//   /auth/login?return_to=<path>  → AuthKit's hosted sign-in
//   /auth/callback                → code exchange, `austere_session` cookie, back to return_to
//   /auth/logout                  → cookie cleared, AuthKit session ended
//   /auth/config                  → { clientId, apiBase } for the CLI's device flow
//   /security                     → public: who can open a shared page
//   POST /theme                   → theme cookie (dark or light), 303 back to return_to
//   /                             → signed out: the landing page; signed in: the hub (austere-axi's shell in cloud mode)
//   /hub/api/*                    → the hub shell's JSON API (src/hub.ts)
import type { Env } from "./env";
import { ensureUser, upsertUser, type User } from "./accounts";
import { handleHubApi, hubPage } from "./hub";
import { verifyAccessToken, workosApi } from "./jwt";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  STATE_MAX_AGE_S,
  clearSessionCookie,
  cookieHeader,
  readCookie,
  readSession,
  seal,
  sessionCookie,
  signInUrl,
  unseal,
  withSession,
  type Session,
  type SessionData,
} from "./session";
import { WorkosRefused, accountsConfigured, authorizeUrl, exchangeCode, logoutUrl, requireAccounts } from "./workos";
import { landing } from "./landing";
import { security } from "./security";
import { privateDocument } from "./site";
import { THEME_COOKIE, THEME_MAX_AGE_S, parseTheme, themeOf } from "./theme";
import { HttpError, escapeHtml, json, randomId } from "./util";

// same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` on same-origin POSTs (the hub's grant calls, Sign out), which are refused.
const PRIVATE = { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "referrer-policy": "same-origin" };

/** A same-origin path to return to after sign-in; anything else is `/`. */
export function returnPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.length > 512) return "/";
  return /^[\x21-\x7e]+$/.test(raw) ? raw : "/";
}

function redirect(location: string, cookies: string[] = [], status = 303): Response {
  const headers = new Headers({ ...PRIVATE, location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status, headers });
}

/** A private HTML page in the site shell (noindex, no-store). `account` shows the email and Sign Out in the nav. */
function page(request: Request, env: Env, title: string, account: User | null, body: string, status = 200): Response {
  // The sign-out form's answer redirects to WorkOS, and form-action covers redirects.
  const formAction = `'self' ${new URL(workosApi(env)).origin}`;
  return new Response(privateDocument(`${title} · austere`, account, themeOf(request), body), {
    status,
    headers: {
      ...PRIVATE,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}

interface AuthState {
  state: string;
  returnTo: string;
  exp: number;
}

async function login(request: Request, env: Env): Promise<Response> {
  requireAccounts(env);
  const url = new URL(request.url);
  const state = randomId(16);
  const sealed = await seal(env, STATE_COOKIE, { state, returnTo: returnPath(url.searchParams.get("return_to")), exp: Date.now() + STATE_MAX_AGE_S * 1000 } satisfies AuthState);
  return redirect(authorizeUrl(env, `${url.origin}/auth/callback`, state), [cookieHeader(request, STATE_COOKIE, sealed, "/auth", STATE_MAX_AGE_S)], 302);
}

async function callback(request: Request, env: Env): Promise<Response> {
  requireAccounts(env);
  const url = new URL(request.url);
  const clearState = cookieHeader(request, STATE_COOKIE, "", "/auth", 0);
  const failed = (why: string) =>
    withSession(
      page(request, env, "Sign-in failed", null, `<div class="read"><div class="wrap read-in"><h1>Sign-in failed</h1><p>${escapeHtml(why)}</p><p><a href="/auth/login">Try again</a></p></div></div>`, 400),
      { userId: null, setCookie: clearState },
    );
  if (url.searchParams.get("error")) return failed(url.searchParams.get("error_description") || url.searchParams.get("error")!);
  const raw = readCookie(request, STATE_COOKIE);
  const saved = raw ? await unseal<AuthState>(env, STATE_COOKIE, raw) : null;
  const code = url.searchParams.get("code");
  if (!saved || saved.exp < Date.now() || saved.state !== url.searchParams.get("state") || !code) {
    return failed("This sign-in was started in another browser, or took too long. Start it again.");
  }
  let auth;
  try {
    auth = await exchangeCode(env, code);
  } catch (e) {
    if (e instanceof WorkosRefused) return failed("The sign-in code was not accepted. Start it again.");
    throw e;
  }
  const v = await verifyAccessToken(env, auth.accessToken);
  if (!v.ok || v.claims.sub !== auth.user.id) return failed("The sign-in did not verify.");
  await upsertUser(env, auth.user);
  const sealed = await seal(env, SESSION_COOKIE, { uid: auth.user.id, sid: v.claims.sid, at: auth.accessToken, rt: auth.refreshToken } satisfies SessionData);
  return redirect(saved.returnTo, [sessionCookie(request, sealed), clearState]);
}

async function logout(request: Request, env: Env): Promise<Response> {
  const session = await readSession(env, request);
  const cookies = [clearSessionCookie(request)];
  const home = `${new URL(request.url).origin}/`;
  return redirect(session.sessionId && accountsConfigured(env) ? logoutUrl(env, session.sessionId, home) : "/", cookies);
}

function config(env: Env): Response {
  if (!env.WORKOS_CLIENT_ID) throw new HttpError(503, "sign-in is not configured on this service");
  return json({ clientId: env.WORKOS_CLIENT_ID, apiBase: workosApi(env) });
}

/** `POST /theme`: the toggle. Sets the cookie to the chosen theme and answers 303 to a same-origin `return_to`. */
async function setTheme(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "expected a form");
  }
  const theme = parseTheme(form.get("theme") as string | null);
  if (!theme) throw new HttpError(400, "theme must be dark or light");
  const ret = form.get("return_to");
  return redirect(returnPath(typeof ret === "string" ? ret : null), [cookieHeader(request, THEME_COOKIE, theme, "/", THEME_MAX_AGE_S)]);
}

// ── the hub ──

/** `/`: the landing page, or once signed in the hub (src/hub.ts). */
async function home(request: Request, env: Env, session: Session): Promise<Response> {
  if (!accountsConfigured(env)) return landing(null, themeOf(request));
  if (!session.userId) return landing(signInUrl("/"), themeOf(request));
  return hubPage(env, await ensureUser(env, session.userId));
}

/** Handles /, /auth/* and /hub/api/*; null for other paths. */
export async function handleWeb(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = request.method;
  const allow = (methods: string, run: () => Response | Promise<Response>) =>
    methods.split(", ").includes(m) ? run() : new Response("method not allowed", { status: 405, headers: { ...PRIVATE, allow: methods } });
  if (path === "/auth/login") return allow("GET", () => login(request, env));
  if (path === "/auth/callback") return allow("GET", () => callback(request, env));
  if (path === "/auth/logout") return allow("GET, POST", () => logout(request, env));
  if (path === "/theme") return allow("POST", () => setTheme(request));
  if (path === "/auth/config") return allow("GET", () => config(env));
  if (path === "/security") return allow("GET, HEAD", () => security(accountsConfigured(env) ? signInUrl("/") : null, themeOf(request)));
  if (path !== "/" && !path.startsWith("/hub/api/")) return null;
  const run = async (): Promise<Response | null> => {
    const session = await readSession(env, request);
    const res = path === "/" ? await home(request, env, session) : await handleHubApi(request, env, session, path);
    return res && withSession(res, session);
  };
  if (path === "/") return allow("GET, HEAD", async () => (await run())!);
  return run();
}
