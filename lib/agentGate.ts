import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

/**
 * Is this field agent approved to work?
 *
 * An agent who signs up is PENDING. Until an admin approves them they cannot
 * link a store or submit one for review — so nobody unvetted ever touches a
 * real business, and no work can accrue commission before you've checked who
 * they are.
 *
 * Returns a Response to send back when the agent is barred, or null to proceed.
 * Before migration_v4_6 the columns don't exist; the gate then stays OPEN so
 * existing agents keep working rather than being locked out by a deploy.
 */
export async function requireApprovedAgent(agentId: number): Promise<Response | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('suppliers')
      .select('id, agent_approved_at, agent_rejected_at')
      .eq('id', agentId)
      .maybeSingle();

    // Column missing (pre-migration) → don't block anyone.
    if (error || !data) return null;
    if (!('agent_approved_at' in data)) return null;

    if (data.agent_rejected_at) {
      return NextResponse.json(
        { error: 'Your agent account was not approved. Contact the Hamar Mall team.' },
        { status: 403 });
    }
    if (!data.agent_approved_at) {
      return NextResponse.json(
        { error: 'Your agent account is awaiting approval. You can register stores once an admin approves you.' },
        { status: 403 });
    }
    return null;
  } catch {
    return null;      // never let a lookup failure block a legitimate agent
  }
}

/** True when this agent may earn commission (used by the accrual path). */
export async function isAgentApproved(agentId: number): Promise<boolean> {
  try {
    const { data } = await getSupabaseAdmin()
      .from('suppliers')
      .select('agent_approved_at, agent_rejected_at')
      .eq('id', agentId)
      .maybeSingle();
    if (!data) return false;
    return !!data.agent_approved_at && !data.agent_rejected_at;
  } catch { return false; }
}
