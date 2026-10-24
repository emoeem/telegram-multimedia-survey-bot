/**
 * Offline shell for the survey/platform UI.
 *
 * History: this worker used to run every same-origin GET through
 * "cache first, never revalidate" — including `/api/**`. One transient 401 or
 * 500 therefore got cached and replayed forever, which looked like an admin
 * panel that kept demanding a fresh login while the very same URL opened fine
 * from the address bar (that request was a navigation and took the other
 * branch). API traffic must never be cached here.
 */
const CACHE = "survey-platform-v2";
const PRECACHE = ["/", "/survey.html", "/manifest.webmanifest"];

// Live data and liveness probes: always network, never cache.
const NEVER_CACHE_PREFIXES = ["/api/", "/telegram/", "/health"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // cache.addAll() is atomic: one failing request (a transient 5xx during a
  // deploy, say) would abort the whole install and leave the *old* worker in
  // place — the exact situation where a fix cannot reach the browser. Add each
  // entry on its own and let the offline shell be partially filled.
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url)))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match(request)
          .then((response) => response || caches.match("/survey.html"))
          .then((response) => response || caches.match("/")),
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Only successful, same-origin, complete responses are worth caching.
        if (response.ok && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
