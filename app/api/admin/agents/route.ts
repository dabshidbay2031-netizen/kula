import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, isMissingColumnError } from '@/lib/apiHelpers';
import { requireAdmin } from '@/lib/apiAuth';
import { COMMISSION_PER_STORE, COMMISSION_INSTALMENTS } from '@/lib/agentCommission';

/**
 * Field-agent register + approval desk.
 *
 *   GET   /api/admin/agents            → every agent, with their earnings
 *   PATCH /api/admin/agents            → { agentId, action: 'approve'|'reject' }
 *
 * An agent who signs up is PENDING and can do nothing — the link, submit and
 * commission paths all refuse them — until an admin approves here. That is the
 * gate that stops an unvetted stranger from touching a real store or earning a
 * payout.
 */

function mapAgent(a: Record<string, unknown>, earnings?: Record<string, unknown>) {
  const approvedAt = (a.agent_approved_at as string | null) ?? null;
  const rejectedAt = (a.agent_rejected_at as string | null) ?? null;
  return {
    id:        a.id,
    name:      a.name,
    icon:      a.icon,
    slug:      a.slug ?? null,
    createdAt: a.created_at,
    approvedAt, rejectedAt,
    status: rejectedAt ? 'rejected' : approvedAt ? 'approved' : 'pending',
    stores:        Number(earnings?.stores ?? 0),
    instalmentsDue: Number(earnings?.instalments_due ?? 0),
    amountDue:     Number(earnings?.amount_due ?? 0),
    amountPaid:    Number(earnings?.amount_paid ?? 0),
  };
}

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const sb = getSupabaseAdmin();
  try {
    const { data: agents, error } = await sb
      .from('suppliers')
      .select('*')
      .eq('account_type', 'agent')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Earnings come from the ledger view. Absent before migration_v4_6 — the
    // desk still lists agents so they can be approved.
    let byAgent = new Map<number, Record<string, unknown>>();
    try {
      const { data: sums } = await sb.from('agent_commission_summary').select('*');
      byAgent = new Map((sums ?? []).map(r => [Number(r.agent_id), r as Record<string, unknown>]));
    } catch { /* ledger not deployed yet */ }

    const rows = (agents ?? []).map(a =>
      mapAgent(a as Record<string, unknown>, byAgent.get(Number(a.id))));

    return NextResponse.json({
      agents: rows,
      terms: { perStore: COMMISSION_PER_STORE, instalments: COMMISSION_INSTALMENTS },
    });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const agentId = parseInt(String(body.agentId ?? ''), 10);
  const action  = String(body.action ?? '');
  if (Number.isNaN(agentId)) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  }
  if (action !== 'approve' && action !== 'reject') {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const { data: agent } = await sb
    .from('suppliers').select('id, account_type').eq('id', agentId).maybeSingle();
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  if (agent.account_type !== 'agent') {
    return NextResponse.json({ error: 'That account is not a field agent.' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const updates = action === 'approve'
    ? { agent_approved_at: now, agent_rejected_at: null }
    : { agent_rejected_at: now, agent_approved_at: null };

  const { error } = await sb.from('suppliers').update(updates).eq('id', agentId);
  if (error) {
    if (isMissingColumnError(error)) {
      return NextResponse.json(
        { error: 'Agent approval not enabled — run migration_v4_6.sql', needsMigration: true }, { status: 501 });
    }
    return NextResponse.json({ error: errMsg(error) }, { status: 500 });
  }

  return NextResponse.json({ success: true, agentId, status: action === 'approve' ? 'approved' : 'rejected' });
}
