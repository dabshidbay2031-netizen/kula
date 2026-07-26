// @vitest-environment node
/**
 * Order → store attribution on GET /api/orders?supplierId=X.
 *
 * A store sees ONLY orders attributed to it (orders.supplier_id). We do NOT
 * fall back to matching an order's items against the store's product ids —
 * catalog product ids are shared across stores (and were re-used on reseed),
 * so item-matching leaked every other store's orders into this store's list.
 * The scoping is a server-side `.eq('supplier_id', X)` filter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let authedUser: { id: string } | null = null;
let adminRow = false;
let storeOwner: string | null = 'ownerA';   // suppliers.auth_user_id for the queried store
let orderRows: Record<string, unknown>[] = [];

function builder(table: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {};
  // Capture an .eq('supplier_id', N) so the mock can filter like the real DB.
  let supplierFilter: number | null = null;
  b.select = () => b;
  b.eq = (col: string, val: unknown) => { if (col === 'supplier_id') supplierFilter = Number(val); return b; };
  for (const m of ['in', 'order', 'limit', 'neq', 'is', 'range', 'gte', 'lt'] as const) b[m] = () => b;
  b.maybeSingle = () => {
    if (table === 'admins')    return Promise.resolve({ data: adminRow ? { user_id: authedUser?.id } : null, error: null });
    if (table === 'suppliers') return Promise.resolve({ data: storeOwner ? { auth_user_id: storeOwner } : null, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  b.then = (res: (v: unknown) => void) => {
    let data: unknown[] = table === 'orders' ? orderRows : [];
    if (table === 'orders' && supplierFilter != null) {
      data = orderRows.filter(o => Number(o.supplier_id) === supplierFilter);
    }
    return Promise.resolve({ data, error: null }).then(res);
  };
  return b;
}

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    auth: { getUser: async (t: string) => (t && authedUser ? { data: { user: authedUser }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from: (table: string) => builder(table),
  }),
}));
vi.mock('@/lib/realtimeServer', () => ({ pingRealtime: vi.fn(), runAfterResponse: vi.fn() }));
vi.mock('@/lib/pushNotify', () => ({ sendPushToUsers: vi.fn(), sendPushToStores: vi.fn(), sellerStoreIds: vi.fn(async () => []) }));
vi.mock('@/lib/notify', () => ({ createNotifications: vi.fn() }));

import { GET } from '@/app/api/orders/route';

const req = () => new Request('http://t/api/orders?supplierId=27', { headers: { Authorization: 'Bearer jwt' } });

const order = (id: string, supplier_id: number | null, itemIds: number[]) => ({
  id, supplier_id, items: itemIds.map(i => ({ id: i, qty: 1 })),
  customer_name: 'X', customer_phone: '', subtotal: 1, discount: 0, total: 1,
  payment_method: 'cash', status: 'completed', created_at: '2026-07-11T10:00:00Z',
});

beforeEach(() => {
  authedUser = { id: 'ownerA' }; adminRow = false; storeOwner = 'ownerA';
  orderRows = [
    order('MINE-ATTRIBUTED',   27,   [777]),  // attributed to me — items irrelevant
    order('RIVAL-ATTRIBUTED',  35,   [9]),    // rival's sale of a product I also sell
    order('LEGACY-OWNED',      null, [9]),    // legacy row matching a product I sell
    order('LEGACY-CLAIMED',    null, [5]),    // legacy row matching a product I claim
    order('LEGACY-FOREIGN',    null, [777]),  // legacy row with nothing of mine
  ];
});

describe('GET /api/orders?supplierId — strict attribution only', () => {
  it('returns ONLY orders attributed to the store', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { id: string }[]).map(o => o.id);
    expect(ids).toEqual(['MINE-ATTRIBUTED']);
  });

  it("another store's attributed sale is EXCLUDED", async () => {
    const body = (await (await GET(req())).json()) as { id: string }[];
    expect(body.find(o => o.id === 'RIVAL-ATTRIBUTED')).toBeUndefined();
  });

  it('legacy un-attributed orders are NOT leaked in by item matching', async () => {
    const body = (await (await GET(req())).json()) as { id: string }[];
    for (const leaked of ['LEGACY-OWNED', 'LEGACY-CLAIMED', 'LEGACY-FOREIGN']) {
      expect(body.find(o => o.id === leaked)).toBeUndefined();
    }
  });

  it('responses expose supplierId for the client', async () => {
    const body = (await (await GET(req())).json()) as { id: string; supplierId: number | null }[];
    expect(body.find(o => o.id === 'MINE-ATTRIBUTED')?.supplierId).toBe(27);
  });
});
