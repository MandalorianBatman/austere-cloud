// Browser sign-in (AuthKit) and the owner dashboard:
//   /auth/login?return_to=<path>  → AuthKit's hosted sign-in
//   /auth/callback                → code exchange, `austere_session` cookie, back to return_to
//   /auth/logout                  → cookie cleared, AuthKit session ended
//   /auth/config                  → { clientId, apiBase } for the CLI's device flow
//   /security                     → public: who can open a shared page
//   /                             → signed out: the landing page; signed in: my pages and their grants, pages shared with me
//   POST /dash/pages/:id/grants[/remove]  → the dashboard's grant forms
import type { Env } from "./env";
import { accountOwner, addGrant, ensureUser, listGrants, normalEmail, removeGrant, upsertUser, type User } from "./accounts";
import { ownedPage, ownedPages } from "./api";
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
import { HttpError, escapeHtml, json, randomId } from "./util";

const PRIVATE = { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "referrer-policy": "no-referrer" };

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

function page(env: Env, title: string, body: string, status = 200): Response {
  // The sign-out form's answer redirects to WorkOS, and form-action covers redirects.
  const formAction = `'self' ${new URL(workosApi(env)).origin}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)} · austere</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#e8e8e8;background:#111}
a{color:#7cb7ff}h1{font-size:1.3rem}h2{font-size:1.05rem;margin-top:2rem}
.page{border:1px solid #333;border-radius:8px;padding:.75rem 1rem;margin:.75rem 0}
.muted{color:#999}ul{padding-left:1.2rem}form{display:inline}
input{background:#1b1b1b;color:inherit;border:1px solid #444;border-radius:4px;padding:.2rem .4rem}
button{background:#2a2a2a;color:inherit;border:1px solid #555;border-radius:4px;padding:.2rem .6rem;cursor:pointer}
</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      ...PRIVATE,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
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
    withSession(page(env, "Sign-in failed", `<h1>Sign-in failed</h1><p>${escapeHtml(why)}</p><p><a href="/auth/login">Try again</a></p>`, 400), { userId: null, setCookie: clearState });
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

/** Pages shared with the account: a grant for its email on a live, published page. */
async function sharedPages(env: Env, user: User): Promise<{ id: string; title: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.title FROM grants g JOIN pages p ON p.id = g.page_id JOIN owners o ON o.id = p.owner_id
     WHERE g.email = ? AND p.published_at IS NOT NULL AND p.taken_down = 0 AND o.blocked = 0 AND p.expires_at > ?
       AND (o.user_id IS NULL OR o.user_id <> ?)
     ORDER BY p.created_at DESC`,
  )
    .bind(user.email, Date.now(), user.id)
    .all<{ id: string; title: string }>();
  return results;
}

async function dashboard(env: Env, session: Session): Promise<Response> {
  if (!accountsConfigured(env)) return landing(null);
  if (!session.userId) return landing(signInUrl("/"));
  const user = await ensureUser(env, session.userId);
  const owner = { id: await accountOwner(env, user.id), user };
  const mine = await ownedPages(env, owner);
  const parts = [
    `<h1>austere</h1><p>Signed in as <b>${escapeHtml(user.email)}</b>. <form method="post" action="/auth/logout"><button>Sign out</button></form></p>`,
    `<h2>Your pages</h2>`,
  ];
  if (!mine.length) parts.push(`<p class="muted">None yet. Run <code>austere-axi cloud login</code>, then <code>austere-axi publish &lt;file&gt;</code>.</p>`);
  for (const p of mine) {
    const grants = await listGrants(env, p.id);
    const rows = grants
      .map(
        (g) =>
          `<li>${escapeHtml(g.email)} <form method="post" action="/dash/pages/${p.id}/grants/remove"><input type="hidden" name="email" value="${escapeHtml(g.email)}"><button>Remove</button></form></li>`,
      )
      .join("");
    parts.push(`<div class="page"><a href="/p/${p.id}">${escapeHtml(p.title || "Untitled")}</a> <span class="muted">· ${p.notes} notes · expires ${new Date(p.expires_at).toISOString().slice(0, 10)}</span>
<ul>${rows || `<li class="muted">Only you.</li>`}</ul>
<form method="post" action="/dash/pages/${p.id}/grants"><input type="email" name="email" placeholder="email" required> <button>Grant access</button></form></div>`);
  }
  const shared = await sharedPages(env, user);
  if (shared.length) {
    parts.push(`<h2>Shared with you</h2><ul>${shared.map((p) => `<li><a href="/p/${p.id}">${escapeHtml(p.title || "Untitled")}</a></li>`).join("")}</ul>`);
  }
  return page(env, "Your pages", parts.join("\n"));
}

/** The dashboard's grant forms: same-origin POSTs with the session cookie. */
async function dashGrant(request: Request, env: Env, session: Session, id: string, remove: boolean): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new HttpError(403, "foreign origin");
  if (!session.userId) return redirect(signInUrl("/"));
  const user = await ensureUser(env, session.userId);
  await ownedPage(env, { id: await accountOwner(env, user.id), user }, id, { unpublished: true });
  const form = await request.formData();
  const email = normalEmail(form.get("email"));
  if (remove) await removeGrant(env, id, email);
  else await addGrant(env, id, email);
  return redirect("/");
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
    const res = grant ? await dashGrant(request, env, session, grant[1], !!grant[2]) : await dashboard(env, session);
    return withSession(res, session);
  });
}
