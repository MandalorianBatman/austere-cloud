import type { Env } from "./env";
import { HttpError, hmacHex } from "./util";

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;

/** A page lives this long after its last publish. */
export const RETENTION_MS = 30 * DAY;
/** How long a page created by POST /api/pages lives without a publish. */
export const UNPUBLISHED_MS = DAY;

export const RATE_LIMITS = {
  newOwnersPerIp: { max: 5, window: DAY },
  publishesPerOwner: { max: 20, window: DAY },
  publishesPerIp: { max: 100, window: DAY },
  notesPerIpPerPage: { max: 60, window: HOUR },
} as const;

/** HMAC of the client IP, used for rate limits and abuse handling instead of the raw address. */
export async function ipHash(env: Env, request: Request): Promise<string> {
  if (!env.IP_HMAC_KEY) throw new Error("IP_HMAC_KEY is not configured");
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  return hmacHex(env.IP_HMAC_KEY, ip);
}

type Limit = { max: number; window: number };

/**
 * Counts one hit against a fixed window. Returns null while under `max`, else the seconds until
 * the window resets. A single upsert keeps the counter atomic.
 */
export async function take(env: Env, key: string, { max, window }: Limit): Promise<number | null> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT (key) DO UPDATE SET
       window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END,
       count = CASE WHEN window_start <= ?2 - ?3 THEN 1 ELSE count + 1 END
     RETURNING count, window_start`,
  )
    .bind(key, now, window)
    .first<{ count: number; window_start: number }>();
  if (!row || row.count <= max) return null;
  return Math.max(1, Math.ceil((row.window_start + window - now) / 1000));
}

/** `take` for HTTP handlers: throws 429 with Retry-After once `max` is exceeded. */
export async function hit(env: Env, key: string, limit: Limit): Promise<void> {
  const retry = await take(env, key, limit);
  if (retry !== null) throw new HttpError(429, "rate limit exceeded; try again later", { "retry-after": String(retry) });
}
