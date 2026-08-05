// Web Push notification handling, plus just enough offline app-shell
// caching that the page itself (not the chat data — that's IndexedDB's job,
// see offlineDb.js) still loads with no connection.
//
// There's no build-time precache manifest here on purpose: Vite's output
// filenames are content-hashed per build, so a static list would go stale
// the moment the app is rebuilt. Instead every same-origin GET the page
// actually makes gets cached as it's seen (runtime caching) — the first
// online visit after a deploy "warms" the cache with whatever that build's
// real filenames are, no build step needed to keep this file in sync.

const SHELL_CACHE = "talkex-shell-v4";

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for every open tab to close
  // once — nothing cached yet is stale, so there is nothing the usual "wait
  // for the old worker to finish" caution protects here.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Drop any cache from a previous SHELL_CACHE name — bumping the
      // version string above (on a breaking change to this file) is what
      // triggers a clean slate instead of an ever-growing pile of caches.
      caches.keys().then((names) =>
        Promise.all(names.filter((name) => name !== SHELL_CACHE).map((name) => caches.delete(name)))
      ),
    ])
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only ever cache reads of our own static files. A write (POST/PATCH/
  // DELETE) must always hit the real server, and anything cross-origin —
  // which includes every API call, since the backend runs on its own
  // port/origin — is left completely alone. That exclusion is also what
  // keeps this cache nowhere near the view-once download gate: that
  // endpoint lives on the API origin, so this fetch handler never even
  // sees those requests.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A full-page navigation (opening/reloading the app itself): try the
  // network first for the freshest shell, fall back to whatever was cached
  // last, and fall back again to the cached root if this exact URL was
  // never visited before (a deep link opened for the first time offline).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Clone BEFORE anything else touches this response — a Response
          // body can only ever be read once; cloning it after the caller
          // (or another handler racing on the same underlying stream) has
          // already started consuming it throws "body is already used."
          // Cloning first and working only with clones from here on is the
          // standard fix. cache.put() is also given its own .catch(): it
          // rejects outright on some responses (opaque cross-origin,
          // certain redirects) and an unhandled rejection in a fire-and-
          // forget promise like this one surfaces as a console error for a
          // cache write nobody needs to be told failed.
          const forCache = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, forCache)).catch(() => {});
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("/"))
        )
    );
    return;
  }

  // Everything else same-origin (the JS/CSS bundle, icons, fonts): cache-
  // first, since these are content-hashed and immutable once built — a
  // cached copy is never stale. Still refreshes the cache in the background
  // off a live network hit, so a follow-up deploy's new hashed filenames
  // get picked up the next time they're actually requested.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            // See the navigate handler above for why clone-first and the
            // separate .catch() both matter here.
            const forCache = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, forCache)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// Background Sync: the browser's promise to retry a registered tag once
// connectivity is back, even if that happens after the tab that registered
// it was backgrounded (not necessarily closed — Chrome/Android is the
// realistic audience here; Safari doesn't implement this API at all and
// silently never registers it, see requestBackgroundSync() in api.js).
//
// This handler deliberately does NOT try to redo the actual network work
// itself. A service worker has no access to localStorage (only a page/tab
// does), and the auth token this app needs for every request lives there —
// so it has no way to make an authenticated request on its own. What it CAN
// do is wake up and tell every open tab to run ITS OWN flush, which already
// has the token and already knows exactly how to replay every queue
// correctly. If no tab is open at all, there's nothing this can do — which
// is the honest limit of what a browser tab (as opposed to a native app
// with real OS-level background execution) can ever promise here.
self.addEventListener("sync", (event) => {
  if (event.tag !== "talkex-flush") return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) client.postMessage({ type: "flush" });
    })
  );
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "TalkEx", body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "TalkEx", {
      body: payload.body || "",
      data: payload.data || {},
      // One notification per chat replaces the last rather than stacking —
      // five separate OS notifications for five messages in the same
      // conversation is noise; the badge/body already says what's new.
      tag: payload.data?.chat_id || "talkex",
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientsList[0];
      if (existing) {
        existing.focus();
        return;
      }
      await self.clients.openWindow("/");
    })()
  );
});
