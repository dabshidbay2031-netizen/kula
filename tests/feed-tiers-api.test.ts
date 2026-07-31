// @vitest-environment node
/**
 * /api/settings/feed-tiers — the admin write path for Explore ranking.
 *
 * Two things must hold no matter what:
 *   • GET is public and NEVER throws — a missing site_settings row (or a dead
 *     DB) has to degrade to empty tiers, because empty tiers rank the feed
 *     exactly as it ranked before this feature existed. A settings failure
 *     must not be able to empty the storefront.
 *   • PUT is full-admin only. It writes global storefront ranking, including
 *     the power to HIDE any store's products from discovery — a semi_admin
 *     (view-only) or a signed-in shopper must not reach it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* Test-controlled state */
let authedUser: { id: string; email: string | null } | null = null;
let adminRole: 'admin' | 'semi_admin' | null = null;
let storedValue: unknown = null;      // what the site_settings row holds
// Simulate a missing/broken `site_settings` table ONLY — the `admins` lookup
// must keep working, or the auth gate 401s and we never exercise the write path.
let dbThrows = false;
let upserted: Record<string, unknown> | null = null;  // what PUT wrote

vi.mock('@/lib/realtimeServer', () => ({ pingRealtime: () => {} }));

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'insert', 'delete']) {
    b[m] = () => b;
  }
  const broken = dbThrows && table === 'site_settings';
  b.upsert = (row: Record<string, unknown>) => {
    if (broken) return Promise.resolve({ error: { message: 'relation does not exist' } });
    upserted = row;
    return Promise.resolve({ error: null });
  };
  b.maybeSingle = () => {
    if (broken) throw new Error('relation "site_settings" does not exist');
    return Promise.resolve(
      table === 'admins' ? { data: adminRole ? { role: adminRole } : null, error: null }
                         : { data: storedValue === null ? null : { value: storedValue }, error: null });
  };
  (b as { then?: unknown }).then =
    (res: (v: unknown) => void) => Promise.resolve({ data: [], error: null, count: 0 }).then(res);
  return b;
}

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    auth: {
      getUser: async (token: string) =>
        token && authedUser ? { data: { user: authedUser }, error: null }
                            : { data: { user: null }, error: { message: 'invalid token' } },
    },
    from: (table: string) => makeBuilder(table),
  }),
}));

import { GET, PUT } from '@/app/api/settings/feed-tiers/route';

const url = 'http://test/api/settings/feed-tiers';
const put = (body: unknown, auth = true) => new Request(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer test-jwt' } : {}) },
  body: JSON.stringify(body),
});

beforeEach(() => {
  authedUser = null; adminRole = null; storedValue = null; dbThrows = false; upserted = null;
});

describe('GET is public and always safe', () => {
  it('returns empty tiers when the row is missing', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('returns empty tiers when the TABLE is missing (migration not run)', async () => {
    dbThrows = true;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('returns the stored config, sanitized', async () => {
    storedValue = { stores: { '7': 'low', '9': 'bogus' }, capPer10: 2 };
    const body = await (await GET()).json();
    expect(body.stores).toEqual({ '7': 'low' });   // unknown value dropped
    expect(body.capPer10).toBe(2);
  });

  it('clamps an out-of-range cap rather than serving it', async () => {
    storedValue = { capPer10: 99 };
    expect((await (await GET()).json()).capPer10).toBe(9);
  });
});

describe('PUT is full-admin only', () => {
  it('anonymous → 401', async () => {
    expect((await PUT(put({ stores: { '1': 'low' } }, false))).status).toBe(401);
  });

  it('signed-in non-admin → 401', async () => {
    authedUser = { id: 'shopper', email: 's@x.com' };
    expect((await PUT(put({ stores: { '1': 'low' } }))).status).toBe(401);
  });

  it('semi_admin (view-only) → 403, nothing written', async () => {
    authedUser = { id: 'viewer', email: null }; adminRole = 'semi_admin';
    expect((await PUT(put({ stores: { '1': 'hidden' } }))).status).toBe(403);
    expect(upserted).toBeNull();
  });

  it('full admin → 200 and persists', async () => {
    authedUser = { id: 'boss', email: null }; adminRole = 'admin';
    const res = await PUT(put({ stores: { '4': 'reduced' }, subs: { seasonings: 'low' }, capPer10: 2 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stores).toEqual({ '4': 'reduced' });
    expect(body.subs).toEqual({ seasonings: 'low' });
    expect(body.capPer10).toBe(2);
    expect((upserted as { key: string }).key).toBe('feed_tiers');
  });

  it('stamps updatedAt so the admin can see when rules last changed', async () => {
    authedUser = { id: 'boss', email: null }; adminRole = 'admin';
    const body = await (await PUT(put({ stores: { '4': 'low' } }))).json();
    expect(typeof body.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);
  });
});

describe('PUT validates the payload', () => {
  beforeEach(() => { authedUser = { id: 'boss', email: null }; adminRole = 'admin'; });

  it('rejects an unknown tier value instead of silently dropping it', async () => {
    const res = await PUT(put({ stores: { '4': 'hiden' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid tier/i);
    expect(upserted).toBeNull();
  });

  it('rejects invalid JSON → 400', async () => {
    const bad = new Request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
      body: '{not json',
    });
    expect((await PUT(bad)).status).toBe(400);
  });

  it('clamps the cap to 1–9 on write', async () => {
    const body = await (await PUT(put({ capPer10: 0 }))).json();
    expect(body.capPer10).toBe(1);
  });

  it('an empty body saves cleanly (clearing every rule)', async () => {
    const res = await PUT(put({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stores).toBeUndefined();
    expect(body.products).toBeUndefined();
  });

  it('surfaces a DB failure as 500, not a silent success', async () => {
    dbThrows = true;
    const res = await PUT(put({ stores: { '4': 'low' } }));
    expect(res.status).toBe(500);
  });
});
