// @vitest-environment node
/**
 * Guards added for audit items M1, M4, M5, M7 on POST /api/orders.
 *
 *   M4  a buyer may not open an order already 'completed'
 *   M7  an unknown payment method must not pass through as fee-free cash
 *   M5  a replayed Idempotency-Key returns the FIRST order, not a second one
 *   M1  stock is taken atomically; a losing race must not create the order
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let authedUser: { id: string } | null = null;
let ownsStore = false;
let decrementOk = true;
/** null = place_order_v2 not deployed (legacy path); otherwise its result. */
let v2Result: { data?: unknown; error?: { message: string } } | null = null;
let existingByKey: Record<string, unknown> | null = null;
let inserted: Record<string, unknown>[] = [];
let restored: { p_id: number; p_qty: number }[] = [];

const PRODUCT = { id: 5, price: 10, stock: 3, sold: 0, price_tiers: null, supplier_id: 27 };

function builder(table: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {};
  let keyFilter: string | null = null;
  b.select = () => b;
  b.eq = (col: string, val: unknown) => { if (col === 'idempotency_key') keyFilter = String(val); return b; };
  for (const m of ['in', 'order', 'limit', 'neq', 'is', 'range', 'gte', 'lt', 'update'] as const) b[m] = () => b;
  b.insert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
    const arr = Array.isArray(rows) ? rows : [rows];
    if (table === 'orders')      inserted.push(...arr);
    if (table === 'order_items') inserted.push(...arr.map(r => ({ __line: true, ...r })));
    return b;
  };
  b.single = () => Promise.resolve(
    table === 'orders'
      ? { data: { id: 'ORD-1', ...inserted[inserted.length - 1], items: [{ id: 5, qty: 1 }] }, error: null }
      : { data: null, error: null });
  b.maybeSingle = () => {
    if (table === 'orders' && keyFilter) return Promise.resolve({ data: existingByKey, error: null });
    if (table === 'suppliers') return Promise.resolve({ data: ownsStore ? { auth_user_id: authedUser?.id } : null, error: null });
    if (table === 'admins')    return Promise.resolve({ data: null, error: null });
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
    auth: { getUser: async (t: string) => (t && authedUser ? { data: { user: authedUser }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from: (table: string) => builder(table),
    rpc: (fn: string, args: Record<string, number>) => {
      if (fn === 'place_order_v2') {
        return Promise.resolve(v2Result ?? { data: null, error: { code: 'PGRST202', message: 'no function' } });
      }
      if (fn === 'decrement_stock') return Promise.resolve({ data: decrementOk, error: null });
      if (fn === 'restore_stock') { restored.push(args as { p_id: number; p_qty: number }); return Promise.resolve({ data: true, error: null }); }
      return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'no function' } });
    },
  }),
}));
vi.mock('@/lib/apiAuth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getAuthUser:       async () => authedUser,
  isAdminUser:       async () => false,
  ownsStoreOrAdmin:  async () => ownsStore,
  requireSupplierAccess: async () => null,
  // A staff cashier passes this WITHOUT a JWT — that's the whole point.
  canAccessStore:    async () => ownsStore,
}));
vi.mock('@/lib/realtimeServer', () => ({ pingRealtime: vi.fn(), runAfterResponse: vi.fn() }));
vi.mock('@/lib/pushNotify', () => ({ sendPushToUsers: vi.fn(), sendPushToStores: vi.fn(), sellerStoreIds: vi.fn(async () => []) }));
vi.mock('@/lib/notify', () => ({ createNotifications: vi.fn() }));

import { POST } from '@/app/api/orders/route';

const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  POST(new Request('http://t/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ items: [{ id: 5, qty: 1 }], customerName: 'A', ...body }),
  }));

beforeEach(() => {
  authedUser = null; ownsStore = false; decrementOk = true;
  existingByKey = null; inserted = []; restored = []; v2Result = null;
});

