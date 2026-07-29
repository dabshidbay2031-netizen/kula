import { describe, it, expect } from 'vitest';
import {
  deriveSubscription, planForAccountType, priceForAccountType, nextPeriodEnd, periodEndFor,
  SUBSCRIPTION_PRICES, SUBSCRIPTION_TRIAL_DAYS, SUBSCRIPTION_PERIOD_DAYS, SIGNUP_TRIAL_DAYS,
} from '@/lib/subscription';

const DAY = 86_400_000;
const NOW = new Date('2026-07-16T12:00:00Z');
const ago    = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

describe('pricing', () => {
  it('charges suppliers $24.99 and businesses $14.99', () => {
    expect(SUBSCRIPTION_PRICES.supplier).toBe(24.99);
    expect(SUBSCRIPTION_PRICES.business).toBe(14.99);
    expect(priceForAccountType('supplier')).toBe(24.99);
    expect(priceForAccountType('business')).toBe(14.99);
  });

  it('never bills agents or customers', () => {
    expect(planForAccountType('agent')).toBeNull();
    expect(planForAccountType('user')).toBeNull();
    expect(priceForAccountType('agent')).toBeNull();
  });
});

describe('deriveSubscription — locking', () => {
  it('locks a business that has never paid', () => {
    const s = deriveSubscription({ accountType: 'business', subscriptionPaidAt: null }, NOW);
    expect(s.status).toBe('unpaid');
    expect(s.locked).toBe(true);
    expect(s.price).toBe(14.99);
  });

  it('locks a supplier that has never paid', () => {
    const s = deriveSubscription({ accountType: 'supplier', subscriptionPaidAt: null }, NOW);
    expect(s.locked).toBe(true);
    expect(s.price).toBe(24.99);
  });

  it('never locks an agent', () => {
    const s = deriveSubscription({ accountType: 'agent', subscriptionPaidAt: null }, NOW);
    expect(s.locked).toBe(false);
    expect(s.requiresSubscription).toBe(false);
  });

  it('never locks anyone before the billing migration has run', () => {
    // The columns don't exist yet → must not be read as "unpaid".
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: null, billingEnabled: false }, NOW);
    expect(s.locked).toBe(false);
    expect(s.requiresSubscription).toBe(false);
  });

  it('locks again after a refund', () => {
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: ago(2), subscriptionRefundedAt: ago(1) }, NOW);
    expect(s.status).toBe('refunded');
    expect(s.locked).toBe(true);
    expect(s.refundable).toBe(false);
  });
});

describe('deriveSubscription — 7-day money-back window', () => {
  it('is refundable immediately after paying', () => {
    const s = deriveSubscription({ accountType: 'business', subscriptionPaidAt: ago(0) }, NOW);
    expect(s.status).toBe('refundable');
    expect(s.locked).toBe(false);
    expect(s.refundable).toBe(true);
    expect(s.daysLeftToRefund).toBe(SUBSCRIPTION_TRIAL_DAYS);
  });

  it('is still refundable on day 6 and reports days left', () => {
    const s = deriveSubscription({ accountType: 'supplier', subscriptionPaidAt: ago(6) }, NOW);
    expect(s.refundable).toBe(true);
    expect(s.daysLeftToRefund).toBe(1);
  });

  it('is NOT refundable once 7 days have passed — active but locked-in', () => {
    const s = deriveSubscription({ accountType: 'business', subscriptionPaidAt: ago(7) }, NOW);
    expect(s.status).toBe('active');
    expect(s.refundable).toBe(false);
    expect(s.locked).toBe(false);          // still has access — just no refund
    expect(s.daysLeftToRefund).toBe(0);
  });

  it('is not refundable once the window closes, while the month still runs', () => {
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: ago(10), subscriptionPeriodEnd: inDays(20) }, NOW);
    expect(s.status).toBe('active');
    expect(s.refundable).toBe(false);
    expect(s.locked).toBe(false);
  });

  it('sets the refund deadline exactly 7 days after payment', () => {
    const paidAt = ago(1);
    const s = deriveSubscription({ accountType: 'business', subscriptionPaidAt: paidAt }, NOW);
    expect(new Date(s.refundDeadline!).getTime())
      .toBe(new Date(paidAt).getTime() + SUBSCRIPTION_TRIAL_DAYS * DAY);
  });

  it('treats the boundary (exactly 7 days, to the ms) as expired', () => {
    const paidAt = new Date(NOW.getTime() - SUBSCRIPTION_TRIAL_DAYS * DAY).toISOString();
    const s = deriveSubscription({ accountType: 'business', subscriptionPaidAt: paidAt }, NOW);
    expect(s.refundable).toBe(false);
  });
});

