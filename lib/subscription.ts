/**
 * Seller subscription model — shared client + server (no secrets here).
 *
 * Business and supplier accounts pay a MONTHLY access fee to use the store
 * dashboard. Each payment buys exactly one 30-day billing period; when that
 * period ends the account is locked again until it renews. The first 7 days
 * after a payment are a MONEY-BACK GUARANTEE window — a full self-service
 * refund is available any time inside it, and never after. A locked account
 * can still sign in and reach billing; only the store dashboard is blocked.
 *
 * Agents and customers ('user') never pay — they are not gated.
 */

export const SUBSCRIPTION_TRIAL_DAYS  = 7;               // money-back window
export const SUBSCRIPTION_PERIOD_DAYS = 30;              // one paid month
/**
 * How early to start warning that the month is running out. Five days was too
 * late for a market paying by mobile wallet — a seller who is travelling or
 * short of funds needs more than a long weekend before the dashboard locks.
 */
export const SUBSCRIPTION_NOTICE_DAYS = 14;
export const SUBSCRIPTION_CURRENCY    = 'USD';
export const SUBSCRIPTION_PRICES = { supplier: 24.99, business: 14.99 } as const;

export type BillablePlan       = 'supplier' | 'business';
export type SubscriptionStatus = 'unpaid' | 'refundable' | 'active' | 'expired' | 'refunded';

const DAY_MS = 86_400_000;

/** End of the billing period a payment made at `paidAt` buys. */
export function periodEndFor(paidAt: string | Date): string {
  return new Date(new Date(paidAt).getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY_MS).toISOString();
}

/**
 * End of the period a payment made *now* buys. Renewing early must not throw
 * away time already paid for, so an unexpired period is extended, not replaced.
 */
export function nextPeriodEnd(currentPeriodEnd: string | null | undefined, now: Date = new Date()): string {
  const cur  = currentPeriodEnd ? new Date(currentPeriodEnd).getTime() : 0;
  const from = Math.max(cur, now.getTime());
  return new Date(from + SUBSCRIPTION_PERIOD_DAYS * DAY_MS).toISOString();
}

/** The plan a given account type must pay for, or null if it never pays. */
export function planForAccountType(t?: string | null): BillablePlan | null {
  if (t === 'supplier') return 'supplier';
  if (t === 'business') return 'business';
  return null;
}

export function priceForAccountType(t?: string | null): number | null {
  const plan = planForAccountType(t);
  return plan ? SUBSCRIPTION_PRICES[plan] : null;
}

/** The subset of supplier fields the derivation reads (camelCase, as the API returns them). */
export interface SubscriptionInput {
  accountType?:             string | null;
  subscriptionPaidAt?:      string | null;
  subscriptionRefundedAt?:  string | null;
  /** End of the paid month. Null with the column present = derive from paidAt. */
  subscriptionPeriodEnd?:   string | null;
  /**
   * False when the DB has no subscription columns yet (migration_subscriptions.sql
   * not run). Without this, an absent column reads as "never paid" and would lock
   * every existing seller out. Absent/undefined = assume enabled.
   */
  billingEnabled?:          boolean;
  /**
   * False when subscription_period_end doesn't exist yet (migration_v4_3.sql not
   * run). Monthly expiry is then not enforced — otherwise every grandfathered
   * store, backfilled with `paid_at = created_at`, would look months overdue and
   * lock out the moment this code deploys. Absent/undefined = assume enabled.
   */
  monthlyBillingEnabled?:   boolean;
}

export interface SubscriptionState {
  requiresSubscription: boolean;          // does this account type pay at all?
  plan:            BillablePlan | null;
  price:           number | null;
  status:          SubscriptionStatus;
  locked:          boolean;               // dashboard blocked until they pay
  refundable:      boolean;               // inside the 7-day money-back window
  paidAt:          string | null;
  refundedAt:      string | null;
  refundDeadline:  string | null;         // ISO — end of the money-back window
  daysLeftToRefund: number;               // whole days remaining (0 once past)
  periodEnd:       string | null;         // ISO — when this paid month runs out
  daysLeftInPeriod: number;               // whole days until renewal is due (0 once due)
  renewalDue:      boolean;               // period has run out — pay to continue
}

/** Pure: turn stored subscription fields into a UI/enforcement state. */
export function deriveSubscription(
  s: SubscriptionInput | null | undefined,
  now: Date = new Date(),
): SubscriptionState {
  const plan  = planForAccountType(s?.accountType);
  const price = plan ? SUBSCRIPTION_PRICES[plan] : null;

  // Billing columns not deployed yet → never lock anyone. (An absent column
  // is indistinguishable from "unpaid" on the client, so the API flags it.)
  if (s?.billingEnabled === false) {
    return {
      requiresSubscription: false, plan, price,
      status: 'active', locked: false, refundable: false,
      paidAt: null, refundedAt: null, refundDeadline: null, daysLeftToRefund: 0,
      periodEnd: null, daysLeftInPeriod: 0, renewalDue: false,
    };
  }

  // Account types that never pay (agent / user) are always unlocked.
  if (!plan) {
    return {
      requiresSubscription: false, plan: null, price: null,
      status: 'active', locked: false, refundable: false,
      paidAt: null, refundedAt: null, refundDeadline: null, daysLeftToRefund: 0,
      periodEnd: null, daysLeftInPeriod: 0, renewalDue: false,
    };
  }

  const paidAt     = s?.subscriptionPaidAt ?? null;
  const refundedAt = s?.subscriptionRefundedAt ?? null;

  // Refunded, or never paid → locked, must (re)pay.
  if (refundedAt || !paidAt) {
    return {
      requiresSubscription: true, plan, price,
      status: refundedAt ? 'refunded' : 'unpaid',
      locked: true, refundable: false,
      paidAt, refundedAt, refundDeadline: null, daysLeftToRefund: 0,
      periodEnd: null, daysLeftInPeriod: 0, renewalDue: true,
    };
  }

  const deadline = new Date(new Date(paidAt).getTime() + SUBSCRIPTION_TRIAL_DAYS * DAY_MS);
  const within   = now.getTime() < deadline.getTime();
  const daysLeft = within ? Math.ceil((deadline.getTime() - now.getTime()) / DAY_MS) : 0;

  // The paid month. Stores billed before the period column existed fall back to
  // 30 days from their payment; if the column isn't deployed at all, monthly
  // expiry is simply not enforced yet (see monthlyBillingEnabled).
  const monthly   = s?.monthlyBillingEnabled !== false;
  const periodEnd = monthly ? (s?.subscriptionPeriodEnd ?? periodEndFor(paidAt)) : null;
  const expired   = periodEnd != null && now.getTime() >= new Date(periodEnd).getTime();
  const daysInPeriod = periodEnd && !expired
    ? Math.ceil((new Date(periodEnd).getTime() - now.getTime()) / DAY_MS)
    : 0;

  // An expired month locks the dashboard. There is nothing left to refund by
  // then — a paid month always outlives its 7-day money-back window.
  return {
    requiresSubscription: true, plan, price,
    status: expired ? 'expired' : within ? 'refundable' : 'active',
    locked: expired,
    refundable: within && !expired,
    paidAt, refundedAt: null,
    refundDeadline: deadline.toISOString(),
    daysLeftToRefund: daysLeft,
    periodEnd,
    daysLeftInPeriod: daysInPeriod,
    renewalDue: expired,
  };
}

/** A friendly label for a plan. */
export function planLabel(plan: BillablePlan | null): string {
  if (plan === 'supplier') return 'Supplier';
  if (plan === 'business') return 'Business';
  return '—';
}
