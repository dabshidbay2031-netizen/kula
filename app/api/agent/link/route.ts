import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, isMissingColumnError } from '@/lib/apiHelpers';
import { getAuthUser, agentSupplierIdFor } from '@/lib/apiAuth';
import { requireApprovedAgent } from '@/lib/agentGate';

/**
 * POST /api/agent/link  { code }
 *
 * A field agent attaches themselves to a store the owner already created, using
 * the store's link code (shown in that store's own profile). After linking, the
 * agent may set the store up (profile + products) until an admin approves it.
 *
 * Consent model: only the store owner can see/share the code, so linking always
 * requires the owner's cooperation. A store can be registered by at most one
 * agent, and an already-approved store can't be linked.
 */
export async function POST(req: Request) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized — sign in required' }, { status: 401 });

  const agentId = await agentSupplierIdFor(user.id);
  if (agentId == null) {
    return NextResponse.json({ error: 'Only a field-agent account can register stores' }, { status: 403 });
  }
  // An agent must be vetted before they can touch a real store.
  { const barred = await requireApprovedAgent(agentId); if (barred) return barred; }

  const body = await req.json().catch(() => ({}));
  const code = String(body.code ?? '').trim().toUpperCase();
  if (!code) return NextResponse.json({ error: 'Enter the store’s link code' }, { status: 400 });

  const sb = getSupabaseAdmin();
  try {
    const { data: store, error } = await sb
      .from('suppliers')
      .select('id, name, account_type, registered_by_agent_id, approval_status')
      .eq('agent_link_code', code)
      .maybeSingle();
    if (error) throw error;
    if (!store) {
      return NextResponse.json({ error: 'No store found for that code' }, { status: 404 });
    }
    if (store.id === agentId) {
      return NextResponse.json({ error: 'You can’t register your own agent account' }, { status: 400 });
    }
    if ((store.account_type as string) === 'agent') {
      return NextResponse.json({ error: 'That code belongs to another agent, not a store' }, { status: 400 });
    }
    const registrar = store.registered_by_agent_id as number | null;
    if (registrar != null && registrar !== agentId) {
      return NextResponse.json({ error: 'This store is already registered by another agent' }, { status: 409 });
    }
    if ((store.approval_status as string) === 'approved') {
      return NextResponse.json({ error: 'This store is already approved — it can’t be registered' }, { status: 409 });
    }
    if (registrar === agentId) {
      return NextResponse.json({ success: true, storeId: store.id, name: store.name, alreadyLinked: true });
    }

    const { error: upErr } = await sb
      .from('suppliers')
      .update({ registered_by_agent_id: agentId })
      .eq('id', store.id);
    if (upErr) throw upErr;

    return NextResponse.json({ success: true, storeId: store.id, name: store.name }, { status: 201 });
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
