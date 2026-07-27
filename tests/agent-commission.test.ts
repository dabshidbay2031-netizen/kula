import { describe, it, expect } from 'vitest';
import {
  earnedInstalments, newlyEarned, owedToAgent, paidToAgent, summariseByAgent,
  maxEarnings, COMMISSION_PER_STORE, COMMISSION_INSTALMENTS,
  type StoreForCommission, type CommissionRow,
} from '@/lib/agentCommission';

const store = (o: Partial<StoreForCommission> = {}): StoreForCommission => ({
  supplierId: 1, agentId: 9, approvalStatus: 'approved',
  agentApproved: true, paidMonths: 1, ...o,
});

const row = (o: Partial<CommissionRow> = {}): CommissionRow => ({
  supplierId: 1, agentId: 9, instalment: 1, amount: COMMISSION_PER_STORE,
  status: 'due', earnedAt: '2026-07-01T00:00:00Z', paidAt: null, ...o,
});

describe('the deal: $6 per store, three paid months', () => {
  it('is $6 and 3 instalments', () => {
    expect(COMMISSION_PER_STORE).toBe(6);
    expect(COMMISSION_INSTALMENTS).toBe(3);
  });

  it('50 stores taken all the way is $900 total, i.e. $300 a month for 3 months', () => {
    expect(maxEarnings(50)).toBe(900);
    expect(50 * COMMISSION_PER_STORE).toBe(300);
  });
});

describe('what earns an instalment', () => {
  it('one paid month earns one instalment', () => {
    expect(earnedInstalments(store({ paidMonths: 1 }))).toBe(1);
  });

  it('three paid months earn all three', () => {
    expect(earnedInstalments(store({ paidMonths: 3 }))).toBe(3);
  });

  it('STOPS at three however long the store stays', () => {
    expect(earnedInstalments(store({ paidMonths: 12 }))).toBe(3);
  });

  it('earns nothing before the store has paid at all', () => {
    // This is the trial case: access granted, no money received, no commission.
    expect(earnedInstalments(store({ paidMonths: 0 }))).toBe(0);
  });
});

describe('gates that stop money going out wrongly', () => {
  it('a self-registered store earns nobody anything', () => {
    expect(earnedInstalments(store({ agentId: null }))).toBe(0);
  });

  it('an UNAPPROVED agent earns nothing, however much they did', () => {
    expect(earnedInstalments(store({ agentApproved: false, paidMonths: 3 }))).toBe(0);
  });

  it('a setup that has not been signed off earns nothing', () => {
    expect(earnedInstalments(store({ approvalStatus: 'pending', paidMonths: 2 }))).toBe(0);
    expect(earnedInstalments(store({ approvalStatus: null }))).toBe(0);
  });
});

describe('accrual is idempotent — never pay the same month twice', () => {
  it('returns the instalments not yet recorded', () => {
    expect(newlyEarned(store({ paidMonths: 2 }), 0)).toEqual([1, 2]);
    expect(newlyEarned(store({ paidMonths: 2 }), 1)).toEqual([2]);
  });

  it('returns nothing when everything earned is already recorded', () => {
    expect(newlyEarned(store({ paidMonths: 2 }), 2)).toEqual([]);
    expect(newlyEarned(store({ paidMonths: 3 }), 3)).toEqual([]);
  });

  it('never re-earns after the cap, even on the 10th payment', () => {
    expect(newlyEarned(store({ paidMonths: 10 }), 3)).toEqual([]);
  });

  it('cannot go backwards if the ledger somehow holds more than earned', () => {
    expect(newlyEarned(store({ paidMonths: 1 }), 3)).toEqual([]);
  });
});

describe('payout totals', () => {
  const rows = [
    row({ supplierId: 1, instalment: 1, status: 'paid', paidAt: 'x' }),
    row({ supplierId: 1, instalment: 2, status: 'due' }),
    row({ supplierId: 2, instalment: 1, status: 'due' }),
    row({ supplierId: 3, instalment: 1, status: 'due', agentId: 7 }),
  ];

  it('adds up what is still owed', () => {
    expect(owedToAgent(rows)).toBe(18);
    expect(paidToAgent(rows)).toBe(6);
  });

  it('rounds money in cents, not floating point', () => {
    const odd = [row({ amount: 0.1 }), row({ supplierId: 2, amount: 0.2 })];
    expect(owedToAgent(odd)).toBe(0.3);
  });

  it('summarises per agent, biggest debt first', () => {
    const s = summariseByAgent(rows);
    expect(s[0].agentId).toBe(9);
    expect(s[0].due).toBe(12);
    expect(s[0].paid).toBe(6);
    expect(s[0].storesSetUp).toBe(2);
    expect(s[1].agentId).toBe(7);
    expect(s[1].due).toBe(6);
  });
});
