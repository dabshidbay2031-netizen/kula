// @vitest-environment node
/**
 * Conditional polling. The point is not just bandwidth: `changed: false` is
 * what lets a view SKIP setState, so an unchanged poll causes no re-render,
 * no flicker and no lost scroll position.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pollFetch, invalidatePoll } from '@/lib/pollFetch';

let calls: { url: string; ifNoneMatch: string | null }[] = [];
let nextEtag = '"v1"';
let nextBody: unknown = [{ id: 1 }];
let nextStatus = 200;
let failWith: Error | null = null;

beforeEach(() => {
  calls = []; nextEtag = '"v1"'; nextBody = [{ id: 1 }]; nextStatus = 200; failWith = null;
  invalidatePoll('/');           // clear the module cache between tests

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers ?? {});
    calls.push({ url: String(url), ifNoneMatch: h.get('If-None-Match') });
    if (failWith) throw failWith;

    // Behave like a real ETag server.
    if (h.get('If-None-Match') === nextEtag && nextStatus === 200) {
      return new Response(null, { status: 304, headers: { ETag: nextEtag } });
    }
    if (nextStatus !== 200) {
      return new Response(JSON.stringify({ error: 'boom' }), { status: nextStatus });
    }
    return new Response(JSON.stringify(nextBody), {
      status: 200, headers: { ETag: nextEtag, 'Content-Type': 'application/json' },
    });
  });
});

describe('first fetch', () => {
  it('sends no validator and returns the data', async () => {
    const r = await pollFetch<{ id: number }[]>('/api/orders');
    expect(calls[0].ifNoneMatch).toBeNull();
    expect(r.changed).toBe(true);
    expect(r.data).toEqual([{ id: 1 }]);
  });
});

describe('repeat poll with nothing changed', () => {
  it('sends If-None-Match and reports changed:false', async () => {
    await pollFetch('/api/orders');
    const r = await pollFetch('/api/orders');
    expect(calls[1].ifNoneMatch).toBe('"v1"');
    expect(r.status).toBe(304);
    expect(r.changed).toBe(false);
    expect(r.ok).toBe(true);
    // No body to parse — the caller must keep its existing state.
    expect(r.data).toBeNull();
  });
});

describe('when the data actually changes', () => {
  it('returns the new payload', async () => {
    await pollFetch('/api/orders');
    nextEtag = '"v2"'; nextBody = [{ id: 1 }, { id: 2 }];
    const r = await pollFetch<{ id: number }[]>('/api/orders');
    expect(r.changed).toBe(true);
    expect(r.data).toHaveLength(2);
  });
});

describe('cache scoping', () => {
  it('keeps a separate validator per URL', async () => {
    await pollFetch('/api/orders?supplierId=1');
    await pollFetch('/api/orders?supplierId=2');
    expect(calls[1].ifNoneMatch).toBeNull();   // different URL, no validator yet
  });

  it('force skips the validator for a user-initiated refresh', async () => {
    await pollFetch('/api/orders');
    await pollFetch('/api/orders', {}, { force: true });
    expect(calls[1].ifNoneMatch).toBeNull();
  });

  it('invalidatePoll drops the validator by prefix', async () => {
    await pollFetch('/api/orders?supplierId=1');
    invalidatePoll('/api/orders');
    await pollFetch('/api/orders?supplierId=1');
    expect(calls[1].ifNoneMatch).toBeNull();
  });
});

describe('failures never wipe good data', () => {
  it('a network error reports changed:false, not an empty list', async () => {
    failWith = new Error('offline');
    const r = await pollFetch('/api/orders');
    expect(r.changed).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.data).toBeNull();
  });

  it('a 500 reports changed:false and not-ok', async () => {
    nextStatus = 500;
    const r = await pollFetch('/api/orders');
    expect(r.changed).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('does not cache a validator from an endpoint that sends none', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const h = new Headers(init.headers ?? {});
      calls.push({ url: String(url), ifNoneMatch: h.get('If-None-Match') });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await pollFetch('/api/no-etag');
    await pollFetch('/api/no-etag');
    expect(calls[1].ifNoneMatch).toBeNull();
  });
});
