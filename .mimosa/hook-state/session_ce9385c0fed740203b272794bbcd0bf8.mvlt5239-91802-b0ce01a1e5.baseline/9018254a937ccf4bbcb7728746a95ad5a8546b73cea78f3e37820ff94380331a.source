/**
 * Short-lived JSON cache backed by the CACHE KV namespace.
 *
 * The free D1 plan meters 5,000,000 rows read per account per day, shared with
 * every bot update and survey answer. Caching read-only, visitor-independent
 * payloads in KV moves those reads off D1 entirely, which is the cheapest way
 * to keep the account inside its budget. Failures degrade to a cache miss: a
 * broken cache must never break a request.
 */
export async function readCachedJson<T>(cache: KVNamespace | undefined, key: string): Promise<T | null> {
  if (!cache) return null;
  try {
    const raw = await cache.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (error) {
    console.warn("Cached JSON read failed", { key, error });
    return null;
  }
}

export async function writeCachedJson(
  cache: KVNamespace | undefined,
  key: string,
  value: unknown,
  expirationTtlSeconds: number,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(key, JSON.stringify(value), { expirationTtl: expirationTtlSeconds });
  } catch (error) {
    console.warn("Cached JSON write failed", { key, error });
  }
}
