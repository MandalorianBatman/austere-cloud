// The signed-in `/`: austere-axi's hub shell in cloud mode (RLM-458), loaded through /rt like the review chrome, over the
// `/hub/api` this file answers from D1. The shell is the local hub's UI (`chrome/shell.js` of the pinned austere-axi
// release, `HUB_VERSION`); the account's pages, grants and shared pages are what the Worker holds. Types come from
// `austere-axi/hub-api`, so a change to what the shell reads fails the type check here.
import type {
  CloudUngrouped,
  GrantResult,
  GrantsResponse,
  HubBoot,
  PagesResponse,
  ProjectSummary,
  ProjectsResponse,
  SearchResponse,
  SharedPage,
  SharedResponse,
  ShellPage,
} from "austere-axi/hub-api";
import type { Env } from "./env";
import { GrantLimitError, MAX_GRANTS, accountOwner, addGrant, displayName, ensureUser, grantsByOwnedPage, normalEmail, removeGrant, type Grant, type User } from "./accounts";
import { ownedPage } from "./api";
import { workosApi } from "./jwt";
import type { Session } from "./session";
import { HttpError, cspHash, json } from "./util";

const PRIVATE = { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "referrer-policy": "same-origin" };

/** The group of pages with no project: published before `project` was sent, or by a CLI that could not place the file. */
const UNGROUPED: CloudUngrouped = "~ungrouped";

/** The hub page for `user`: the boot object, the pinned shell's stylesheet and script, and a CSP that allows just those. */
export async function hubPage(env: Env, user: User): Promise<Response> {
  const boot: HubBoot = { version: env.HUB_VERSION, home: "", sep: "/", mode: "cloud", account: { email: user.email, name: user.name } };
  const bootScript = `window.__AUSTERE_HUB__=${JSON.stringify(boot).replace(/</g, "\\u003c")}`;
  const rt = `/rt/${env.HUB_VERSION}/chrome`;
  const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0a0a">
<meta name="robots" content="noindex, nofollow">
<title>austere cloud</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${rt}/shell.css">
<script>${bootScript}</script>
<script src="${rt}/shell.js" defer></script>
</head>
<body><noscript>The hub needs JavaScript. <code>austere-axi publish list</code> shows the pages you published from this machine.</noscript></body>
</html>`;
  // `script-src 'self'` blocks the inline boot object, so it is allowed by hash (it holds the account, so the hash is per page).
  const hash = await cspHash(bootScript);
  // Sign out is a form POST whose answer redirects to WorkOS: form-action covers redirects.
  const formAction = `'self' ${new URL(workosApi(env)).origin}`;
  return new Response(html, {
    headers: {
      ...PRIVATE,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'self' 'sha256-${hash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}

interface OwnedRow {
  id: string;
  title: string;
  expires_at: number;
  notes: number;
  published_at: number;
  project: string | null;
  rel_path: string | null;
}

/** The account's published, unexpired pages, newest first: the filter of `ownedPages()` with the placement. */
async function ownedRows(env: Env, userId: string): Promise<OwnedRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, expires_at, notes, published_at, project, rel_path FROM pages
     WHERE owner_id IN (SELECT id FROM owners WHERE user_id = ?1) AND published_at IS NOT NULL AND taken_down = 0 AND expires_at > ?2 ORDER BY created_at DESC`,
  )
    .bind(userId, Date.now())
    .all<OwnedRow>();
  return results;
}

function shellPage(r: OwnedRow, people: number): ShellPage {
  return {
    id: r.id,
    project_id: r.project ?? UNGROUPED,
    project: r.project ?? "Ungrouped",
    rel_path: r.rel_path ?? "",
    title: r.title.trim() || null,
    updated_at: r.published_at,
    activity: r.published_at,
    open_id: r.id,
    copies: [],
    unanswered: 0,
    addressed: 0,
    held: 0,
    attach: "off",
    needs_you: false,
    changed: 0,
    failed: 0,
    waiting_on_agent: false,
    taker: null,
    run_active: false,
    group: "quiet",
    cloud: { expires_at: r.expires_at, notes: r.notes, people },
  };
}

function projectsOf(pages: ShellPage[]): ProjectSummary[] {
  const by = new Map<string, number>();
  for (const p of pages) by.set(p.project_id, (by.get(p.project_id) ?? 0) + 1);
  const named = pages.reduce((m, p) => m.set(p.project_id, p.project), new Map<string, string>());
  return [...by]
    .map(([id, n]): ProjectSummary => ({ id, name: named.get(id) ?? id, roots: [], same_as: null, pages: n, unanswered: 0, needs_you: 0 }))
    .sort((a, b) => (a.id === UNGROUPED ? 1 : b.id === UNGROUPED ? -1 : a.name.localeCompare(b.name)));
}

