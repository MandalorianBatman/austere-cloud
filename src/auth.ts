// Owner credentials on /api and the owner socket: a WorkOS access token (a JWT, verified against the
// JWKS) for an account, which owns every page of every owner it holds. Since RLM-434 there is no
// anonymous owner token: every owner needs an account.
import type { Env } from "./env";
import { accountOwner, ensureUser, type User } from "./accounts";
import { verifyAccessToken } from "./jwt";
import type { PageRow } from "./serve";
import { HttpError } from "./util";

export interface Owner {
  /** The owner new pages are created as. */
  id: string;
  /** The account behind the access token. */
  user: User;
}

/** What a client from before accounts were required hears: owner tokens are gone. */
export const PRE_ACCOUNT = "anonymous owner tokens are no longer accepted: upgrade austere-axi to 0.17 or later and run `austere-axi cloud login`";

/** An anonymous owner token as CLIs before 0.17 send it: 32 random bytes, base64url. */
const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The account behind a verified access token; 401 for any token that does not verify. */
export async function ownerByAccessToken(env: Env, token: string): Promise<Owner> {
  if (OWNER_TOKEN_RE.test(token)) throw new HttpError(401, PRE_ACCOUNT);
  const v = await verifyAccessToken(env, token);
  if (!v.ok) throw new HttpError(401, v.reason === "expired" ? "access token expired" : v.reason === "unconfigured" ? "accounts are not configured on this service" : "invalid token");
  const user = await ensureUser(env, v.claims.sub);
  return { id: await accountOwner(env, user.id), user };
}

export function bearer(request: Request): string | null {
  return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

/** The account behind `Authorization: Bearer <access token>`; 401 without a valid one. */
export async function authenticate(env: Env, request: Request): Promise<Owner> {
  const token = bearer(request);
  if (!token) throw new HttpError(401, "missing bearer token: sign in with `austere-axi cloud login`");
  return ownerByAccessToken(env, token);
}

/** The owner's own page: created by any owner its account holds. */
export function ownsPage(owner: Owner, page: Pick<PageRow, "owner_id" | "owner_user_id">): boolean {
  return page.owner_id === owner.id || page.owner_user_id === owner.user.id;
}
