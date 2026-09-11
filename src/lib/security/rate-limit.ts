import "server-only";

import { ApiError } from "@/lib/api/errors";
import { query } from "@/lib/db/client";

interface RateBucket { count: number; resetAt: number; }
const buckets = new Map<string, RateBucket>();

/** Fast per-instance guard used before database work and on UI routes. */
export function enforceRateLimit(key: string, limit: number, windowMs = 60_000): void {
  const now = Date.now();
  if (buckets.size > 5_000) {
    for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
    if (buckets.size > 5_000) buckets.clear();
  }
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) { buckets.set(key, { count: 1, resetAt: now + windowMs }); return; }
  existing.count += 1;
  if (existing.count > limit) throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please wait a moment and try again.");
}

/** PostgreSQL-coordinated limiter for public/versioned API traffic across instances. */
export async function enforceDatabaseRateLimit(key: string, limit: number, windowMs = 60_000): Promise<void> {
  const result = await query<{ request_count: number }>(
    `INSERT INTO rate_limits(key, window_started_at, request_count, updated_at)
     VALUES ($1, now(), 1, now())
     ON CONFLICT (key) DO UPDATE SET
       window_started_at = CASE WHEN rate_limits.window_started_at <= now() - ($2::int * interval '1 millisecond') THEN now() ELSE rate_limits.window_started_at END,
       request_count = CASE WHEN rate_limits.window_started_at <= now() - ($2::int * interval '1 millisecond') THEN 1 ELSE rate_limits.request_count + 1 END,
       updated_at = now()
     RETURNING request_count`,
    [key, windowMs],
  );
  if (Number(result.rows[0]?.request_count ?? 0) > limit) throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please wait a moment and try again.");
}

export async function pruneDatabaseRateLimits(): Promise<number> {
  const result = await query(`DELETE FROM rate_limits WHERE updated_at < now() - interval '2 hours'`);
  return result.rowCount ?? 0;
}
