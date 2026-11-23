// Browser sign-in (AuthKit) and the owner dashboard:
//   /auth/login?return_to=<path>  → AuthKit's hosted sign-in
//   /auth/callback                → code exchange, `austere_session` cookie, back to return_to
//   /auth/logout                  → cookie cleared, AuthKit session ended
//   /auth/config                  → { clientId, apiBase } for the CLI's device flow
//   /security                     → public: who can open a shared page
//   /                             → signed out: the landing page; signed in: my pages and their grants, pages shared with me
//   POST /dash/pages/:id/grants[/remove]  → the dashboard's grant forms
import type { Env } from "./env";
import { GrantLimitError, accountOwner, addGrant, displayName, ensureUser, grantsByOwnedPage, normalEmail, removeGrant, upsertUser, type User } from "./accounts";
import { ownedPage, ownedPages } from "./api";
import { dashboardBody, noticeFrom, type SharedPage } from "./dashboard";
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
import { HttpError, escapeHtml, json, randomId } from "./util";

// same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` on the dashboard's form POSTs, which dashGrant refuses.
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
function page(env: Env, title: string, account: User | null, body: string, status = 200): Response {
  // The sign-out form's answer redirects to WorkOS, and form-action covers redirects.
  const formAction = `'self' ${new URL(workosApi(env)).origin}`;
  return new Response(privateDocument(`${title} · austere`, account, body), {
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
      page(env, "Sign-in failed", null, `<div class="read"><div class="wrap read-in"><h1>Sign-in failed</h1><p>${escapeHtml(why)}</p><p><a href="/auth/login">Try again</a></p></div></div>`, 400),
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

// ── dashboard ──

/** Pages shared with the account: a grant for its email on a live, published page, with the owner's name or email. */
async function sharedPages(env: Env, user: User): Promise<SharedPage[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.title, p.expires_at, u.name AS owner_name, u.email AS owner_email
     FROM grants g JOIN pages p ON p.id = g.page_id JOIN owners o ON o.id = p.owner_id LEFT JOIN users u ON u.id = o.user_id
     WHERE g.email = ? AND p.published_at IS NOT NULL AND p.taken_down = 0 AND o.blocked = 0 AND p.expires_at > ?
       AND (o.user_id IS NULL OR o.user_id <> ?)
     ORDER BY p.created_at DESC`,
  )
    .bind(user.email, Date.now(), user.id)
    .all<{ id: string; title: string; expires_at: number; owner_name: string | null; owner_email: string | null }>();
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    expires_at: r.expires_at,
    owner: r.owner_email === null ? null : displayName({ id: "", email: r.owner_email, name: r.owner_name ?? "" }),
  }));
}

async function dashboard(request: Request, env: Env, session: Session): Promise<Response> {
  if (!accountsConfigured(env)) return landing(null);
  if (!session.userId) return landing(signInUrl("/"));
  const url = new URL(request.url);
  const user = await ensureUser(env, session.userId);
  const owner = { id: await accountOwner(env, user.id), user };
  const [pages, grants, shared] = await Promise.all([ownedPages(env, owner), grantsByOwnedPage(env, user.id), sharedPages(env, user)]);
  const body = dashboardBody({ user, origin: url.origin, pages, grants, shared, notice: noticeFrom(url.searchParams), now: Date.now() });
  return page(env, "Your pages", user, body);
}

/**
 * The dashboard's grant forms: same-origin POSTs with the session cookie. Every outcome is a 303
 * back to the page's entry with a code (never the email: URLs reach history and logs).
 */
async function dashGrant(request: Request, env: Env, session: Session, id: string, remove: boolean): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new HttpError(403, "foreign origin");
  if (!session.userId) return redirect(signInUrl("/"));
  const user = await ensureUser(env, session.userId);
  try {
    await ownedPage(env, { id: await accountOwner(env, user.id), user }, id, { unpublished: true });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return redirect("/?error=gone");
    throw e;
  }
  const back = (key: "done" | "error", code: string) => redirect(`/?page=${id}&${key}=${code}#page-${id}`);
  let email: string;
  try {
    email = normalEmail((await request.formData()).get("email"));
  } catch (e) {
    if (e instanceof HttpError) return back("error", "email");
    throw e;
  }
  if (remove) {
    // A grant that is not there ends in the same state as one just removed.
    await removeGrant(env, id, email);
    return back("done", "revoked");
  }
  try {
    return back("done", (await addGrant(env, id, email)) ? "granted" : "exists");
  } catch (e) {
    if (e instanceof GrantLimitError) return back("error", "limit");
    throw e;
  }
}

/** Handles /, /auth/* and /dash/*; null for other paths. */
export async function handleWeb(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = request.method;
  const allow = (methods: string, run: () => Response | Promise<Response>) =>
    methods.split(", ").includes(m) ? run() : new Response("method not allowed", { status: 405, headers: { ...PRIVATE, allow: methods } });
  if (path === "/auth/login") return allow("GET", () => login(request, env));
  if (path === "/auth/callback") return allow("GET", () => callback(request, env));
  if (path === "/auth/logout") return allow("GET, POST", () => logout(request, env));
  if (path === "/auth/config") return allow("GET", () => config(env));
  if (path === "/security") return allow("GET, HEAD", () => security(accountsConfigured(env) ? signInUrl("/") : null));
  const grant = /^\/dash\/pages\/([^/]+)\/grants(\/remove)?$/.exec(path);
  if (path !== "/" && !grant) return null;
  return allow(grant ? "POST" : "GET, HEAD", async () => {
    const session = await readSession(env, request);
    const res = grant ? await dashGrant(request, env, session, grant[1], !!grant[2]) : await dashboard(request, env, session);
    return withSession(res, session);
  });
}
