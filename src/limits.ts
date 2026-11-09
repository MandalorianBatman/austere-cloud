import type { Env } from "./env";
import { HttpError, hmacHex } from "./util";

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;

export const LIMITS = {
  newOwnersPerIp: { max: 5, window: DAY },
  publishesPerOwner: { max: 20, window: DAY },
  publishesPerIp: { max: 100, window: DAY },
} as const;

/** HMAC of the client IP, used for rate limits and abuse handling instead of the raw address. */
export async function ipHash(env: Env, request: Request): Promise<string> {
  if (!env.IP_HMAC_KEY) throw new Error("IP_HMAC_KEY is not configured");
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  return hmacHex(env.IP_HMAC_KEY, ip);
}

/**
 * Counts one hit against a fixed window and throws 429 once `max` is exceeded.
 * A single upsert keeps the counter atomic.
 */
export async function hit(env: Env, key: string, { max, window }: { max: number; window: number }): Promise<void> {
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
  if (row && row.count > max) {
    const retry = Math.max(1, Math.ceil((row.window_start + window - now) / 1000));
    throw new HttpError(429, "rate limit exceeded; try again later", { "retry-after": String(retry) });
  }
}
