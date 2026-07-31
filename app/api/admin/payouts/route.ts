import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireAdmin, getAuthUser } from '@/lib/apiAuth';
import { errMsg, isMissingTableError, isMissingColumnError } from '@/lib/apiHelpers';

/**
 * Admin payout desk — the other half of the shop-side request flow in
 * /api/payouts.
 *
 *   GET   /api/admin/payouts?status=pending   list requests (newest first)
 *   PATCH /api/admin/payouts { id, status, note? }   approve or reject one
 *
 * Admin-only: a shop can request money, but only an admin decides. Approving
 * marks it paid (the transfer itself happens outside the app, like the agent
 * bounty); rejecting releases the reserved amount back into the shop's balance.
 */

interface AdminPayoutRow {
  id: number;
  supplierId: number;
  storeName: string;
  storeIcon: string;
  amount: number;
  phone: string;
  status: string;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const status = new URL(req.url).searchParams.get('status'); // pending|approved|rejected|null=all
  const sb = getSupabaseAdmin();

  try {
    let q = sb.from('payouts')
      .select('*, suppliers(name, icon)')
      .order('created_at', { ascending: false })
      .limit(300);
    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw error;

    const rows: AdminPayoutRow[] = (data ?? []).map(r => {
      const store = (r as { suppliers?: { name?: string; icon?: string } }).suppliers;
      return {
        id:         r.id as number,
        supplierId: r.supplier_id as number,
        storeName:  store?.name ?? `Store #${r.supplier_id}`,
        storeIcon:  store?.icon ?? '🏪',
        amount:     Number(r.amount) || 0,
        phone:      (r.phone as string) ?? '',
        status:     ((r.status as string) ?? 'approved'),
        note:       (r.note as string | null) ?? null,
        createdAt:  r.created_at as string,
        decidedAt:  (r.decided_at as string | null) ?? null,
      };
    });

    const totals = {
      pending:  rows.filter(r => r.status === 'pending').reduce((s, r) => s + r.amount, 0),
      approved: rows.filter(r => r.status === 'approved').reduce((s, r) => s + r.amount, 0),
      pendingCount: rows.filter(r => r.status === 'pending').length,
    };

    return NextResponse.json({
      payouts: rows,
      totals: {
        pending:      Math.round(totals.pending  * 100) / 100,
        approved:     Math.round(totals.approved * 100) / 100,
        pendingCount: totals.pendingCount,
      },
    });
  } catch (e) {
    if (isMissingTableError(e) || isMissingColumnError(e)) {
      return NextResponse.json({
        payouts: [], totals: { pending: 0, approved: 0, pendingCount: 0 },
        needsMigration: true,
      });
    }
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  // FULL admin only. Approving a payout releases real money, and `semi_admin`
  // is advertised in the UI as view-only — a bare requireAdmin() accepted it,
  // so a "view-only" account could approve its own withdrawal with one request.
  const denied = await requireAdmin(req, { role: 'admin' });
  if (denied) return denied;

  const user = await getAuthUser(req);
  const body = await req.json().catch(() => ({}));
  const id     = parseInt(String(body.id ?? ''), 10);
  const status = String(body.status ?? '');
  const note   = body.note != null ? String(body.note).slice(0, 500) : null;

  if (Number.isNaN(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });
  if (status !== 'approved' && status !== 'rejected') {
    return NextResponse.json({ error: 'status must be "approved" or "rejected"' }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  try {
    // Only a still-pending request can be decided — prevents an approved payout
    // being flipped again (which would double-pay or un-pay real money).
    const { data: current, error: readErr } = await sb
      .from('payouts').select('id, status, amount').eq('id', id).maybeSingle();
    if (readErr) throw readErr;
    if (!current) return NextResponse.json({ error: 'Payout request not found' }, { status: 404 });
    if ((current.status as string) !== 'pending') {
      return NextResponse.json(
        { error: `This request was already ${current.status}` },
        { status: 409 },
      );
    }

    const { data, error } = await sb.from('payouts')
      .update({
        status,
        note,
        decided_at: new Date().toISOString(),
        decided_by: user?.id ?? null,
      })
      .eq('id', id)
      .eq('status', 'pending')   // race guard: only the first decision wins
      .select()
      .single();
    if (error) throw error;

    return NextResponse.json({
      success: true,
      id:      data.id,
      status:  data.status,
      amount:  Number(data.amount) || 0,
      note:    data.note ?? null,
    });
  } catch (e) {
    if (isMissingColumnError(e)) {
      return NextResponse.json(
        { error: 'Payout approvals not enabled yet — run migration_v4_1.sql', needsMigration: true },
        { status: 501 },
      );
    }
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
