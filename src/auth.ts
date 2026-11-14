// Owner tokens: 32 random bytes, base64url; only the SHA-256 is stored.
import type { Env } from "./env";
import { HttpError, sha256Hex } from "./util";

export interface Owner {
  id: string;
}

/** The owner a token belongs to, or null for an unknown token. Throws 403 for a blocked owner. */
export async function ownerByToken(env: Env, token: string): Promise<Owner | null> {
  const row = await env.DB.prepare("SELECT id, blocked FROM owners WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ id: string; blocked: number }>();
  if (!row) return null;
  if (row.blocked) throw new HttpError(403, "this owner is blocked");
  return { id: row.id };
}

/** The owner behind `Authorization: Bearer <token>`; 401 without a known token. */
export async function authenticate(env: Env, request: Request): Promise<Owner> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) throw new HttpError(401, "missing bearer token");
  const owner = await ownerByToken(env, m[1]);
  if (!owner) throw new HttpError(401, "invalid token");
  return owner;
}
