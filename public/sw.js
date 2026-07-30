/* Hamar Mall service worker — Web Push + offline app shell.  (v3)
 *
 * OFFLINE: caches the app shell and its static bundles so the app OPENS and the
 * POS works with no connection — the cashier sees already-downloaded products,
 * rings up sales, and prints receipts; the sales are queued (lib/offlineQueue)
 * and uploaded by <SyncManager> when the connection returns.
 *
 * The caching fetch handler runs in PRODUCTION ONLY. In dev (localhost) it is
 * disabled so it can't fight Next.js / Turbopack HMR — the original reason this
 * worker avoided caching. API + Supabase requests are always network-only; the
 * app keeps its own localStorage data cache for offline reads.
 *
 * ── v3: why the app "stayed outside" ──────────────────────────────
 * v2 answered navigations with a plain `await fetch(req)` and no deadline. On a
 * weak or half-open mobile connection that promise doesn't reject — it hangs
 * until the browser's own network timeout, which can be 30s+. The launcher had
 * already dismissed the splash, so the user sat on a blank screen, gave up, and
 * relaunched (often several times) before one attempt happened to connect.
 *
 * v3 gives every navigation a hard deadline and falls back to the cached shell,
 * so the app opens in ~2.5s at worst, and instantly with no connection at all.
 */

const CACHE = 'hamarmall-shell-v3';
const OFFLINE_URL  = '/';
const OFFLINE_PAGE = '/offline.html';
const PRECACHE = ['/', OFFLINE_PAGE, '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

/* How long a navigation may wait for the network before we serve the cached
   shell instead. Short, because a cached answer is always available by then;
   the fresh copy still lands in the cache for next launch. */
const NAV_TIMEOUT_MS = 2500;
/* With nothing cached yet there's no fallback worth showing, so allow longer
   before giving up and rendering the offline page. */
const COLD_NAV_TIMEOUT_MS = 12000;

const host = self.location.hostname;
const CACHING_ENABLED = host !== 'localhost' && host !== '127.0.0.1';

/**
 * fetch() that actually rejects when the deadline passes.
 *
 * `input` must be a URL string for navigations: re-issuing a navigate Request
 * through `fetch(request, init)` throws ("Cannot construct a Request with a
 * Request whose mode is navigate"), which would break every launch.
 */
function fetchWithTimeout(input, ms, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  if (!CACHING_ENABLED) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Best-effort: don't fail the install if one asset 404s.
    await Promise.allSettled(PRECACHE.map((u) => cache.add(u)));
    // Eagerly pull the shell's hashed bundles too. Without this the app only
    // became usable offline on the SECOND visit, because v2 cached static
    // assets purely as a side effect of them being requested by a controlled
    // page — and the first visit is never controlled.
    await precacheShellAssets(cache);
  })());
});

/** Read the cached shell HTML and cache every /_next/static asset it links. */
async function precacheShellAssets(cache) {
  try {
    const shell = await cache.match(OFFLINE_URL);
    if (!shell) return;
    const html = await shell.clone().text();
    const urls = new Set();
    const re = /["'(](\/_next\/static\/[^"')\s]+?\.(?:js|css))["')]/g;
    let m;
    while ((m = re.exec(html))) urls.add(m[1]);
    await Promise.allSettled([...urls].map((u) => cache.add(u)));
  } catch { /* offline during install, or unparseable shell — harmless */ }
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop old shell caches from previous versions.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('hamarmall-shell-') && k !== CACHE).map((k) => caches.delete(k)));
    // Navigation preload lets the browser start the network request in parallel
    // with booting this worker, instead of after it.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch { /* unsupported */ }
    }
    await self.clients.claim();
  })());
});

/* ── Offline caching ───────────────────────────────────────────── */
function isStaticAsset(url) {
  return url.pathname.startsWith('/_next/static/')
    || url.pathname.startsWith('/icons/')
    || /\.(?:js|css|woff2?|png|jpg|jpeg|svg|webp|ico)$/.test(url.pathname);
}

/** Serve a navigation: fresh if the network is quick, cached shell otherwise. */
async function handleNavigate(event) {
  const cache  = await caches.open(CACHE);
  const cached = (await cache.match(OFFLINE_URL)) || (await cache.match('/'));
  const budget = cached ? NAV_TIMEOUT_MS : COLD_NAV_TIMEOUT_MS;

  try {
    // Prefer the browser's preloaded response when it beat us here.
    const preload = event.preloadResponse ? await withDeadline(event.preloadResponse, budget) : null;
    const fresh = preload || await fetchWithTimeout(event.request.url, budget, { credentials: 'include' });
    if (fresh && fresh.ok) {
      // Keep the shell (and its bundles) fresh for the next cold start.
      cache.put(OFFLINE_URL, fresh.clone()).then(() => precacheShellAssets(cache)).catch(() => {});
      return fresh;
    }
    if (fresh) return fresh;            // real 4xx/5xx — show the server's answer
  } catch { /* timed out, aborted or offline — fall through */ }

  if (cached) return cached;
  const offline = await cache.match(OFFLINE_PAGE);
  if (offline) return offline;
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>No connection</title>'
    + '<body style="font-family:system-ui;text-align:center;padding:3rem">'
    + '<h1>No internet connection</h1><p>Hamar Mall needs to connect once before it can work offline.</p>'
    + '<button onclick="location.reload()">Try again</button></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

/** Resolve `p`, or reject once `ms` have passed. */
function withDeadline(p, ms) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

self.addEventListener('fetch', (event) => {
  if (!CACHING_ENABLED) return;                // dev: let the network handle everything
  const req = event.request;
  if (req.method !== 'GET') return;            // never cache POST/PATCH/DELETE (orders, auth…)

  // Navigations (opening the app / a route) — handled even cross-origin-ish
  // redirects, so this check comes before the origin filter below.
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(event));
    return;
  }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Supabase, maps, images on other hosts
  if (url.pathname.startsWith('/api/')) return;       // dynamic data — always network

  // Immutable static bundles/assets: cache-first (this is what lets the app
  // actually RUN offline after one online visit).
  if (isStaticAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return hit || Response.error();
      }
    })());
  }
});

/* ── Web Push (unchanged) ──────────────────────────────────────── */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* non-JSON push */ }

  const title = data.title || 'Hamar Mall';
  const options = {
    body:  data.body || '',
    icon:  data.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag:   data.tag || undefined,
    data:  { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      for (const tab of tabs) {
        if ('focus' in tab) {
          tab.focus();
          if ('navigate' in tab && url !== '/') return tab.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
