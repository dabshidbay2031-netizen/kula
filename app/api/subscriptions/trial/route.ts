import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getAuthUser, ownsStoreOrAdmin } from '@/lib/apiAuth';
import { errMsg, isMissingColumnError } from '@/lib/apiHelpers';
import { deriveSubscription, SIGNUP_TRIAL_DAYS } from '@/lib/subscription';

/**
 * POST /api/subscriptions/trial  { supplierId }
 *
 * Starts the seller's one and only 14-day free trial.
 *
 * Eligibility is decided HERE, from the stored row — never from anything the
 * client sends. A store qualifies only if it has never paid and has never
 * taken the trial, so:
 *
 *   • paying closes the offer permanently (no pay → cancel → trial again)
 *   • the trial can be claimed exactly once
 *
 * The write is conditional on self_trial_started_at still being NULL, so two
 * taps on a slow connection cannot restart the clock and hand out 28 days.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const supplierId = parseInt(String(body.supplierId ?? ''), 10);
  if (Number.isNaN(supplierId)) {
    return NextResponse.json({ error: 'supplierId required' }, { status: 400 });
  }

  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await ownsStoreOrAdmin(user.id, supplierId))) {
    return NextResponse.json({ error: 'Forbidden — not your store' }, { status: 403 });
  }

  const sb = getSupabaseAdmin();
  const { data: row, error: readErr } = await sb
    .from('suppliers').select('*').eq('id', supplierId).maybeSingle();
  if (readErr || !row) {
    return NextResponse.json({ error: 'Store not found' }, { status: 404 });
  }

  if (!('self_trial_started_at' in row)) {
    return NextResponse.json(
      { error: 'Free trials not enabled — run migration_v4_7.sql', needsMigration: true },
      { status: 501 });
  }

  const state = deriveSubscription({
    accountType:            row.account_type as string,
    subscriptionPaidAt:     (row.subscription_paid_at as string | null) ?? null,
    subscriptionRefundedAt: (row.subscription_refunded_at as string | null) ?? null,
    subscriptionPeriodEnd:  (row.subscription_period_end as string | null) ?? null,
    trialEndsAt:            (row.trial_ends_at as string | null) ?? null,
    selfTrialStartedAt:     (row.self_trial_started_at as string | null) ?? null,
  });

  if (!state.requiresSubscription) {
    return NextResponse.json({ error: 'This account type has no subscription.' }, { status: 400 });
  }
  if (!state.trialAvailable) {
    return NextResponse.json({
      error: state.paidAt
        ? 'Your subscription is already active — the free trial is only for new stores.'
        : 'You have already used your free trial.',
      ...state,
    }, { status: 409 });
  }

  const startedAt = new Date().toISOString();
  const { data: updated, error } = await sb
    .from('suppliers')
    .update({ self_trial_started_at: startedAt })
    .eq('id', supplierId)
    .is('self_trial_started_at', null)   // ← a double tap cannot restart it
    .select('self_trial_started_at')
    .maybeSingle();

  if (error) {
    if (isMissingColumnError(error)) {
      return NextResponse.json(
        { error: 'Free trials not enabled — run migration_v4_7.sql', needsMigration: true },
        { status: 501 });
    }
    return NextResponse.json({ error: errMsg(error) }, { status: 500 });
  }
  // No row came back: someone else won the race. Not an error — the trial IS
  // running, just started by the other request.
  const started = updated?.self_trial_started_at ?? startedAt;

  const after = deriveSubscription({
    accountType:            row.account_type as string,
    subscriptionPaidAt:     null,
    subscriptionRefundedAt: null,
    trialEndsAt:            (row.trial_ends_at as string | null) ?? null,
    selfTrialStartedAt:     String(started),
  });

  return NextResponse.json({ success: true, days: SIGNUP_TRIAL_DAYS, ...after }, { status: 201 });
}