describe('deriveSubscription — monthly billing cycle', () => {
  it('keeps access open while the paid month runs, and counts the days left', () => {
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: ago(20), subscriptionPeriodEnd: inDays(10) }, NOW);
    expect(s.status).toBe('active');
    expect(s.locked).toBe(false);
    expect(s.renewalDue).toBe(false);
    expect(s.daysLeftInPeriod).toBe(10);
  });

  it('LOCKS the dashboard once the paid month runs out', () => {
    const s = deriveSubscription(
      { accountType: 'supplier', subscriptionPaidAt: ago(31), subscriptionPeriodEnd: ago(1) }, NOW);
    expect(s.status).toBe('expired');
    expect(s.locked).toBe(true);
    expect(s.renewalDue).toBe(true);
    expect(s.daysLeftInPeriod).toBe(0);
    expect(s.refundable).toBe(false);
  });

  it('treats the period boundary (to the ms) as expired', () => {
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: ago(30), subscriptionPeriodEnd: NOW.toISOString() }, NOW);
    expect(s.locked).toBe(true);
  });

  it('derives a 30-day period from the payment when the column is null', () => {
    const s = deriveSubscription({ accountType: 'business', subscriptionPaidAt: ago(2) }, NOW);
    expect(s.periodEnd).toBe(periodEndFor(ago(2)));
    expect(s.daysLeftInPeriod).toBe(SUBSCRIPTION_PERIOD_DAYS - 2);
    expect(s.locked).toBe(false);
  });

  it('expires a store whose derived month has passed', () => {
    // A payment 400 days ago with no stored period is long overdue.
    const s = deriveSubscription({ accountType: 'business', subscriptionPaidAt: ago(400) }, NOW);
    expect(s.status).toBe('expired');
    expect(s.locked).toBe(true);
  });

  it('does NOT enforce expiry before migration_v4_3 adds the column', () => {
    // Grandfathered stores carry paid_at = created_at; enforcing a month on a
    // DB without the period column would lock every live seller out at deploy.
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: ago(400), monthlyBillingEnabled: false }, NOW);
    expect(s.status).toBe('active');
    expect(s.locked).toBe(false);
    expect(s.periodEnd).toBeNull();
  });

  it('never reports a renewal for account types that do not pay', () => {
    const s = deriveSubscription({ accountType: 'agent', subscriptionPaidAt: ago(400) }, NOW);
    expect(s.locked).toBe(false);
    expect(s.renewalDue).toBe(false);
    expect(s.periodEnd).toBeNull();
  });
});

describe('nextPeriodEnd — renewing must not burn paid time', () => {
  it('extends an unexpired period instead of restarting it', () => {
    const end = nextPeriodEnd(inDays(10), NOW);
    expect(new Date(end).getTime())
      .toBe(NOW.getTime() + (10 + SUBSCRIPTION_PERIOD_DAYS) * DAY);
  });

  it('starts 30 days from today when the period already lapsed', () => {
    const end = nextPeriodEnd(ago(5), NOW);
    expect(new Date(end).getTime()).toBe(NOW.getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY);
  });

  it('starts 30 days from today for a first payment', () => {
    const end = nextPeriodEnd(null, NOW);
    expect(new Date(end).getTime()).toBe(NOW.getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY);
  });
});

