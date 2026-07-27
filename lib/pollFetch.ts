'use client';

/**
 * Conditional polling.
 *
 * The live screens re-fetch every 30s with `cache: 'no-store'`, which sends no
 * validator — so the FULL list crossed the wire every time, and the view then
 * called setState with a brand-new array. Two costs:
 *
 *   1. bandwidth — the whole order/invoice list again, on a mobile connection
 *   2. a wasted React re-render of the entire list even when nothing changed,
 *      which is what made the app feel sluggish and made lists flicker
 *
 * This sends `If-None-Match`. On a 304 the caller gets `changed: false` and
 * must NOT touch state — no re-render, no flicker, no scroll reset.
 *
 * The ETag cache is per-URL and in-memory, so it dies with the tab; a reload
 * always gets a fresh copy.
 */

interface Entry { etag: string; }
const cache = new Map<string, Entry>();

export interface PollResult<T> {
  /** False when the server said 304 — leave state exactly as it is. */
  changed: boolean;
  data:    T | null;
  ok:      boolean;
  status:  number;
  headers: Headers | null;
}

/**
 * GET `url`, returning `changed: false` when the payload is byte-identical to
 * the last one this tab received.
 *
 * `force` skips the validator — use it for a user-initiated refresh, where
 * "nothing changed" should still feel like it did something.
 */
export async function pollFetch<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: { force?: boolean } = {},
): Promise<PollResult<T>> {
  const prev = opts.force ? undefined : cache.get(url);
  const headers = new Headers(init.headers ?? {});
  if (prev) headers.set('If-None-Match', prev.etag);

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, cache: 'no-store' });
  } catch {
    // Offline / aborted — behave like "nothing changed" so a blip never wipes
    // good data off the screen.
    return { changed: false, data: null, ok: false, status: 0, headers: null };
  }

  if (res.status === 304) {
    return { changed: false, data: null, ok: true, status: 304, headers: res.headers };
  }

  if (!res.ok) {
    // A failure must not be mistaken for an empty result.
    return { changed: false, data: null, ok: false, status: res.status, headers: res.headers };
  }

  const etag = res.headers.get('ETag');
  if (etag) cache.set(url, { etag });
  else cache.delete(url);      // endpoint stopped sending one — don't reuse a stale validator

  let data: T | null = null;
  try { data = (await res.json()) as T; } catch { data = null; }

  return { changed: true, data, ok: true, status: res.status, headers: res.headers };
}

/** Drop a cached validator (e.g. right after a local write, to force a refetch). */
export function invalidatePoll(urlPrefix: string): void {
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(urlPrefix)) cache.delete(key);
  }
}
