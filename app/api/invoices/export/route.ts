import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg } from '@/lib/apiHelpers';
import { requireSupplierAccess } from '@/lib/apiAuth';
import { currentPeriodRange, type Period } from '@/lib/dashboardPeriod';
import {
  summarise, summaryCsv, detailCsv, exportFileName,
  type ExportInvoice, type ExportCustomer,
} from '@/lib/creditExport';

/**
 * GET /api/invoices/export?supplierId=X&period=day|week|month|year|all&shape=summary|detail
 *
 * Downloads the store's credit ledger as CSV so the shop can keep its own copy
 * — the ledger is money they are owed, and "what if we lose it" is the single
 * thing sellers ask about it most.
 *
 * Strictly scoped to ONE store (requireSupplierAccess + an explicit
 * supplier_id filter). A credit book is the most sensitive list a shop has;
 * this endpoint must never be a way to read someone else's.
 */
const PERIODS = new Set(['day', 'week', 'month', 'year', 'all']);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const supplierId = parseInt(searchParams.get('supplierId') ?? '', 10);
  if (Number.isNaN(supplierId)) {
    return NextResponse.json({ error: 'supplierId required' }, { status: 400 });
  }

  // Same gate as the invoices list: owner, admin, or staff with 'customers'.
  const denied = await requireSupplierAccess(req, supplierId, 'customers');
  if (denied) return denied;

  const periodRaw = String(searchParams.get('period') ?? 'month').toLowerCase();
  if (!PERIODS.has(periodRaw)) {
    return NextResponse.json({ error: 'period must be day, week, month, year or all' }, { status: 400 });
  }
  const shape = searchParams.get('shape') === 'detail' ? 'detail' : 'summary';

  try {
    const sb = getSupabaseAdmin();
    let q = sb.from('invoices')
      .select('id, customer_id, customer_name, total, paid_total, status, notes, created_at')
      .eq('supplier_id', supplierId)
      .order('created_at', { ascending: false });

    // 'all' deliberately has no lower bound — a backup of "everything we are
    // owed" is the whole point, and old debt is exactly what gets forgotten.
    let label = 'all';
    if (periodRaw !== 'all') {
      const range = currentPeriodRange(periodRaw as Period);
      q = q.gte('created_at', range.start.toISOString()).lt('created_at', range.end.toISOString());
      label = periodRaw;
    }

    const { data, error } = await q;
    if (error) throw error;

    const invoices: ExportInvoice[] = (data ?? []).map(r => ({
      id:           String(r.id),
      customerId:   String(r.customer_id),
      customerName: String(r.customer_name ?? ''),
      total:        Number(r.total) || 0,
      paidTotal:    Number(r.paid_total) || 0,
      status:       String(r.status ?? ''),
      notes:        (r.notes as string | null) ?? null,
      createdAt:    String(r.created_at),
    }));

    // Phone numbers come from the store's own customer book — the whole point
    // of the export is being able to CHASE the debt.
    let customers: ExportCustomer[] = [];
    try {
      const { data: cust } = await sb
        .from('customers').select('id, name, phone').eq('supplier_id', supplierId);
      customers = (cust ?? []).map(c => ({
        id: String(c.id), name: String(c.name ?? ''), phone: (c.phone as string | null) ?? '',
      }));
    } catch { /* phone column optional — export still works without it */ }

    const csv = shape === 'detail'
      ? detailCsv(invoices, customers)
      : summaryCsv(summarise(invoices, customers));

    const { data: store } = await sb
      .from('suppliers').select('name').eq('id', supplierId).maybeSingle();
    const filename = exportFileName(String(store?.name ?? 'store'), label, new Date());

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type':        'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // A credit book must never sit in a shared cache.
        'Cache-Control':       'private, no-store',
      },
    });
  } catch (e) {
    // No silent empty file: a shop must never be handed a blank "backup" and
    // believe their ledger is safe.
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
