/*
 * Concord service worker (Feature 8 — installable PWA, offline shell).
 *
 * REGISTERED ONLY IN PRODUCTION BUILDS (src/components/pwa-registration.tsx
 * hard-gates on NODE_ENV) — a caching SW in dev would serve stale modules
 * and break HMR.
 *
 * Cache policy (per resource class, chosen for local-first correctness):
 *
 *   /_next/static/*   cache-first — immutable, content-hashed build output.
 *   /crdt-worker.js   NETWORK-FIRST with cache fallback. The client fetches
 *                     this with cache:'reload' specifically to avoid the
 *                     stale-engine bug (P7-M032: an old worker bundle against
 *                     a new page pinned pre-fix engine code across three
 *                     production rolls). The SW must keep that contract:
 *                     online always serves fresh; the cache only answers
 *                     offline so the editor keeps working.
 *   /wasm/*           NETWORK-FIRST with cache fallback — same reasoning:
 *                     the worker bundle and WASM binary must stay a
 *                     consistent pair, so both prefer the network and only
 *                     the offline path falls back (both then date from the
 *                     same deploy era).
 *   /api/*            NETWORK ONLY — auth/session and document API responses
 *                     are never cached (stale auth state is worse than an
 *                     honest offline failure).
 *   navigations       NETWORK-FIRST with same-URL cache fallback and
 *                     opportunistic cache fill (capped LRU). This is what
 *                     makes a previously-visited document actually open
 *                     offline: cached shell + cached engine + IndexedDB.
 *   everything else   NETWORK-FIRST with cache fallback (manifest, icons).
 *
 * Cross-origin traffic (the Rust gateway WS/HTTP, Clerk) is never
 * intercepted: only same-origin GET requests reach the handlers below.
 */

const VERSION = "v1";
const SHELL_CACHE = `concord-shell-${VERSION}`;
const STATIC_CACHE = `concord-static-${VERSION}`;
/** Bounded navigation cache: documents/routes kept for offline open. */
const MAX_NAVIGATION_ENTRIES = 30;

self.addEventListener("install", (event) => {
  // Nothing to precache at install: shells are cached opportunistically on
  // first visit, static assets on first use. Activate immediately so an
  // updated SW takes over without waiting for every tab to close.
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("concord-") && !name.endsWith(`-${VERSION}`))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isStaticAsset(url) {
  return url.pathname.startsWith("/_next/static/") || url.pathname === "/icon-192.png" || url.pathname === "/icon-512.png";
}

function isEngineAsset(url) {
  return url.pathname === "/crdt-worker.js" || url.pathname.startsWith("/wasm/");
}

async function trimNavigationCache() {
  const cache = await caches.open(SHELL_CACHE);
  const keys = await cache.keys();
  if (keys.length <= MAX_NAVIGATION_ENTRIES) return;
  // Response headers carry the fill timestamp; drop the oldest first.
  const entries = [];
  for (const request of keys) {
    const response = await cache.match(request);
    const filledAt = Number(response?.headers?.get("x-concord-cached-at") ?? 0);
    entries.push({ request, filledAt });
  }
  entries.sort((a, b) => a.filledAt - b.filledAt);
  for (const { request } of entries.slice(0, entries.length - MAX_NAVIGATION_ENTRIES)) {
    await cache.delete(request);
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const stamped = new Response(response.clone().body, response);
      stamped.headers.set("x-concord-cached-at", String(Date.now()));
      await cache.put(request, stamped);
      void trimNavigationCache();
    }
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // gateway/Clerk pass through
  if (request.cache === "only-if-cached") return;

  // API and session traffic: never cached (see policy header).
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
  if (isEngineAsset(url)) {
    // Network-first is the staleness contract for engine assets.
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }
  event.respondWith(networkFirst(request, SHELL_CACHE));
});
