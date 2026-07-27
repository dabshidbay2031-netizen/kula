import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, isMissingColumnError } from '@/lib/apiHelpers';
import { requireAdmin, getAuthUser } from '@/lib/apiAuth';

/**
 * Admin-granted free trial.
 *
 *   POST   /api/admin/trial   { supplierId, days }  → grant / extend
 *   DELETE /api/admin/trial?supplierId=X            → revoke
 *
 * A trial unlocks the store dashboard without payment. It is deliberately NOT
 * a payment: it does not start the money-back window and it earns a field
 * agent nothing (see lib/agentCommission), so nobody can farm trials for cash.
 *
 * Who granted it and when are recorded — this hands out free access, so it
 * needs an audit trail.
 */

const MAX_TRIAL_DAYS = 90;
const DAY_MS = 86_400_000;

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const supplierId = parseInt(String(body.supplierId ?? ''), 10);
  if (Number.isNaN(supplierId)) {
    return NextResponse.json({ error: 'supplierId required' }, { status: 400 });
  }

  const rawDays = Number(body.days ?? 7);
  if (!Number.isFinite(rawDays) || rawDays <= 0 || rawDays > MAX_TRIAL_DAYS) {
    return NextResponse.json(
      { error: `days must be between 1 and ${MAX_TRIAL_DAYS}` }, { status: 400 });
  }
  const days = Math.trunc(rawDays);

  const sb = getSupabaseAdmin();
  const { data: store } = await sb
    .from('suppliers').select('id, account_type, trial_ends_at').eq('id', supplierId).maybeSingle();
  if (!store) return NextResponse.json({ error: 'Store not found' }, { status: 404 });
  if (store.account_type !== 'business' && store.account_type !== 'supplier') {
    return NextResponse.json({ error: 'Only seller accounts need a trial.' }, { status: 400 });
  }

  // Extend from the CURRENT trial end when one is still running, so granting
  // "7 days" twice gives 14 rather than silently throwing the first week away.
  const current = store.trial_ends_at ? new Date(String(store.trial_ends_at)).getTime() : 0;
  const from    = Math.max(current, Date.now());
  const endsAt  = new Date(from + days * DAY_MS).toISOString();

  const admin = await getAuthUser(req);
  const { error } = await sb.from('suppliers').update({
    trial_ends_at:    endsAt,
    trial_granted_by: admin?.id ?? null,
    trial_granted_at: new Date().toISOString(),
  }).eq('id', supplierId);

  if (error) {
    if (isMissingColumnError(error)) {
      return NextResponse.json(
        { error: 'Trials not enabled — run migration_v4_6.sql', needsMigration: true }, { status: 501 });
    }
    return NextResponse.json({ error: errMsg(error) }, { status: 500 });
  }

  return NextResponse.json({ success: true, supplierId, days, trialEndsAt: endsAt });
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const supplierId = parseInt(new URL(req.url).searchParams.get('supplierId') ?? '', 10);
  if (Number.isNaN(supplierId)) {
    return NextResponse.json({ error: 'supplierId required' }, { status: 400 });
  }

  const { error } = await getSupabaseAdmin()
    .from('suppliers').update({ trial_ends_at: null }).eq('id', supplierId);
  if (error) {
    if (isMissingColumnError(error)) {
      return NextResponse.json(
        { error: 'Trials not enabled — run migration_v4_6.sql', needsMigration: true }, { status: 501 });
    }
    return NextResponse.json({ error: errMsg(error) }, { status: 500 });
  }
  return NextResponse.json({ success: true, supplierId, trialEndsAt: null });
}
