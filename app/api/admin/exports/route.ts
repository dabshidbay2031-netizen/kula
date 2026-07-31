import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireAdmin } from '@/lib/apiAuth';
import { errMsg } from '@/lib/apiHelpers';
import { resolveExportRange, rangeSlug } from '@/lib/dashboardPeriod';
import {
  dashboardSummaryCsv, ordersCsv, soldItemsCsv, storeSlug,
  summariseOrders, type ExportOrder,
} from '@/lib/dashboardCsv';
import {
  summarise, summaryCsv, detailCsv, paymentsCsv, totals as creditTotals,
  toCsv, type ExportInvoice, type ExportCustomer,
} from '@/lib/creditExport';

/**
 * GET /api/admin/exports  — the platform's off-site backup button.
 *
 *   ?storeId=7                        one store (omit for every store)
 *   &period=day|week|month|year|all   a whole calendar period, OR
 *   &from=YYYY-MM-DD&to=YYYY-MM-DD    an exact window (`to` inclusive)
 *
 * Returns a ZIP with ONE FOLDER PER STORE, each holding that shop's dashboard,
 * its raw order and line-item history, and its full credit ledger. Separate
 * folders are the point: if the platform is ever lost, each business must be
 * handed back its own data intact, not a merged file someone has to unpick.
 *
 * FULL ADMIN ONLY. This is the single widest read in the app — every store's
 * takings plus customer names and phone numbers in one download — so it is
 * gated above the view-only `semi_admin` role that may read individual screens.
 */

/** Cap on stores per archive, so one click can't try to zip the whole platform
 *  into memory at once. Well above the current store count. */
const MAX_STORES = 250;

interface StoreRow { id: number; name: string }

