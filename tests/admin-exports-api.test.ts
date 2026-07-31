// @vitest-environment node
/**
 * /api/admin/exports — the platform-wide data backup.
 *
 * This is the widest read in the app: every store's takings plus customer names
 * and phone numbers in one file. The gate matters more than the contents, so
 * the authorization cases are pinned first, then the archive shape — a backup
 * that silently omits a store is worse than no backup at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

let authedUser: { id: string; email: string | null } | null = null;
let adminRole: 'admin' | 'semi_admin' | null = null;

const SUPPLIERS = [
  { id: 1, name: 'Sokow Sambusa' },
  { id: 2, name: 'Hamar Tech' },
];
const ORDERS = [
  { id: 'ORD-1', supplier_id: 1, customer_name: 'Xasan', total: 100, status: 'completed',
    payment_method: 'cash', session_id: null, cashier_name: null,
    created_at: '2026-03-04T09:00:00+03:00',
    items: [{ name: 'Sambusa', qty: 4, price: 25, cost: 10 }] },
  { id: 'ORD-2', supplier_id: 2, customer_name: null, total: 300, status: 'cancelled',
    payment_method: 'sifalo', session_id: 'sess-9', cashier_name: null,
    created_at: '2026-03-04T11:00:00+03:00',
    items: [{ name: 'Cable', qty: 1, price: 300 }] },
];
const INVOICES = [
  { id: 'INV-1', supplier_id: 1, customer_id: 'c1', customer_name: 'Xasan',
    total: 50, paid_total: 20, status: 'partial', notes: null,
    created_at: '2026-03-04T09:30:00+03:00', items: [],
    invoice_payments: [{ amount: 20, method: 'cash', note: null, paid_at: '2026-03-04T18:00:00+03:00' }] },
];
const CUSTOMERS = [{ id: 'c1', name: 'Xasan', phone: '+252611234567', supplier_id: 1 }];

/** Rows each table resolves to when the query is awaited. */
const TABLE_DATA: Record<string, unknown[]> = {
  suppliers: SUPPLIERS,
  orders:    ORDERS,
  invoices:  INVOICES,
  customers: CUSTOMERS,
};

let supplierFilterId: number | null = null;

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'order', 'gte', 'lt', 'limit']) b[m] = () => b;
  b.eq = (col: string, val: unknown) => {
    // The single-store path filters suppliers by id — mirror that so the
    // "one store" assertions are meaningful rather than always returning both.
    if (table === 'suppliers' && col === 'id') supplierFilterId = Number(val);
    return b;
  };
  b.maybeSingle = () => Promise.resolve(
    table === 'admins' ? { data: adminRole ? { role: adminRole } : null, error: null }
                       : { data: null, error: null });
  (b as { then?: unknown }).then = (res: (v: unknown) => void) => {
    let rows = TABLE_DATA[table] ?? [];
    if (table === 'suppliers' && supplierFilterId != null) {
      rows = rows.filter(r => (r as { id: number }).id === supplierFilterId);
    }
    return Promise.resolve({ data: rows, error: null }).then(res);
  };
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

import { GET } from '@/app/api/admin/exports/route';

const url = (qs = '') => `http://test/api/admin/exports${qs}`;
const req = (qs = '', auth = true) =>
  new Request(url(qs), auth ? { headers: { Authorization: 'Bearer test-jwt' } } : undefined);

const asAdmin = () => { authedUser = { id: 'boss', email: null }; adminRole = 'admin'; };

async function unzip(res: Response) {
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  return Object.keys(zip.files).filter(n => !zip.files[n].dir);
}

beforeEach(() => { authedUser = null; adminRole = null; supplierFilterId = null; });