describe('admin-granted free trial', () => {
  it('unlocks a store that has never paid', () => {
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: null, trialEndsAt: inDays(7) }, NOW);
    expect(s.status).toBe('trial');
    expect(s.locked).toBe(false);
    expect(s.onTrial).toBe(true);
    expect(s.daysLeftInTrial).toBe(7);
  });

  it('rescues a store whose paid month has expired', () => {
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: ago(40),
        subscriptionPeriodEnd: ago(5), trialEndsAt: inDays(3) }, NOW);
    expect(s.locked).toBe(false);
    expect(s.status).toBe('trial');
  });

  it('locks again the moment the trial lapses', () => {
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: null, trialEndsAt: ago(1) }, NOW);
    expect(s.onTrial).toBe(false);
    expect(s.locked).toBe(true);
    expect(s.status).toBe('unpaid');
  });

  it('does NOT open the money-back window — a trial is not a payment', () => {
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: null, trialEndsAt: inDays(7) }, NOW);
    expect(s.refundable).toBe(false);
    expect(s.paidAt).toBeNull();
  });

  it('leaves a normally-paid store unaffected', () => {
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: ago(10), subscriptionPeriodEnd: inDays(20) }, NOW);
    expect(s.onTrial).toBe(false);
    expect(s.status).toBe('active');
  });
});

