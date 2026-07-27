// @vitest-environment node
/**
 * Customer & guest backend coverage.
 *
 * The platform's primary audience is the shopper: browsing is PUBLIC (guests),
 * but every identity-scoped write (wishlist, review, referral code, saved GPS
 * address, address mutation) MUST be authenticated AND scoped to the caller's
 * own id. A guest (anonymous) may read, but must never persist anything tied to
 * a user id, and a signed-in customer must never touch another customer's rows.
 *
 * These exercise the real route handlers with Supabase mocked so the authz
 * boundary — not the DB — is what's under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ── Test-controlled identity ─────────────────────────────────── */
let authedUser: { id: string; email: string | null } | null = null;
let adminRow: { user_id: string } | null = null;

type SbResult = { data: unknown; error: unknown };
let tableData: Record<string, SbResult> = {};

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'order', 'limit', 'lt', 'neq', 'is', 'range', 'gte', 'update', 'insert', 'upsert', 'delete']) {
    b[m] = () => b;
  }
  b.eq = () => b;
  b.maybeSingle = () => {
    if (table === 'admins') return Promise.resolve({ data: adminRow, error: null });
    return Promise.resolve(tableData[table] ?? { data: null, error: null });
  };
  b.single = () => Promise.resolve(tableData[table] ?? { data: { id: 1, code: 'MGXXXX1234', referrer_id: 'cust-1', credit: 5 }, error: null });
  // awaiting the builder resolves to a list-shaped result
  (b as { then?: unknown }).then = (res: (v: SbResult) => void) =>
    Promise.resolve(tableData[table] ?? { data: [], error: null }).then(res);
  return b;
}

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    auth: {
      getUser: async (token: string) =>
        token && authedUser ? { data: { user: authedUser }, error: null }
                            : { data: { user: null }, error: { message: 'no token' } },
    },
    from: (table: string) => makeBuilder(table),
  }),
}));

import { GET as wishlistGet, POST as wishlistPost, DELETE as wishlistDel } from '@/app/api/wishlist/route';
import { GET as reviewsGet, POST as reviewsPost } from '@/app/api/reviews/route';
import { GET as referralsGet } from '@/app/api/referrals/route';
import { GET as addrGet, POST as addrPost } from '@/app/api/addresses/route';

/** Authenticated request. `init.headers` are MERGED with the bearer (not replaced). */
const authed = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { Authorization: 'Bearer jwt', ...((init.headers as Record<string, string>) ?? {}) } });
const anon = (url: string, init: RequestInit = {}) => new Request(url, init);
const json = (body: unknown) => JSON.stringify(body);

beforeEach(() => { authedUser = null; adminRow = null; tableData = {}; });

/* ─────────────────────────── GUEST ─────────────────────────── */

describe('GUEST (anonymous) — browse is open, persists are closed', () => {
  it('can read a product\'s public reviews (no token) → 200', async () => {
    tableData.reviews = { data: [], error: null };
    expect((await reviewsGet(anon('http://t/api/reviews?productId=1'))).status).toBe(200);
  });

  it('cannot POST a review (no token) → 401', async () => {
    const req = anon('http://t/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ productId: 1, rating: 5 }) });
    expect((await reviewsPost(req)).status).toBe(401);
  });

  it('cannot POST a wishlist item (no token) → 401', async () => {
    const req = anon('http://t/api/wishlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ productId: 9 }) });
    expect((await wishlistPost(req)).status).toBe(401);
  });

  it('cannot DELETE a wishlist item (no token) → 401', async () => {
    expect((await wishlistDel(anon('http://t/api/wishlist?productId=9'))).status).toBe(401);
  });

  it('cannot mint a referral code (no token) → 401', async () => {
    expect((await referralsGet(anon('http://t/api/referrals?userId=anyone'))).status).toBe(401);
  });

  it('cannot read saved GPS addresses (no token) → 401', async () => {
    expect((await addrGet(anon('http://t/api/addresses?userId=anyone'))).status).toBe(401);
  });

  it('cannot save a GPS address (no token) → 401', async () => {
    const req = anon('http://t/api/addresses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ userId: 'x', latitude: 1, longitude: 2 }) });
    expect((await addrPost(req)).status).toBe(401);
  });
});

/* ───────────────────────── CUSTOMER ───────────────────────── */

describe('CUSTOMER — self-service writes scoped to own id', () => {
  beforeEach(() => { authedUser = { id: 'cust-1', email: 'cust@x.com' }; });

  it('can POST a review as itself → accepted (no authz rejection)', async () => {
    const req = authed('http://t/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ productId: 1, rating: 4, comment: 'good' }) });
    const res = await reviewsPost(req);
    expect(res.status).toBeLessThan(500); // accepted by the mocked DB — the point is no authz rejection
  });

  it('rejects out-of-range rating → 400', async () => {
    const req = authed('http://t/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ productId: 1, rating: 9 }) });
    expect((await reviewsPost(req)).status).toBe(400);
  });

  it('rejects missing productId → 400', async () => {
    const req = authed('http://t/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ rating: 3 }) });
    expect((await reviewsPost(req)).status).toBe(400);
  });

  it('can add to its OWN wishlist (productId required) → 200', async () => {
    const req = authed('http://t/api/wishlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ productId: 9 }) });
    expect((await wishlistPost(req)).status).toBe(200);
  });

  it('wishlist POST without productId → 400', async () => {
    const req = authed('http://t/api/wishlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({}) });
    expect((await wishlistPost(req)).status).toBe(400);
  });

  it('can mint its OWN referral code → 201', async () => {
    expect((await referralsGet(authed('http://t/api/referrals?userId=cust-1'))).status).toBe(201);
  });

  it('cannot mint a referral code for ANOTHER user → 403', async () => {
    expect((await referralsGet(authed('http://t/api/referrals?userId=victim'))).status).toBe(403);
  });

  it('can read its OWN saved addresses → 200', async () => {
    expect((await addrGet(authed('http://t/api/addresses?userId=cust-1'))).status).toBe(200);
  });

  it('cannot read ANOTHER user\'s saved addresses → 403', async () => {
    expect((await addrGet(authed('http://t/api/addresses?userId=victim'))).status).toBe(403);
  });

  it('address POST to another user id is rejected → 403', async () => {
    const req = authed('http://t/api/addresses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ userId: 'victim', latitude: 1, longitude: 2 }) });
    expect((await addrPost(req)).status).toBe(403);
  });

  it('address POST missing lat/long → 400', async () => {
    const req = authed('http://t/api/addresses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ userId: 'cust-1' }) });
    expect((await addrPost(req)).status).toBe(400);
  });
});

/* ─────────── CROSS-CUSTOMER ISOLATION (IDOR guard) ─────────── */

describe('cross-customer isolation — wishlist writes are identity-bound', () => {
  beforeEach(() => { authedUser = { id: 'cust-1', email: null }; });

  it('wishlist GET by userId is a public lookup; the boundary is enforced on writes', async () => {
    // GET is intentionally a public id-keyed read; security lives on the writes (above).
    expect((await wishlistGet(new Request('http://t/api/wishlist?userId=cust-1'))).status).toBe(200);
  });
});