describe('M1 (full) — the atomic place_order_v2 path', () => {
  it('uses the RPC when it exists, and writes nothing itself', async () => {
    v2Result = { data: { id: 'ORD-ATOMIC', items: [], total: 10, status: 'pending' }, error: undefined };
    const res  = await post({});
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.id).toBe('ORD-ATOMIC');
    // The whole sale happened inside the transaction — no JS-path inserts.
    expect(inserted.length).toBe(0);
  });

  it('surfaces a stock refusal from the RPC as 409, without retrying', async () => {
    v2Result = { data: null, error: { message: 'INSUFFICIENT_STOCK:5' } };
    const res = await post({});
    expect(res.status).toBe(409);
    expect(inserted.length).toBe(0);   // must NOT fall through and decrement twice
    expect(restored.length).toBe(0);
  });

  it('surfaces a missing product as 400', async () => {
    v2Result = { data: null, error: { message: 'PRODUCT_MISSING:5' } };
    const res = await post({});
    expect(res.status).toBe(400);
  });

  it('falls back to the step-by-step path when the RPC is absent', async () => {
    v2Result = null;                    // PGRST202 — function not deployed
    const res = await post({});
    expect(res.status).toBe(201);
    expect(inserted.some(r => !r.__line)).toBe(true);
  });
});

describe('M4 — order status is staff-only beyond pending', () => {
  it('rejects a guest asking for status=completed', async () => {
    const res = await post({ status: 'completed', supplierId: 27 });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown status outright', async () => {
    const res = await post({ status: 'h4ck3d' });
    expect(res.status).toBe(400);
  });

  it('allows the owning store to open an order as completed', async () => {
    authedUser = { id: 'owner' }; ownsStore = true;
    const res = await post({ status: 'completed', supplierId: 27 });
    expect(res.status).toBe(201);
    expect(inserted.find(r => !r.__line)?.status).toBe('completed');
  });

  it('still lets a plain buyer place a pending order', async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    expect(inserted.find(r => !r.__line)?.status).toBe('pending');
  });
});

describe('M7 — payment method whitelist', () => {
  it('coerces an invented method to cash', async () => {
    const res = await post({ paymentMethod: 'freemoney' });
    expect(res.status).toBe(201);
    expect(inserted.find(r => !r.__line)?.payment_method).toBe('cash');
  });

  it('keeps a real wallet method', async () => {
    const res = await post({ paymentMethod: 'waafi' });
    expect(res.status).toBe(201);
    expect(inserted.find(r => !r.__line)?.payment_method).toBe('waafi');
  });

  it('keeps bulk, which drives the wholesale path', async () => {
    const res = await post({ paymentMethod: 'bulk' });
    expect(res.status).toBe(201);
    expect(inserted.find(r => !r.__line)?.payment_method).toBe('bulk');
  });
});

describe('M5 — idempotency', () => {
  it('returns the original order when the key is replayed', async () => {
    existingByKey = { id: 'ORD-FIRST', items: [], total: 10, status: 'pending' };
    const res = await post({}, { 'Idempotency-Key': 'abc' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(body.id).toBe('ORD-FIRST');
    expect(inserted.length).toBe(0);      // nothing new was created
  });

  it('stores the key on a first-time order', async () => {
    const res = await post({}, { 'Idempotency-Key': 'fresh' });
    expect(res.status).toBe(201);
    expect(inserted.find(r => !r.__line)?.idempotency_key).toBe('fresh');
  });
});

describe('M1 — stock is taken atomically', () => {
  it('refuses the order when the atomic decrement loses the race', async () => {
    decrementOk = false;
    const res = await post({});
    expect(res.status).toBe(409);
    expect(inserted.length).toBe(0);      // no order row for stock we never got
  });

  it('writes normalized order_items for the fallback path', async () => {
    const res = await post({ paymentMethod: 'cash' });
    expect(res.status).toBe(201);
    const line = inserted.find(r => r.__line);
    expect(line).toBeTruthy();
    expect(line?.product_id).toBe(5);
    expect(line?.qty).toBe(1);
  });
});

describe('POS sale — silent and already completed', () => {
  it('a till operator may open the sale as completed', async () => {
    // ownsStore stands in for canAccessStore: owner OR staff cashier with 'pos'.
    ownsStore = true;
    const res = await post({ status: 'completed', supplierId: 27, silent: true });
    expect(res.status).toBe(201);
    expect(inserted.find(r => !r.__line)?.status).toBe('completed');
  });

  it('still refuses a random caller asking for completed', async () => {
    ownsStore = false;
    const res = await post({ status: 'completed', supplierId: 27, silent: true });
    expect(res.status).toBe(403);
  });

  it('the silent flag does not leak into the order row', async () => {
    ownsStore = true;
    await post({ status: 'completed', supplierId: 27, silent: true });
    const row = inserted.find(r => !r.__line)!;
    expect('silent' in row).toBe(false);
  });

  it('an online sale is unaffected — still pending', async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    expect(inserted.find(r => !r.__line)?.status).toBe('pending');
  });
});