async function ownedShellPages(env: Env, user: User): Promise<ShellPage[]> {
  const [rows, grants] = await Promise.all([ownedRows(env, user.id), grantsByOwnedPage(env, user.id)]);
  return rows.map((r) => shellPage(r, grants.get(r.id)?.length ?? 0));
}

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
    title: r.title.trim() || null,
    expires_at: r.expires_at,
    owner: r.owner_email === null ? null : displayName({ id: "", email: r.owner_email, name: r.owner_name ?? "" }),
  }));
}

function grantsAnswer(user: User, grants: Grant[]): GrantsResponse {
  return { owner: user.email, grants: grants.map((g) => ({ email: g.email, added_at: g.createdAt })), limit: MAX_GRANTS };
}

/** `?project=` names a group by its id or name; "" is every group. */
const inProject = (p: ShellPage, ref: string): boolean => !ref || p.project_id === ref || p.project === ref;

/**
 * Answers `/hub/api/*` for the signed-in account (the session cookie); null for another path. A signed-out request is a
 * 403 (the shell says the browser is not signed in); a POST needs a same-origin `Origin`.
 */
export async function handleHubApi(request: Request, env: Env, session: Session, path: string): Promise<Response | null> {
  if (!path.startsWith("/hub/api/")) return null;
  const answer = (body: unknown, status = 200) => json(body, status, PRIVATE);
  const grant = /^\/hub\/api\/pages\/([^/]+)\/grants(\/remove)?$/.exec(path);
  const reads = ["/hub/api/projects", "/hub/api/pages", "/hub/api/shared", "/hub/api/search"];
  const m = request.method;
  if (!grant && !reads.includes(path)) return null;
  if (grant ? m !== "GET" && m !== "POST" : m !== "GET") return new Response("method not allowed", { status: 405, headers: { ...PRIVATE, allow: grant ? "GET, POST" : "GET" } });
  if (m === "POST" && request.headers.get("origin") !== new URL(request.url).origin) throw new HttpError(403, "foreign origin");
  if (!session.userId) throw new HttpError(403, "not signed in");
  const user = await ensureUser(env, session.userId);
  const url = new URL(request.url);

  if (grant) {
    const id = grant[1];
    await ownedPage(env, { id: await accountOwner(env, user.id), user }, id, { unpublished: true });
    if (m === "GET") return answer(grantsAnswer(user, (await grantsByOwnedPage(env, user.id)).get(id) ?? []));
    let body: { email?: unknown } | null;
    try {
      body = (await request.json()) as { email?: unknown } | null;
    } catch {
      throw new HttpError(400, "expected a JSON body");
    }
    const email = normalEmail(body?.email);
    let status: GrantResult["status"];
    if (grant[2]) {
      // A grant that is not there ends in the same state as one just removed.
      await removeGrant(env, id, email);
      status = "revoked";
    } else {
      status = (await addGrant(env, id, email)) ? "granted" : "exists";
    }
    const after = (await grantsByOwnedPage(env, user.id)).get(id) ?? [];
    return answer({ ...grantsAnswer(user, after), status } satisfies GrantResult);
  }

  if (path === "/hub/api/shared") return answer({ pages: await sharedPages(env, user) } satisfies SharedResponse);
  const pages = await ownedShellPages(env, user);
  const ref = (url.searchParams.get("project") ?? "").slice(0, 1000);
  if (path === "/hub/api/projects") return answer({ projects: projectsOf(pages) } satisfies ProjectsResponse);
  if (path === "/hub/api/pages") {
    const list = pages.filter((p) => inProject(p, ref));
    const found = list[0];
    return answer({
      view: "open",
      project: ref ? { id: found?.project_id ?? "", name: found?.project ?? ref, ref } : null,
      pages: list,
      counts: { open: list.length, everything: list.length, archived: 0, checked: 0 },
    } satisfies PagesResponse);
  }
  // Search: titles, paths and project names. A page's content is in its own object, so there are no parts.
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const needle = q.toLowerCase();
  const hit = (p: ShellPage) => [p.title ?? "", p.rel_path, p.project].some((s) => s.toLowerCase().includes(needle));
  return answer({ q, pages: needle ? pages.filter(hit) : [], parts: [] } satisfies SearchResponse);
}
