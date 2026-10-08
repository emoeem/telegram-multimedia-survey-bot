/**
 * Public API abuse damping.
 *
 * The new interface hashes the subject before it becomes part of a KV key, so
 * raw email addresses and IPs never become persistent KV key material. KV is
 * eventually consistent and the counter uses get-then-put because this bot's
 * current concurrency does not justify a more expensive atomic backend here.
 */
const RATE_LIMIT_PREFIX = "ratelimit:v1";

export interface RateLimiter {
  /** 未超限返回 true，并已记录本次请求；超限返回 false。 */
  allow(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function subjectHash(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

export function createKVRateLimiter(cache: KVNamespace): RateLimiter {
  return {
    async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
      if (limit <= 0 || windowSeconds <= 0) return false;

      try {
        const separator = key.indexOf("|");
        const scope = separator >= 0 ? key.slice(0, separator) : key;
        const subject = separator >= 0 ? key.slice(separator + 1) : key;
        const hashed = await subjectHash(subject);
        const kvKey = `${RATE_LIMIT_PREFIX}:${scope}:${hashed}`;
        const current = Number((await cache.get(kvKey)) ?? "0");
        if (!Number.isFinite(current) || current < 0) {
          console.warn("Public API rate limiter counter was invalid; allowing request", { kvKey });
          return true;
        }
        if (current >= limit) return false;

        // This is intentionally get-then-put rather than D1-backed atomic
        // increment: public API concurrency is currently low enough that the
        // simpler KV path is the better availability/cost trade-off.
        await cache.put(kvKey, String(current + 1), { expirationTtl: windowSeconds });
        return true;
      } catch (error) {
        // Rate limiting must never become an availability dependency. A KV
        // outage therefore fails open and leaves an auditable warning.
        console.warn("Public API rate limiter unavailable; allowing request", error);
        return true;
      }
    },
  };
}

export function createMemoryRateLimiter(): RateLimiter {
  const windows = new Map<string, { count: number; expiresAt: number }>();

  return {
    async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
      const now = Date.now();
      const current = windows.get(key);
      if (!current || current.expiresAt <= now) {
        windows.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
        return true;
      }
      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    },
  };
}

/**
 * Legacy fixed-window limiter kept for existing endpoint-specific abuse
 * damping. New high-value public API guards should use RateLimiter above.
 */
const LEGACY_RATE_LIMIT_PREFIX = "rl:v1";

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets (for Retry-After). */
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  cache: KVNamespace,
  bucket: string,
  identity: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const windowIndex = Math.floor(now / (windowSeconds * 1000));
  const key = `${LEGACY_RATE_LIMIT_PREFIX}:${bucket}:${identity}:${windowIndex}`;
  const retryAfterSeconds = Math.max(1, Math.ceil(((windowIndex + 1) * windowSeconds * 1000 - now) / 1000));
  if (!cache) return { allowed: true, retryAfterSeconds };

  const current = Number((await cache.get(key)) ?? "0");
  if (Number.isFinite(current) && current >= limit) {
    return { allowed: false, retryAfterSeconds };
  }
  await cache.put(key, String(current + 1), {
    expirationTtl: Math.max(120, windowSeconds * 2),
  });
  return { allowed: true, retryAfterSeconds };
}

export function rateLimitResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { code: "rate_limited", message: "操作过于频繁，请稍后再试" },
    {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds) },
    },
  );
}

/**
 * Atomic fixed-window rate limiter backed by the `rate_limits` D1 table.
 */
export async function checkAtomicRateLimit(
  db: D1Database,
  cache: KVNamespace,
  bucket: string,
  identity: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const windowIndex = Math.floor(now / (windowSeconds * 1000));
  const windowStart = windowIndex * windowSeconds * 1000;
  const key = `${bucket}:${identity}`;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowSeconds * 1000 - now) / 1000));

  try {
    const result = await db
      .prepare(
        `INSERT INTO rate_limits (key, count, window_start)
         VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE
             WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1
             ELSE 1
           END,
           window_start = excluded.window_start
         RETURNING count`,
      )
      .bind(key, windowStart)
      .first<{ count: number }>();

    const count = Number(result?.count ?? 1);
    return { allowed: count <= limit, retryAfterSeconds };
  } catch (error) {
    console.warn("Atomic rate limit unavailable; falling back to KV", { bucket, error });
    return checkRateLimit(cache, bucket, identity, limit, windowSeconds, now);
  }
}