describe('authorization — the widest read in the app', () => {
  it('anonymous → 401', async () => {
    expect((await GET(req('', false))).status).toBe(401);
  });

  it('signed-in non-admin → 401', async () => {
    authedUser = { id: 'shopper', email: null };
    expect((await GET(req())).status).toBe(401);
  });

  it('semi_admin (view-only) cannot bulk-export every store → 403', async () => {
    authedUser = { id: 'viewer', email: null }; adminRole = 'semi_admin';
    expect((await GET(req())).status).toBe(403);
  });

  it('full admin → 200 zip', async () => {
    asAdmin();
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
  });

  it('never lets a backup sit in a shared cache', async () => {
    asAdmin();
    expect((await GET(req())).headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('archive shape', () => {
  it('gives every store its own folder with the full file set', async () => {
    asAdmin();
    const names = await unzip(await GET(req('?period=all')));

    for (const slug of ['sokow-sambusa-1', 'hamar-tech-2']) {
      for (const file of ['dashboard.csv', 'orders.csv', 'items-sold.csv',
                          'customers-owed.csv', 'invoices.csv', 'payments-received.csv']) {
        expect(names, `${slug}/${file} missing`).toContain(`${slug}/${file}`);
      }
    }
    expect(names).toContain('all-stores-summary.csv');
    expect(names).toContain('README.txt');
  });

  it('scopes to one store when storeId is given', async () => {
    asAdmin();
    const names = await unzip(await GET(req('?storeId=1&period=all')));
    expect(names.some(n => n.startsWith('sokow-sambusa-1/'))).toBe(true);
    expect(names.some(n => n.startsWith('hamar-tech-2/'))).toBe(false);
  });

  it('names the file after the store and the range', async () => {
    asAdmin();
    const res = await GET(req('?storeId=1&from=2026-03-04&to=2026-03-04'));
    expect(res.headers.get('Content-Disposition')).toContain('sokow-sambusa-1-2026-03-04.zip');
  });

  it('names the all-stores archive distinctly', async () => {
    asAdmin();
    const res = await GET(req('?period=all'));
    expect(res.headers.get('Content-Disposition')).toContain('hamarmall-all-stores-all-time.zip');
  });
});

describe('archive contents', () => {
  const read = async (res: Response, path: string) => {
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    return zip.file(path)!.async('string');
  };

  it("a store's dashboard carries its own takings", async () => {
    asAdmin();
    const csv = await read(await GET(req('?period=all')), 'sokow-sambusa-1/dashboard.csv');
    expect(csv).toContain('Sokow Sambusa');
    expect(csv).toContain('Revenue,100.00');
  });

  it('a cancelled order is present but earns nothing', async () => {
    asAdmin();
    const res = await GET(req('?period=all'));
    const dash = await read(res, 'hamar-tech-2/dashboard.csv');
    expect(dash).toContain('Revenue,0.00');
    const orders = await read(await GET(req('?period=all')), 'hamar-tech-2/orders.csv');
    expect(orders).toContain('ORD-2');       // the row still exists in the history
  });

  it('the credit ledger reaches the right store, with the phone number', async () => {
    asAdmin();
    const csv = await read(await GET(req('?period=all')), 'sokow-sambusa-1/customers-owed.csv');
    expect(csv).toContain('Xasan');
    expect(csv).toContain('+252611234567');
    expect(csv).toContain('30.00');           // 50 billed − 20 paid still owed
  });

  it('the cross-store summary has one row per store', async () => {
    asAdmin();
    const csv = await read(await GET(req('?period=all')), 'all-stores-summary.csv');
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);            // header + 2 stores
    expect(csv).toContain('Sokow Sambusa');
    expect(csv).toContain('Hamar Tech');
  });
});

describe('range validation reaches the caller', () => {
  it('rejects a reversed custom range with 400, not a wrong export', async () => {
    asAdmin();
    const res = await GET(req('?from=2026-03-17&to=2026-03-04'));
    expect(res.status).toBe(400);
  });

  it('rejects half a range', async () => {
    asAdmin();
    expect((await GET(req('?from=2026-03-04'))).status).toBe(400);
  });

  it('rejects a non-numeric storeId', async () => {
    asAdmin();
    expect((await GET(req('?storeId=abc'))).status).toBe(400);
  });
});