describe('opt-in signup free trial', () => {
  /** A store that has CLAIMED the trial `daysAgo` days ago. */
  const newStore = (over: Record<string, unknown> = {}) => deriveSubscription(
    { accountType: 'business', subscriptionPaidAt: null, selfTrialStartedAt: ago(0), ...over }, NOW);

  it('a brand-new store is LOCKED until it chooses — trial or pay', () => {
    // The whole point of opt-in: signing up alone does not open the dashboard.
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: null, selfTrialStartedAt: null }, NOW);
    expect(s.locked).toBe(true);
    expect(s.onTrial).toBe(false);
    expect(s.trialAvailable).toBe(true);   // ...but the offer is there
  });

  it('starts the two weeks when the seller claims it', () => {
    const s = newStore();
    expect(s.onTrial).toBe(true);
    expect(s.locked).toBe(false);
    expect(s.status).toBe('trial');
    expect(s.daysLeftInTrial).toBe(SIGNUP_TRIAL_DAYS);
    expect(s.trialAvailable).toBe(false);  // can't be claimed twice
  });

  it('gives suppliers the same trial, at the supplier price', () => {
    const s = newStore({ accountType: 'supplier' });
    expect(s.onTrial).toBe(true);
    expect(s.locked).toBe(false);
    expect(s.price).toBe(24.99);
  });

  it('still counts down partway through', () => {
    expect(newStore({ selfTrialStartedAt: ago(10) }).daysLeftInTrial).toBe(4);
  });

  it('is never offered again once the store has paid', () => {
    // Pay → cancel → trial again must be impossible.
    const paid = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: ago(2), selfTrialStartedAt: null }, NOW);
    expect(paid.trialAvailable).toBe(false);

    const refunded = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: ago(40),
        subscriptionRefundedAt: ago(1), selfTrialStartedAt: null }, NOW);
    expect(refunded.trialAvailable).toBe(false);
  });

  it('is never offered again once it has been used', () => {
    expect(newStore({ selfTrialStartedAt: ago(90) }).trialAvailable).toBe(false);
  });

  it('locks the moment the trial runs out', () => {
    const s = newStore({ selfTrialStartedAt: ago(SIGNUP_TRIAL_DAYS) });
    expect(s.onTrial).toBe(false);
    expect(s.locked).toBe(true);
    expect(s.status).toBe('unpaid');
    expect(s.renewalDue).toBe(true);
  });

  it('stays locked well after the trial', () => {
    expect(newStore({ selfTrialStartedAt: ago(90) }).locked).toBe(true);
  });

  it('never grants a trial to accounts that do not pay at all', () => {
    for (const accountType of ['agent', 'user']) {
      const s = newStore({ accountType });
      expect(s.onTrial).toBe(false);
      expect(s.requiresSubscription).toBe(false);
      expect(s.locked).toBe(false);
    }
  });

  it('is not a payment — no money-back window opens', () => {
    const s = newStore();
    expect(s.refundable).toBe(false);
    expect(s.paidAt).toBeNull();
    expect(s.periodEnd).toBeNull();
  });

  // Once money has changed hands the paid month governs, or a seller who paid
  // on day 1 would look like they were still on trial for another 13 days.
  it('defers to the paid month once the store has paid', () => {
    const s = newStore({ subscriptionPaidAt: ago(1), subscriptionPeriodEnd: inDays(29) });
    expect(s.onTrial).toBe(false);
    expect(s.status).toBe('refundable');
    expect(s.locked).toBe(false);
  });

  // "Your store access will be locked until you pay again" is what the refund
  // button promises; a leftover signup trial would quietly break that promise.
  it('does not reopen a refunded store that is still inside its first two weeks', () => {
    const s = newStore({ subscriptionPaidAt: ago(2), subscriptionRefundedAt: ago(1) });
    expect(s.onTrial).toBe(false);
    expect(s.locked).toBe(true);
    expect(s.status).toBe('refunded');
  });

  it('takes whichever trial runs longer when an admin also grants one', () => {
    // Admin grant reaches further than the signup trial.
    const granted = newStore({ selfTrialStartedAt: ago(13), trialEndsAt: inDays(30) });
    expect(granted.daysLeftInTrial).toBe(30);

    // Signup trial reaches further than a short admin grant.
    const signup = newStore({ selfTrialStartedAt: ago(0), trialEndsAt: inDays(2) });
    expect(signup.daysLeftInTrial).toBe(SIGNUP_TRIAL_DAYS);
  });

  it('lets an admin grant still rescue a lapsed or refunded store', () => {
    const s = newStore({
      selfTrialStartedAt: ago(90), subscriptionPaidAt: ago(60),
      subscriptionRefundedAt: ago(59), trialEndsAt: inDays(5),
    });
    expect(s.onTrial).toBe(true);
    expect(s.locked).toBe(false);
  });

  // An older DB without the column must not silently hand out endless access.
  it('grants no signup trial when the column is missing', () => {
    const s = deriveSubscription(
      { accountType: 'business', subscriptionPaidAt: null, trialStartedAt: null }, NOW);
    expect(s.onTrial).toBe(false);
    expect(s.locked).toBe(true);
  });

  it('treats an unparseable timestamp as no trial, not an endless one', () => {
    const s = newStore({ selfTrialStartedAt: 'not-a-date' });
    expect(s.onTrial).toBe(false);
    expect(s.locked).toBe(true);
  });

  // billingEnabled === false means the billing columns are not deployed; that
  // must keep overriding everything, trial included.
  it('never locks while billing is not deployed', () => {
    const s = newStore({ selfTrialStartedAt: ago(90), billingEnabled: false });
    expect(s.locked).toBe(false);
  });
});

describe('paying during the trial keeps the remaining days', () => {
  it('starts the paid month at the trial end, not today', () => {
    const trialEnd = inDays(9);
    // What the API passes to nextPeriodEnd when a trial is still running.
    const end = nextPeriodEnd(trialEnd, NOW);
    expect(new Date(end).getTime())
      .toBe(new Date(trialEnd).getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY);
  });

  it('does not shorten the month for someone who waits until the trial ends', () => {
    const end = nextPeriodEnd(null, NOW);
    expect(new Date(end).getTime()).toBe(NOW.getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY);
  });
});