export async function GET(req: Request) {
  const denied = await requireAdmin(req, { role: 'admin' });
  if (denied) return denied;

  const { searchParams } = new URL(req.url);

  const range = resolveExportRange({
    period: searchParams.get('period'),
    from:   searchParams.get('from'),
    to:     searchParams.get('to'),
  });
  if ('error' in range) return NextResponse.json({ error: range.error }, { status: 400 });

  const storeIdRaw = searchParams.get('storeId');
  let storeId: number | null = null;
  if (storeIdRaw != null && storeIdRaw !== '') {
    storeId = parseInt(storeIdRaw, 10);
    if (Number.isNaN(storeId)) {
      return NextResponse.json({ error: 'storeId must be a number' }, { status: 400 });
    }
  }

  try {
    const sb = getSupabaseAdmin();

    /* ── Which stores ─────────────────────────────────────────── */
    let sq = sb.from('suppliers').select('id, name').order('name');
    if (storeId != null) sq = sq.eq('id', storeId);
    const { data: storeData, error: storeErr } = await sq.limit(MAX_STORES);
    if (storeErr) throw storeErr;

    const stores: StoreRow[] = (storeData ?? []).map(s => ({
      id: Number(s.id), name: String(s.name ?? `store-${s.id}`),
    }));
    if (!stores.length) {
      return NextResponse.json({ error: storeId != null ? 'Store not found' : 'No stores to export' }, { status: 404 });
    }
    const ids = stores.map(s => s.id);

    /* ── Orders in range, for all requested stores at once ─────
       One query grouped in memory rather than a query per store: 20 stores
       would otherwise be 20 round trips before the download even starts. */
    let oq = sb.from('orders')
      .select('id, customer_name, items, total, payment_method, status, session_id, cashier_name, supplier_id, created_at')
      .in('supplier_id', ids)
      .order('created_at', { ascending: false });
    if (range.start && range.end) {
      oq = oq.gte('created_at', range.start.toISOString()).lt('created_at', range.end.toISOString());
    }
    const { data: orderData, error: orderErr } = await oq;
    if (orderErr) throw orderErr;

    const ordersByStore = new Map<number, ExportOrder[]>();
    for (const r of orderData ?? []) {
      const sid = Number(r.supplier_id);
      const list = ordersByStore.get(sid) ?? [];
      list.push({
        id:            String(r.id),
        createdAt:     String(r.created_at),
        status:        String(r.status ?? ''),
        total:         Number(r.total) || 0,
        customerName:  (r.customer_name as string | null) ?? null,
        paymentMethod: (r.payment_method as string | null) ?? null,
        sessionId:     (r.session_id as string | null) ?? null,
        cashierName:   (r.cashier_name as string | null) ?? null,
        items:         Array.isArray(r.items) ? r.items : [],
      });
      ordersByStore.set(sid, list);
    }

    /* ── Credit ledger in range ───────────────────────────────── */
    let iq = sb.from('invoices')
      .select('id, supplier_id, customer_id, customer_name, total, paid_total, status, notes, created_at, items, invoice_payments(amount, method, note, paid_at)')
      .in('supplier_id', ids)
      .order('created_at', { ascending: false });
    if (range.start && range.end) {
      iq = iq.gte('created_at', range.start.toISOString()).lt('created_at', range.end.toISOString());
    }
    // The ledger is optional infrastructure (migration_v3_7): a database without
    // it must still produce a sales backup rather than failing the whole export.
    const { data: invoiceData } = await iq;

    const invoicesByStore = new Map<number, ExportInvoice[]>();
    for (const r of invoiceData ?? []) {
      const sid = Number(r.supplier_id);
      const list = invoicesByStore.get(sid) ?? [];
      list.push({
        id:           String(r.id),
        customerId:   String(r.customer_id),
        customerName: String(r.customer_name ?? ''),
        total:        Number(r.total) || 0,
        paidTotal:    Number(r.paid_total) || 0,
        status:       String(r.status ?? ''),
        notes:        (r.notes as string | null) ?? null,
        createdAt:    String(r.created_at),
        items:        Array.isArray(r.items) ? r.items : [],
        payments:     ((r.invoice_payments as Record<string, unknown>[] | null) ?? []).map(p => ({
          invoiceId: String(r.id),
          amount:    Number(p.amount) || 0,
          method:    String(p.method ?? 'cash'),
          note:      (p.note as string | null) ?? null,
          paidAt:    String(p.paid_at),
        })),
      });
      invoicesByStore.set(sid, list);
    }

    /* ── Customer books (for phone numbers on the ledger) ──────── */
    const customersByStore = new Map<number, ExportCustomer[]>();
    try {
      const { data: custData } = await sb
        .from('customers').select('id, name, phone, supplier_id').in('supplier_id', ids);
      for (const c of custData ?? []) {
        const sid = Number(c.supplier_id);
        const list = customersByStore.get(sid) ?? [];
        list.push({ id: String(c.id), name: String(c.name ?? ''), phone: (c.phone as string | null) ?? '' });
        customersByStore.set(sid, list);
      }
    } catch { /* phone/customers optional — the export is still valid without */ }

    /* ── Build the archive ────────────────────────────────────── */
    const zip = new JSZip();
    const now = new Date();
    const slug = rangeSlug(range);

    // Cross-store index, so an admin can see every shop's position at a glance
    // without opening twenty folders.
    const indexRows: (string | number)[][] = [];

    for (const store of stores) {
      const orders   = ordersByStore.get(store.id)   ?? [];
      const invoices = invoicesByStore.get(store.id) ?? [];
      const customers = customersByStore.get(store.id) ?? [];
      const credit   = summarise(invoices, customers);
      const ct       = creditTotals(credit);
      const t        = summariseOrders(orders);

      const folder = zip.folder(storeSlug(store.name, store.id))!;
      folder.file('dashboard.csv', dashboardSummaryCsv({
        storeName:   store.name,
        rangeLabel:  range.label,
        generatedAt: now,
        orders,
        owed: { customers: ct.customers, outstanding: ct.outstanding },
      }));
      folder.file('orders.csv',          ordersCsv(orders));
      folder.file('items-sold.csv',      soldItemsCsv(orders));
      folder.file('customers-owed.csv',  summaryCsv(credit));
      folder.file('invoices.csv',        detailCsv(invoices, customers));
      folder.file('payments-received.csv', paymentsCsv(invoices, customers));

      indexRows.push([
        store.id, store.name,
        t.orders, t.units,
        t.revenue.toFixed(2), t.cost.toFixed(2), t.profit.toFixed(2),
        t.online.toFixed(2), t.inStore.toFixed(2),
        ct.customers, ct.outstanding.toFixed(2),
      ]);
    }

    zip.file('all-stores-summary.csv', toCsv(
      ['Store id', 'Store', 'Orders', 'Units', 'Revenue', 'Cost', 'Profit',
       'Online revenue', 'In-store revenue', 'Customers owing', 'Outstanding credit'],
      indexRows,
    ));

    zip.file('README.txt',
      `Hamar Mall — store data export\r\n` +
      `Period: ${range.label}\r\n` +
      `Generated: ${now.toISOString()}\r\n` +
      `Stores: ${stores.length}\r\n\r\n` +
      `One folder per store. Inside each:\r\n` +
      `  dashboard.csv          summary, day-by-day breakdown, top products\r\n` +
      `  orders.csv             one row per order\r\n` +
      `  items-sold.csv         one row per line item sold\r\n` +
      `  customers-owed.csv     what each customer still owes this store\r\n` +
      `  invoices.csv           full credit ledger\r\n` +
      `  payments-received.csv  one row per repayment\r\n\r\n` +
      `Deleted, cancelled and refunded orders appear in orders.csv but do not\r\n` +
      `count toward revenue — the "Counts as revenue" column marks which.\r\n` +
      `Dates and times are Africa/Mogadishu (UTC+3).\r\n`);

    const buf = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const name = storeId != null
      ? `${storeSlug(stores[0].name, stores[0].id)}-${slug}.zip`
      : `hamarmall-all-stores-${slug}.zip`;

    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type':        'application/zip',
        'Content-Disposition': `attachment; filename="${name}"`,
        // Every store's takings and every customer's phone number — never cached.
        'Cache-Control':       'private, no-store',
      },
    });
  } catch (e) {
    // Never hand back an empty or partial archive that looks like a good backup.
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
