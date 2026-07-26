// @vitest-environment node
/**
 * Business-logic coverage for previously-untested money paths:
 *  - legacy order placement (the JS fallback used when the place_order RPC
 *    is absent) still prices server-side from the DB and inserts the order
 *  - reviews upsert maps to the client shape
 *  - coupon validation: valid / not-found / expired / below-minimum
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Res = { data: unknown; error: unknown };
let tables: Record<string, Res> = {};
let inserted: Record<string, unknown> = {};
let rpcResult: Res = { data: null, error: { code: 'PGRST202', message: 'function place_order not found' } };

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'delete', 'neq', 'is', 'lt', 'range', 'gte']) {
    b[m] = () => b;
  }
  b.insert = (payload: unknown) => { inserted[table] = payload; return b; };
  b.upsert = (payload: unknown) => { inserted[table] = payload; return b; };
  b.maybeSingle = () => Promise.resolve(tables[table] ?? { data: null, error: null });
  // insert(...).select().single() echoes the inserted row (with an id) so the
  // response reflects the SERVER-computed values, not anything client-sent.
  b.single = () => Promise.resolve(
    inserted[table] !== undefined
      ? { data: { id: `${table.toUpperCase()}-1`, ...(inserted[table] as object) }, error: null }
      : (tables[table] ?? { data: null, error: null }));
  (b as { then?: unknown }).then = (res: (v: Res) => void) =>
    Promise.resolve(tables[table] ?? { data: [], error: null }).then(res);
  return b;
}

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    // reviews POST now requires an authenticated caller (requireUser)
    auth: { getUser: async (t: string) => (t ? { data: { user: { id: 'u1' } }, error: null } : { data: { user: null }, error: { message: 'no token' } }) },
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve(rpcResult),
  }),
}));

import { POST as ordersPost } from '@/app/api/orders/route';
import { POST as reviewsPost } from '@/app/api/reviews/route';
import { POST as couponValidate } from '@/app/api/coupons/validate/route';

const json = (path: string, fn: (r: Request) => Promise<Response>, body: unknown) =>
  fn(new Request(`http://test/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  tables = {};
  inserted = {};
  rpcResult = { data: null, error: { code: 'PGRST202', message: 'function place_order not found' } };
});

describe('legacy order placement (RPC absent)', () => {
  it('prices server-side from the DB and inserts the order → 201', async () => {
    // DB says the product costs $10; client could claim anything — ignored.
    tables.products = { data: [{ id: 1, price: 10, stock: 5, sold: 0 }], error: null };
    const res = await json('api/orders', ordersPost, {
      customerName: 'Hodan', items: [{ id: 1, qty: 2 }], paymentMethod: 'cash',
    });
    expect(res.status).toBe(201);
    // server total = DB price (10) × qty (2) = 20
    const order = inserted.orders as Record<string, unknown>;
    expect(order.subtotal).toBe(20);
    expect(order.total).toBe(20);
    expect(order.status).toBe('pending');
  });

  it('rejects an oversized quantity with 409 (insufficient stock)', async () => {
    tables.products = { data: [{ id: 1, price: 10, stock: 1, sold: 0 }], error: null };
    const res = await json('api/orders', ordersPost, { items: [{ id: 1, qty: 99 }] });
    expect(res.status).toBe(409);
  });

  it('unknown product id → 400', async () => {
    tables.products = { data: [], error: null };
    const res = await json('api/orders', ordersPost, { items: [{ id: 999, qty: 1 }] });
    expect(res.status).toBe(400);
  });
});

describe('reviews upsert', () => {
  it('saves a review and returns the client shape → 201', async () => {
    tables.reviews = { data: [{ rating: 4 }], error: null }; // rating recompute read
    const res = await json('api/reviews', reviewsPost, {
      productId: 7, userId: 'u1', rating: 4, comment: 'Solid', userName: 'Ayan',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ productId: 7, userId: 'u1', rating: 4 });
  });

  it('missing rating → 400', async () => {
    const res = await json('api/reviews', reviewsPost, { productId: 7, userId: 'u1' });
    expect(res.status).toBe(400);
  });

  it('rating out of range → 400', async () => {
    const res = await json('api/reviews', reviewsPost, { productId: 7, userId: 'u1', rating: 9 });
    expect(res.status).toBe(400);
  });
});

describe('coupon validation', () => {
  const C = { id: 1, code: 'SAVE10', type: 'percent', value: 10, active: true, min_order: 50, used_count: 0, max_uses: null, expires_at: null };

  it('valid percent coupon → discount computed', async () => {
    tables.coupons = { data: C, error: null };
    const res = await json('api/coupons/validate', couponValidate, { code: 'save10', orderTotal: 100 });
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.discountAmount).toBe(10); // 10% of 100
  });

  it('unknown code → not valid', async () => {
    tables.coupons = { data: null, error: null };
    const body = await (await json('api/coupons/validate', couponValidate, { code: 'NOPE', orderTotal: 100 })).json();
    expect(body.valid).toBe(false);
  });

  it('below minimum order → not valid', async () => {
    tables.coupons = { data: C, error: null };
    const body = await (await json('api/coupons/validate', couponValidate, { code: 'SAVE10', orderTotal: 20 })).json();
    expect(body.valid).toBe(false);
    expect(body.message).toMatch(/[Mm]inimum/);
  });

  it('expired coupon → not valid', async () => {
    tables.coupons = { data: { ...C, expires_at: '2000-01-01T00:00:00Z' }, error: null };
    const body = await (await json('api/coupons/validate', couponValidate, { code: 'SAVE10', orderTotal: 100 })).json();
    expect(body.valid).toBe(false);
    expect(body.message).toMatch(/expired/i);
  });

  it('garbage order total → rejected, no NaN discount', async () => {
    const body = await (await json('api/coupons/validate', couponValidate, { code: 'SAVE10', orderTotal: 'abc' })).json();
    expect(body.valid).toBe(false);
  });
});
