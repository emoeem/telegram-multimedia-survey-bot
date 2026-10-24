/**
 * Service-worker registration plus a one-time purge of the poisoned cache.
 *
 * The previous worker cached every same-origin GET, `/api/**` included, and
 * never revalidated. A single transient 401 or 500 response was then replayed
 * on every request — the admin panel kept showing "请求失败" / kept asking for a
 * fresh login, while opening the same URL in the address bar worked because
 * navigations took a different branch. The worker no longer touches API
 * traffic, and this purge clears the bad entries out of browsers that already
 * have them, so nobody has to clear site data by hand.
 */
const STALE_CACHE_PREFIX = "survey-platform-";
/** Keep in sync with the CACHE constant in public/sw.js. */
const CURRENT_CACHE = "survey-platform-v2";

export function initializePwa(): void {
  if (typeof window === "undefined") return;
  if (!import.meta.env.PROD || window.location.protocol !== "https:") return;
  if (!("serviceWorker" in navigator)) return;

  void navigator.serviceWorker.register("/sw.js").catch(() => {
    // Offline support is optional; a registration failure must not break the app.
  });
  void purgeStaleCaches();
}

async function purgeStaleCaches(): Promise<void> {
  if (!("caches" in window)) return;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(STALE_CACHE_PREFIX) && key !== CURRENT_CACHE)
        .map((key) => caches.delete(key)),
    );
  } catch {
    // Never block startup on cache cleanup.
  }
}
