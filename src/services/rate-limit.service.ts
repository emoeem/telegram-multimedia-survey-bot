/**
 * Coarse fixed-window rate limiting backed by the existing CACHE KV namespace.
 *
 * KV is eventually consistent, so a determined attacker can slightly exceed
 * the budget across PoPs; this is deliberate abuse damping for the public
 * survey endpoints, not an exact quota. Keys are per bucket+identity and the
 * counter expires with the window, so no cleanup job is needed.
 */
const RATE_LIMIT_PREFIX = "rl:v1";

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
  const key = `${RATE_LIMIT_PREFIX}:${bucket}:${identity}:${windowIndex}`;
  const retryAfterSeconds = Math.max(1, Math.ceil(((windowIndex + 1) * windowSeconds * 1000 - now) / 1000));

  const current = Number((await cache.get(key)) ?? "0");
  if (Number.isFinite(current) && current >= limit) {
    return { allowed: false, retryAfterSeconds };
  }
  // expirationTtl rounds up to 120s minimum on KV; the window key changes
  // every windowSeconds so stale counters never gate later windows.
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
