// Owner credentials on /api and the owner socket: an anonymous owner token (32 random bytes,
// base64url; only the SHA-256 is stored), or a WorkOS access token (a JWT, verified against the
// JWKS) for an account, which owns every page of every owner it holds.
import type { Env } from "./env";
import { accountOwner, ensureUser, type User } from "./accounts";
import { JWT_RE, verifyAccessToken } from "./jwt";
import type { PageRow } from "./serve";
import { HttpError, sha256Hex } from "./util";

export interface Owner {
  /** The owner new pages are created as. */
  id: string;
  /** The account, for an access token; null for an anonymous owner token. */
  user: User | null;
}

/** The owner a token belongs to, or null for an unknown token. Throws 403 for a blocked owner. */
export async function ownerByToken(env: Env, token: string): Promise<Owner | null> {
  const row = await env.DB.prepare("SELECT id, blocked FROM owners WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ id: string; blocked: number }>();
  if (!row) return null;
  if (row.blocked) throw new HttpError(403, "this owner is blocked");
  return { id: row.id, user: null };
}

/** The account behind a verified access token; 401 for any token that does not verify. */
export async function ownerByAccessToken(env: Env, token: string): Promise<Owner> {
  const v = await verifyAccessToken(env, token);
  if (!v.ok) throw new HttpError(401, v.reason === "expired" ? "access token expired" : v.reason === "unconfigured" ? "accounts are not configured on this service" : "invalid token");
  const user = await ensureUser(env, v.claims.sub);
  return { id: await accountOwner(env, user.id), user };
}

/** Either credential: a JWT is an access token, anything else an owner token. Null for an unknown owner token. */
export function ownerByCredential(env: Env, credential: string): Promise<Owner | null> {
  return JWT_RE.test(credential) ? ownerByAccessToken(env, credential) : ownerByToken(env, credential);
}

export function bearer(request: Request): string | null {
  return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

/** The owner behind `Authorization: Bearer <token>`; 401 without a known token. */
export async function authenticate(env: Env, request: Request): Promise<Owner> {
  const token = bearer(request);
  if (!token) throw new HttpError(401, "missing bearer token");
  const owner = await ownerByCredential(env, token);
  if (!owner) throw new HttpError(401, "invalid token");
  return owner;
}

/** The owner's own page: created by this owner, or by any owner its account holds. */
export function ownsPage(owner: Owner, page: Pick<PageRow, "owner_id" | "owner_user_id">): boolean {
  return page.owner_id === owner.id || (owner.user !== null && page.owner_user_id === owner.user.id);
}
