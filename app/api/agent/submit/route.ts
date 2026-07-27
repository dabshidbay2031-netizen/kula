import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, isMissingColumnError } from '@/lib/apiHelpers';
import { getAuthUser, agentManagesStore, agentSupplierIdFor } from '@/lib/apiAuth';
import { requireApprovedAgent } from '@/lib/agentGate';

/**
 * POST /api/agent/submit  { storeId }
 *
 * The agent has finished setting up a store they registered and submits it for
 * admin review (approval_status → 'pending'). Only the registering agent (while
 * the store is still trial/pending) may call this. An admin then approves via
 * PATCH /api/suppliers/[id] { approvalStatus:'approved' }, which also ends the
 * agent's edit access.
 */
export async function POST(req: Request) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized — sign in required' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const storeId = parseInt(String(body.storeId ?? ''), 10);
  if (Number.isNaN(storeId)) return NextResponse.json({ error: 'storeId required' }, { status: 400 });

  if (!(await agentManagesStore(user.id, storeId))) {
    return NextResponse.json({ error: 'Forbidden — not a store you’re setting up' }, { status: 403 });
  }

  // An unvetted agent cannot put work into the review queue, which is what
  // would otherwise start their commission clock.
  const agentId = await agentSupplierIdFor(user.id);
  if (agentId != null) {
    const barred = await requireApprovedAgent(agentId);
    if (barred) return barred;
  }

  const now = new Date().toISOString();
  const sb = getSupabaseAdmin();
  try {
    const { data, error } = await sb
      .from('suppliers')
      .update({ approval_status: 'pending', approval_requested_at: now, agent_submitted_at: now })
      .eq('id', storeId)
      .select('id, approval_status, agent_submitted_at')
      .single();
    if (error) throw error;
    return NextResponse.json({
      success:        true,
      id:             data.id,
      approvalStatus: data.approval_status,
      submittedAt:    data.agent_submitted_at,
    });
  } catch (e) {
    if (isMissingColumnError(e)) {
      return NextResponse.json(
        { error: 'Agent registration not enabled yet (run migration_v3_9.sql)', needsMigration: true },
        { status: 501 },
      );
    }
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
