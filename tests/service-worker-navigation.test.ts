/**
 * Service worker — how the app OPENS.
 *
 * The launcher hands a navigation to the worker and then gets out of the way,
 * so whatever this handler does IS the app's startup time. v2 awaited the
 * network with no deadline: on a weak connection the promise neither resolved
 * nor rejected, and the user stared at a blank screen until the browser's own
 * timeout — the "it stays outside, I have to open it three times" report.
 *
 * These tests run the real public/sw.js in a sandbox with a fake network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

const SW_SOURCE = readFileSync(path.resolve(__dirname, '../public/sw.js'), 'utf8');

interface FetchEvent {
  request: { method: string; mode: string; url: string };
  preloadResponse?: Promise<Response | undefined>;
  respondWith: (p: Promise<Response>) => void;
}

/** Boot sw.js against a fake ServiceWorkerGlobalScope and return its hooks. */
function loadWorker(opts: {
  /** What the network does for a navigation. */
  network: 'hangs' | 'fails' | 'ok';
  /** What the shell cache already holds. */
  cached: Record<string, string>;
}) {
  const listeners: Record<string, (e: unknown) => void> = {};

  const store = new Map<string, Response>(
    Object.entries(opts.cached).map(([k, v]) => [k, new Response(v, { status: 200 })]),
  );

  const cache = {
    match: async (req: string | { url: string }) =>
      store.get(typeof req === 'string' ? req : req.url),
    put:   async (k: string, v: Response) => { store.set(k, v); },
    add:   async () => {},
    addAll: async () => {},
  };

  const sandboxFetch = vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
    if (opts.network === 'ok') return Promise.resolve(new Response('<html>fresh</html>', { status: 200 }));
    if (opts.network === 'fails') return Promise.reject(new TypeError('Failed to fetch'));
    // 'hangs': never settles on its own — only the abort signal ends it, which
    // is precisely what the old worker had no way to trigger.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
    });
  });

  const self = {
    location: { hostname: 'www.hamarmall.com', origin: 'https://www.hamarmall.com' },
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
    registration: { navigationPreload: { enable: async () => {} }, showNotification: async () => {} },
  };

  runInNewContext(SW_SOURCE, {
    self,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: sandboxFetch,
    Response, Request, URL, AbortController, TypeError, Promise, Error,
    setTimeout, clearTimeout, console,
  });

  return { listeners, sandboxFetch, store };
}

/** Drive a navigation through the worker and return what it answered with. */
function navigate(listeners: Record<string, (e: unknown) => void>, url = 'https://www.hamarmall.com/') {
  let answered!: Promise<Response>;
  const event: FetchEvent = {
    request: { method: 'GET', mode: 'navigate', url },
    preloadResponse: Promise.resolve(undefined),
    respondWith: (p) => { answered = p; },
  };
  listeners.fetch(event);
  return answered;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('opening the app', () => {
  it('falls back to the cached shell instead of hanging on a dead network', async () => {
    const { listeners } = loadWorker({
      network: 'hangs',
      cached: { '/': '<html>cached shell</html>' },
    });

    const answered = navigate(listeners);

    // Before the deadline the worker is still hoping for the network…
    let settled = false;
    answered.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);

    // …and past it, the cached shell is served rather than an endless wait.
    await vi.advanceTimersByTimeAsync(1000);
    const res = await answered;
    expect(await res.text()).toContain('cached shell');
  });

  it('serves the offline page when nothing is cached and the network is down', async () => {
    const { listeners } = loadWorker({
      network: 'fails',
      cached: { '/offline.html': '<html>No internet connection</html>' },
    });

    const res = await navigate(listeners);
    expect(await res.text()).toContain('No internet connection');
  });

  it('never leaves a navigation unanswered, even with an empty cache', async () => {
    const { listeners } = loadWorker({ network: 'fails', cached: {} });

    const res = await navigate(listeners);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('No internet connection');
  });

  it('prefers the fresh page and refreshes the cached shell when the network is healthy', async () => {
    const { listeners, store } = loadWorker({
      network: 'ok',
      cached: { '/': '<html>stale shell</html>' },
    });

    const res = await navigate(listeners);
    expect(await res.text()).toContain('fresh');

    await vi.advanceTimersByTimeAsync(0);
    expect(await store.get('/')!.text()).toContain('fresh');
  });

  it('re-requests the navigation by URL, never by Request object', async () => {
    // fetch(navigateRequest, init) throws "Cannot construct a Request with a
    // Request whose mode is navigate" — doing that would break every launch.
    const { listeners, sandboxFetch } = loadWorker({ network: 'ok', cached: {} });

    await navigate(listeners);

    expect(sandboxFetch).toHaveBeenCalled();
    expect(typeof sandboxFetch.mock.calls[0][0]).toBe('string');
  });
});
