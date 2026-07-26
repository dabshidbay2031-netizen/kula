// @vitest-environment node
/**
 * Manual (POS) discount on POST /api/orders.
 *
 * A discount is a STAFF action: it is honoured only when the caller holds a
 * valid JWT and owns the store the sale is attributed to. A public/guest order
 * that sends `discount` must have it IGNORED — otherwise a buyer could zero out
 * their own total. The amount is re-clamped against the server-computed subtotal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let authUser: { id: string } | null = null;
let ownsStore = false;
let orderInsert: Record<string, unknown> | null = null;

// The product being sold: $100, qty comes from the request.
const PRODUCT = { id: 1, price: 100, stock: 50, sold: 0 };

function builder(table: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'range', 'gte'] as const) b[m] = () => b;
  b.insert = (payload: Record<string, unknown>) => {
    if (table === 'orders') orderInsert = payload;
    return b;
  };
  b.maybeSingle = () => Promise.resolve({ data: null, error: null }); // no coupon
  b.single = () => {
    if (table === 'orders') {
      return Promise.resolve({ data: { id: 'ORD-X', created_at: '2026-07-17T00:00:00Z', ...orderInsert }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };
  b.then = (res: (v: unknown) => void) => {
    const data = table === 'products' ? [PRODUCT] : [];
    return Promise.resolve({ data, error: null }).then(res);
  };
  return b;
}

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    from: (t: string) => builder(t),
    // RPC missing → route falls through to the JS path (where discount applies)
    rpc: () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'no function' } }),
  }),
}));
vi.mock('@/lib/apiAuth', () => ({
  getAuthUser:      async () => authUser,
  ownsStoreOrAdmin: async () => ownsStore,
  isAdminUser:      async () => false,
}));
vi.mock('@/lib/realtimeServer', () => ({ pingRealtime: vi.fn(), runAfterResponse: vi.fn() }));
vi.mock('@/lib/pushNotify', () => ({ sendPushToStores: vi.fn(), sellerStoreIds: vi.fn(async () => []) }));
vi.mock('@/lib/notify', () => ({ createNotifications: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ rateLimit: () => ({ ok: true }), clientIp: () => '1.1.1.1' }));

import { POST } from '@/app/api/orders/route';

const place = (body: object) => POST(new Request('http://t/api/orders', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt' },
  body: JSON.stringify(body),
}));

beforeEach(() => { authUser = null; ownsStore = false; orderInsert = null; });

describe('POST /api/orders — manual discount is staff-gated', () => {
  it('IGNORES a discount from a guest (no auth)', async () => {
    authUser = null;
    await place({ items: [{ id: 1, qty: 1 }], supplierId: 2, discount: 50 });
    expect(orderInsert).toBeTruthy();
    expect(Number(orderInsert!.discount)).toBe(0);
    expect(Number(orderInsert!.total)).toBe(100);   // full price, discount ignored
  });

  it('IGNORES a discount from a signed-in NON-owner', async () => {
    authUser = { id: 'someone' }; ownsStore = false;
    await place({ items: [{ id: 1, qty: 1 }], supplierId: 2, discount: 50 });
    expect(Number(orderInsert!.discount)).toBe(0);
    expect(Number(orderInsert!.total)).toBe(100);
  });

  it('APPLIES a discount for the store owner', async () => {
    authUser = { id: 'owner' }; ownsStore = true;
    await place({ items: [{ id: 1, qty: 1 }], supplierId: 2, discount: 30 });
    expect(Number(orderInsert!.discount)).toBe(30);
    expect(Number(orderInsert!.total)).toBe(70);
  });

  it('clamps an over-subtotal discount to the subtotal (total never negative)', async () => {
    authUser = { id: 'owner' }; ownsStore = true;
    await place({ items: [{ id: 1, qty: 1 }], supplierId: 2, discount: 99999 });
    expect(Number(orderInsert!.discount)).toBe(100);
    expect(Number(orderInsert!.total)).toBe(0);
  });
});
