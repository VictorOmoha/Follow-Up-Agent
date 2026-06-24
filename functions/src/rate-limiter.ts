/**
 * Simple in-memory rate limiter using a sliding window per IP.
 *
 * Usage:
 *   const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });
 *   const result = limiter.check(clientIp);
 *   if (!result.ok) return 429;
 */

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

type Bucket = { count: number; resetAt: number };

export function createRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  // Cleanup expired buckets periodically
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, options.windowMs * 2);
  cleanupInterval.unref?.();

  function check(key: string): RateLimitResult {
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > options.max) {
      return {
        ok: false,
        remaining: 0,
        retryAfterMs: bucket.resetAt - now,
      };
    }

    return {
      ok: true,
      remaining: options.max - bucket.count,
      retryAfterMs: 0,
    };
  }

  return { check };
}