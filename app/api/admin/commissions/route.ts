import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, isMissingTableError } from '@/lib/apiHelpers';
import { requireAdmin } from '@/lib/apiAuth';
import {
  summariseByAgent, COMMISSION_PER_STORE, COMMISSION_INSTALMENTS,
  type CommissionRow,
} from '@/lib/agentCommission';

/**
 * Agent commission desk.
 *
 *   GET   /api/admin/commissions?status=due|paid|all
 *   PATCH /api/admin/commissions   { supplierId, instalment, action: 'pay' | 'unpay' }
 *
 * $6 per store per paid month, three months. Instalments are accrued
 * automatically when the store pays (lib/accrueCommission); this desk is where
 * an admin records that the agent was actually handed the money.
 */

function mapRow(r: Record<string, unknown>): CommissionRow & { storeName?: string; agentName?: string } {
  return {
    supplierId: Number(r.supplier_id),
    agentId:    Number(r.agent_id),
    instalment: Number(r.instalment),
    amount:     Number(r.amount) || 0,
    status:     (r.status === 'paid' ? 'paid' : 'due'),
    earnedAt:   String(r.earned_at ?? ''),
    paidAt:     (r.paid_at as string | null) ?? null,
  };
}

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const status = String(new URL(req.url).searchParams.get('status') ?? 'due');
  const sb = getSupabaseAdmin();

  try {
    let q = sb.from('agent_commissions').select('*').order('earned_at', { ascending: false });
    if (status === 'due' || status === 'paid') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;

    const rows = (data ?? []).map(r => mapRow(r as Record<string, unknown>));

    // Names, so the desk is readable without a second lookup per row.
    const ids = Array.from(new Set(rows.flatMap(r => [r.agentId, r.supplierId])));
    const nameById = new Map<number, string>();
    if (ids.length) {
      const { data: names } = await sb.from('suppliers').select('id, name').in('id', ids);
      for (const n of names ?? []) nameById.set(Number(n.id), String(n.name ?? ''));
    }

    return NextResponse.json({
      rows: rows.map(r => ({
        ...r,
        agentName: nameById.get(r.agentId) ?? `#${r.agentId}`,
        storeName: nameById.get(r.supplierId) ?? `#${r.supplierId}`,
      })),
      byAgent: summariseByAgent(rows).map(a => ({
        ...a, agentName: nameById.get(a.agentId) ?? `#${a.agentId}`,
      })),
      terms: { perStore: COMMISSION_PER_STORE, instalments: COMMISSION_INSTALMENTS },
    });
  } catch (e) {
    if (isMissingTableError(e)) {
      return NextResponse.json({
        rows: [], byAgent: [],
        terms: { perStore: COMMISSION_PER_STORE, instalments: COMMISSION_INSTALMENTS },
        needsMigration: true,
      });
    }
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  // FULL admin only — marking a commission paid settles money owed to an agent.
  // Reading the ledger (GET) stays open to any admin role.
  const denied = await requireAdmin(req, { role: 'admin' });
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const supplierId = parseInt(String(body.supplierId ?? ''), 10);
  const instalment = parseInt(String(body.instalment ?? ''), 10);
  const action     = String(body.action ?? 'pay');

  if (Number.isNaN(supplierId) || Number.isNaN(instalment)) {
    return NextResponse.json({ error: 'supplierId and instalment required' }, { status: 400 });
  }
  if (action !== 'pay' && action !== 'unpay') {
    return NextResponse.json({ error: "action must be 'pay' or 'unpay'" }, { status: 400 });
  }

  const updates = action === 'pay'
    ? { status: 'paid', paid_at: new Date().toISOString() }
    : { status: 'due',  paid_at: null };

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('agent_commissions')
      .update(updates)
      .eq('supplier_id', supplierId)
      .eq('instalment', instalment)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Commission row not found' }, { status: 404 });
    return NextResponse.json({ success: true, ...mapRow(data as Record<string, unknown>) });
  } catch (e) {
    if (isMissingTableError(e)) {
      return NextResponse.json(
        { error: 'Commissions not enabled — run migration_v4_6.sql', needsMigration: true }, { status: 501 });
    }
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
