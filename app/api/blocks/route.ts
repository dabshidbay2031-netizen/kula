import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/apiAuth';
import { isMissingTableError } from '@/lib/apiHelpers';

/**
 * Block / unblock endpoints. A block is one-directional: A blocks B means A no
 * longer wants to hear from B. The message-send route checks BOTH directions
 * (A blocked B OR B blocked A) and refuses the send — so either side can end
 * the conversation. See migration_v4_4.sql for the table + RLS.
 *
 * All handlers require a signed-in user; RLS already restricts a user to their
 * own block rows, and we double-check auth.uid() == caller here.
 */

/* GET /api/blocks — list the users the caller has blocked. */
export async function GET(req: Request) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('blocked_users')
      .select('blocked_uid, created_at')
      .eq('blocker_uid', user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json((data ?? []).map(r => r.blocked_uid));
  } catch (e) {
    // Table not deployed yet → behave as "nobody blocked".
    if (isMissingTableError(e)) return NextResponse.json([]);
    return NextResponse.json({ error: 'Failed to load blocks' }, { status: 500 });
  }
}

/* POST /api/blocks — block a user. Body: { blockedUid } */
export async function POST(req: Request) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { blockedUid } = await req.json().catch(() => ({}));
  if (!blockedUid || typeof blockedUid !== 'string') {
    return NextResponse.json({ error: 'blockedUid required' }, { status: 400 });
  }
  if (blockedUid === user.id) {
    return NextResponse.json({ error: 'Cannot block yourself' }, { status: 400 });
  }
  try {
    // upsert via insert .. on conflict do nothing (PK is (blocker_uid, blocked_uid))
    const { error } = await getSupabaseAdmin()
      .from('blocked_users')
      .upsert({ blocker_uid: user.id, blocked_uid: blockedUid });
    if (error) throw error;
    return NextResponse.json({ ok: true, blocked: true }, { status: 201 });
  } catch (e) {
    if (isMissingTableError(e)) {
      return NextResponse.json(
        { error: 'Block feature not deployed. Run supabase/migration_v4_4.sql.' },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: 'Failed to block user' }, { status: 500 });
  }
}

/* DELETE /api/blocks?blockedUid=X — unblock a user. */
export async function DELETE(req: Request) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const blockedUid = new URL(req.url).searchParams.get('blockedUid');
  if (!blockedUid) {
    return NextResponse.json({ error: 'blockedUid required' }, { status: 400 });
  }
  try {
    const { error } = await getSupabaseAdmin()
      .from('blocked_users')
      .delete()
      .eq('blocker_uid', user.id)
      .eq('blocked_uid', blockedUid);
    if (error) throw error;
    return NextResponse.json({ ok: true, blocked: false });
  } catch (e) {
    if (isMissingTableError(e)) return NextResponse.json({ ok: true, blocked: false });
    return NextResponse.json({ error: 'Failed to unblock user' }, { status: 500 });
  }
}
