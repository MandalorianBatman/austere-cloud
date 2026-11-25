// Accounts in D1 (RLM-414): users, the owners they hold, and who may open a page.
// A page's owner is its `owner_id`; any account that holds that owner is the owner on the page.
// A collaborator is an account whose email has a grant on the page.
import type { Env } from "./env";
import { reservedName } from "./presence";
import type { PageRow } from "./serve";
import { fetchUser, type WorkosUser } from "./workos";
import { HttpError, randomId, sha256Hex } from "./util";

export interface User {
  id: string;
  email: string;
  name: string;
}

export type PageRole = "owner" | "collaborator";

/** How a collaborator is shown: the account's name, else its email; never a reserved name. */
export function displayName(user: User): string {
  const name = user.name.trim();
  return name && !reservedName(name) ? name : user.email;
}

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** A grant's email: trimmed, lowercased, or a 400. */
export function normalEmail(email: unknown): string {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(e)) throw new HttpError(400, "email must be an email address");
  return e;
}

/** Writes what WorkOS says about the user (every browser sign-in refreshes it). */
export async function upsertUser(env: Env, u: WorkosUser): Promise<User> {
  const user = { id: u.id, email: u.email.trim().toLowerCase(), name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() };
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name, updated_at = excluded.updated_at`,
  )
    .bind(user.id, user.email, user.name, now)
    .run();
  return user;
}

export function userById(env: Env, id: string): Promise<User | null> {
  return env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?").bind(id).first<User>();
}

/** The user behind a verified token: from D1, else looked up at WorkOS once and kept. */
export async function ensureUser(env: Env, id: string): Promise<User> {
  return (await userById(env, id)) ?? upsertUser(env, await fetchUser(env, id));
}

/**
 * The owner the account publishes new pages as: its oldest owner, created on first use. 403 when
 * it is blocked.
 */
export async function accountOwner(env: Env, userId: string): Promise<string> {
  const pick = () =>
    env.DB.prepare("SELECT id, blocked FROM owners WHERE user_id = ? ORDER BY created_at, id LIMIT 1").bind(userId).first<{ id: string; blocked: number }>();
  let row = await pick();
  if (!row) {
    // An account's own owner has no usable bearer token: the hash is of random bytes nobody keeps.
    await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, user_id) VALUES (?, ?, ?, ?)")
      .bind(randomId(), await sha256Hex(randomId(32)), Date.now(), userId)
      .run();
    row = (await pick())!;
  }
  if (row.blocked) throw new HttpError(403, "this owner is blocked");
  return row.id;
}

/** The account's role on a page: owner, collaborator (a grant for its email), or none. */
export async function pageRole(env: Env, page: Pick<PageRow, "id" | "owner_user_id">, user: User): Promise<PageRole | null> {
  if (page.owner_user_id !== null && page.owner_user_id === user.id) return "owner";
  const grant = await env.DB.prepare("SELECT 1 AS ok FROM grants WHERE page_id = ? AND email = ?").bind(page.id, user.email).first();
  return grant ? "collaborator" : null;
}

/** Whether an account let in as owner (or collaborator) still is one on the page: checked again when its artifact loads and when grants change. */
export async function accessHolds(env: Env, pageId: string, access: { user: string; email: string; owner: boolean }): Promise<boolean> {
  if (access.owner) {
    const row = await env.DB.prepare("SELECT o.user_id FROM pages p JOIN owners o ON o.id = p.owner_id WHERE p.id = ?").bind(pageId).first<{ user_id: string | null }>();
    return row?.user_id === access.user;
  }
  return !!(await env.DB.prepare("SELECT 1 AS ok FROM grants WHERE page_id = ? AND email = ?").bind(pageId, access.email).first());
}

export interface Grant {
  email: string;
  role: PageRole;
  createdAt: number;
}

export async function listGrants(env: Env, pageId: string): Promise<Grant[]> {
  const { results } = await env.DB.prepare("SELECT email, role, created_at FROM grants WHERE page_id = ? ORDER BY created_at, email")
    .bind(pageId)
    .all<{ email: string; role: PageRole; created_at: number }>();
  return results.map((r) => ({ email: r.email, role: r.role, createdAt: r.created_at }));
}

/** Most grants one page may hold. */
export const MAX_GRANTS = 100;

/** The page already holds `MAX_GRANTS` grants. A 400 on the API; the hub shows its own text for it. */
export class GrantLimitError extends HttpError {
  constructor() {
    super(400, `a page may have at most ${MAX_GRANTS} grants`);
  }
}

/**
 * The grants on every live page the account owns, in one query, by page id. The page filter is
 * `ownedPages()`'s, so a page missing here is missing there.
 */
export async function grantsByOwnedPage(env: Env, userId: string): Promise<Map<string, Grant[]>> {
  const { results } = await env.DB.prepare(
    `SELECT g.page_id, g.email, g.role, g.created_at FROM grants g JOIN pages p ON p.id = g.page_id
     WHERE p.owner_id IN (SELECT id FROM owners WHERE user_id = ?1) AND p.published_at IS NOT NULL AND p.taken_down = 0 AND p.expires_at > ?2
     ORDER BY g.created_at, g.email`,
  )
    .bind(userId, Date.now())
    .all<{ page_id: string; email: string; role: PageRole; created_at: number }>();
  const by = new Map<string, Grant[]>();
  for (const r of results) {
    const list = by.get(r.page_id) ?? [];
    list.push({ email: r.email, role: r.role, createdAt: r.created_at });
    by.set(r.page_id, list);
  }
  return by;
}

/** Grants page `pageId` to `email`. Returns false when the grant was there already. */
export async function addGrant(env: Env, pageId: string, email: string): Promise<boolean> {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE page_id = ?").bind(pageId).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_GRANTS) throw new GrantLimitError();
  const r = await env.DB.prepare("INSERT OR IGNORE INTO grants (page_id, email, role, created_at) VALUES (?, ?, 'collaborator', ?)")
    .bind(pageId, email, Date.now())
    .run();
  return r.meta.changes > 0;
}

/** Removes the grant; the page object then closes that account's sockets. Returns false when there was none. */
export async function removeGrant(env: Env, pageId: string, email: string): Promise<boolean> {
  const r = await env.DB.prepare("DELETE FROM grants WHERE page_id = ? AND email = ?").bind(pageId, email).run();
  if (r.meta.changes > 0) await env.PAGE.get(env.PAGE.idFromName(pageId)).accessChanged();
  return r.meta.changes > 0;
}
