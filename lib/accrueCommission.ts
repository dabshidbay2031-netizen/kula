import { getSupabaseAdmin } from '@/lib/supabase';
import {
  newlyEarned, COMMISSION_PER_STORE, type StoreForCommission,
} from '@/lib/agentCommission';

/**
 * Record any commission a store's REAL subscription payment has just earned
 * for the field agent who set it up.
 *
 * Called after a successful payment. Deliberately idempotent at two levels:
 *
 *   1. it counts instalments already in the ledger before writing, and
 *   2. `agent_commissions` is keyed on (supplier_id, instalment), so a
 *      duplicate insert is rejected by the database rather than trusted to
 *      application logic.
 *
 * Paying an agent twice for the same month is real money out of the door, so
 * "we check first" is not enough on its own.
 *
 * Never throws: a commission bookkeeping failure must not fail the payment
 * the seller just made.
 */
export async function accrueAgentCommission(supplierId: number): Promise<number> {
  try {
    const sb = getSupabaseAdmin();

    const { data: store, error } = await sb
      .from('suppliers')
      .select('id, registered_by_agent_id, approval_status')
      .eq('id', supplierId)
      .maybeSingle();
    if (error || !store) return 0;

    const agentId = store.registered_by_agent_id as number | null;
    if (agentId == null) return 0;                 // self-registered — nobody to pay

    // The agent themselves must be approved. An unapproved agent earns nothing,
    // however much work they did.
    const { data: agent } = await sb
      .from('suppliers')
      .select('id, agent_approved_at, agent_rejected_at')
      .eq('id', agentId)
      .maybeSingle();
    const agentApproved = !!agent?.agent_approved_at && !agent?.agent_rejected_at;

    // How many REAL payments has this store made? Trials and admin grants are
    // excluded by construction: only 'payment' rows count, never 'grant'.
    const { count: paidMonths } = await sb
      .from('subscription_events')
      .select('id', { count: 'exact', head: true })
      .eq('supplier_id', supplierId)
      .eq('kind', 'payment');

    const { count: already } = await sb
      .from('agent_commissions')
      .select('instalment', { count: 'exact', head: true })
      .eq('supplier_id', supplierId);

    const forStore: StoreForCommission = {
      supplierId,
      agentId,
      approvalStatus: (store.approval_status as string | null) ?? null,
      agentApproved,
      paidMonths: paidMonths ?? 0,
    };

    const due = newlyEarned(forStore, already ?? 0);
    if (!due.length) return 0;

    const rows = due.map(instalment => ({
      supplier_id: supplierId,
      instalment,
      agent_id:    agentId,
      amount:      COMMISSION_PER_STORE,
      status:      'due',
      note:        `Paid month ${instalment} of 3`,
    }));

    // ignoreDuplicates: two payments racing must not both insert instalment 2.
    const { error: insErr } = await sb
      .from('agent_commissions')
      .upsert(rows, { onConflict: 'supplier_id,instalment', ignoreDuplicates: true });
    if (insErr) return 0;

    return rows.length;
  } catch {
    return 0;      // ledger is best-effort; never break the payment path
  }
}
