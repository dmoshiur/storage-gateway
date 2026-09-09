import "server-only";

import { ApiError } from "@/lib/api/errors";

interface RateBucket {
  count: number;
  resetAt: number;
}

// This intentionally avoids extra infrastructure for a small NGO deployment.
// It limits each warm Vercel instance; pair it with Vercel WAF/rate limits for
// globally coordinated production protection.
const buckets = new Map<string, RateBucket>();

export function enforceRateLimit(key: string, limit: number, windowMs = 60_000): void {
  const now = Date.now();
  // Keep the best-effort in-memory limiter bounded under a spray of unique keys.
  if (buckets.size > 5_000) {
    for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
    if (buckets.size > 5_000) buckets.clear();
  }
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  existing.count += 1;
  if (existing.count > limit) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please wait a moment and try again.");
  }
}
