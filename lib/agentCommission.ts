/**
 * Field-agent commission.
 *
 * An agent is paid a FIXED amount per store they register and fully set up,
 * and that same amount again for the store's next two paid months — three
 * instalments in total. 50 stores set up once therefore earns $300/month for
 * three months, then stops.
 *
 * Two rules decide everything here, and both exist to make sure the platform
 * never pays out money it has not received:
 *
 *   1. Instalment 1 is earned when an admin APPROVES the setup **and** the
 *      store has made a real subscription payment.
 *   2. Instalments 2 and 3 are earned by the store's 2nd and 3rd real
 *      payments. If the store lapses, the agent simply stops earning.
 *
 * An admin-granted free trial is NOT a payment. It unlocks the dashboard, but
 * it earns the agent nothing — otherwise an agent could farm trials for cash.
 */

export const COMMISSION_PER_STORE   = 6;   // USD per instalment
export const COMMISSION_INSTALMENTS = 3;   // paid for 3 paid months

export type CommissionStatus = 'due' | 'paid';

export interface CommissionRow {
  supplierId: number;
  agentId:    number;
  /** 1, 2 or 3. */
  instalment: number;
  amount:     number;
  status:     CommissionStatus;
  earnedAt:   string;
  paidAt:     string | null;
}

export interface StoreForCommission {
  supplierId:      number;
  agentId:         number | null;
  /** approval_status — the agent's setup must be signed off. */
  approvalStatus:  string | null;
  /** Agent accounts must be approved before any of their work pays out. */
  agentApproved:   boolean;
  /** REAL subscription payments only. Trials and grants are excluded. */
  paidMonths:      number;
}

/**
 * How many instalments this store has earned for its agent so far.
 * Never more than COMMISSION_INSTALMENTS, never negative.
 */
export function earnedInstalments(store: StoreForCommission): number {
  if (store.agentId == null) return 0;            // self-registered store
  if (!store.agentApproved) return 0;             // agent not vetted yet
  if (store.approvalStatus !== 'approved') return 0;  // setup not signed off
  const paid = Math.max(0, Math.trunc(store.paidMonths));
  return Math.min(paid, COMMISSION_INSTALMENTS);
}

/**
 * Which instalment numbers are newly earned, given what's already recorded.
 * Returns [] when nothing new is due — safe to call after every payment.
 */
export function newlyEarned(store: StoreForCommission, alreadyRecorded: number): number[] {
  const earned = earnedInstalments(store);
  const from   = Math.max(0, Math.trunc(alreadyRecorded));
  const out: number[] = [];
  for (let n = from + 1; n <= earned; n++) out.push(n);
  return out;
}

/** What the platform still owes this agent. */
export function owedToAgent(rows: CommissionRow[]): number {
  const cents = rows
    .filter(r => r.status === 'due')
    .reduce((sum, r) => sum + Math.round((Number(r.amount) || 0) * 100), 0);
  return cents / 100;
}

export function paidToAgent(rows: CommissionRow[]): number {
  const cents = rows
    .filter(r => r.status === 'paid')
    .reduce((sum, r) => sum + Math.round((Number(r.amount) || 0) * 100), 0);
  return cents / 100;
}

export interface AgentEarnings {
  agentId:      number;
  storesSetUp:  number;   // distinct stores that earned at least one instalment
  due:          number;
  paid:         number;
  total:        number;
}

/** Roll a flat list of commission rows into a per-agent payout summary. */
export function summariseByAgent(rows: CommissionRow[]): AgentEarnings[] {
  const byAgent = new Map<number, { due: CommissionRow[]; stores: Set<number> }>();
  for (const r of rows) {
    const e = byAgent.get(r.agentId) ?? { due: [], stores: new Set<number>() };
    e.due.push(r);
    e.stores.add(r.supplierId);
    byAgent.set(r.agentId, e);
  }
  return Array.from(byAgent.entries())
    .map(([agentId, e]) => {
      const due  = owedToAgent(e.due);
      const paid = paidToAgent(e.due);
      return {
        agentId,
        storesSetUp: e.stores.size,
        due, paid,
        total: Math.round((due + paid) * 100) / 100,
      };
    })
    .sort((a, b) => b.due - a.due);   // who to pay first
}

/** The most an agent can ever earn from a given number of stores. */
export function maxEarnings(stores: number): number {
  return stores * COMMISSION_PER_STORE * COMMISSION_INSTALMENTS;
}
