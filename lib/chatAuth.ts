import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/apiAuth';
import { getCashierActor } from '@/lib/cashierAuth';

/**
 * Chat authorization — the single gate every /api/conversations route uses.
 *
 * Chat threads hang off the store OWNER's account, and STAFF with the 'chat'
 * privilege work that same inbox on the owner's behalf (ChatListView sends
 * `actor.ownerUserId`, which for a cashier is `cashier.businessId`). A cashier
 * holds NO Supabase JWT, so a plain `getAuthUser` check 401s every one of them
 * and silently kills staff chat. Both credential types resolve here to the ONE
 * identity the caller may act as.
 *
 * Everything downstream compares against that resolved id, never a value from
 * the query string — which also closes the filter-injection hole that raw
 * `userId` interpolation opened.
 */

export interface ChatIdentity {
  /** The user id whose threads this caller may read/write. */
  userId:    string;
  isStaff:   boolean;
  staffName: string | null;
}

type Resolved = { ok: true; identity: ChatIdentity } | { ok: false; res: Response };

export async function resolveChatIdentity(req: Request): Promise<Resolved> {
  const user = await getAuthUser(req);
  if (user) {
    return { ok: true, identity: { userId: user.id, isStaff: false, staffName: null } };
  }
  const actor = await getCashierActor(req);
  if (!actor) {
    return { ok: false, res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!actor.privileges.includes('chat')) {
    return { ok: false, res: NextResponse.json({ error: 'Forbidden — no chat privilege' }, { status: 403 }) };
  }
  return { ok: true, identity: { userId: actor.ownerUserId, isStaff: true, staffName: actor.name } };
}

/** Resolve the caller, then require they are acting as exactly `wantedUserId`. */
export async function requireChatIdentity(req: Request, wantedUserId: string | null): Promise<Resolved> {
  const r = await resolveChatIdentity(req);
  if (!r.ok) return r;
  if (!wantedUserId || wantedUserId !== r.identity.userId) {
    return { ok: false, res: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return r;
}

/** Resolve the caller and require membership of `convId`. */
export async function requireChatMember(req: Request, convId: string): Promise<Resolved> {
  const r = await resolveChatIdentity(req);
  if (!r.ok) return r;

  const { data } = await getSupabaseAdmin()
    .from('conversations').select('user_id_1, user_id_2').eq('id', convId).maybeSingle();
  if (!data) return { ok: false, res: NextResponse.json({ error: 'Conversation not found' }, { status: 404 }) };

  const members = [String(data.user_id_1), String(data.user_id_2)];
  if (!members.includes(r.identity.userId)) {
    return { ok: false, res: NextResponse.json({ error: 'Forbidden — not a participant' }, { status: 403 }) };
  }
  return r;
}

/**
 * Has either side blocked the other? Delivery is symmetric: a blocked person
 * must not reach the blocker, and the blocker stops receiving from them.
 * Returns false when the table isn't deployed, so chat keeps working before
 * migration_v4_4 runs rather than failing closed on every send.
 */
export async function isBlockedEitherDirection(a: string, b: string): Promise<boolean> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('blocked_users')
      .select('blocker_uid')
      .or(`and(blocker_uid.eq.${a},blocked_uid.eq.${b}),and(blocker_uid.eq.${b},blocked_uid.eq.${a})`)
      .limit(1);
    if (error) return false;
    return (data ?? []).length > 0;
  } catch { return false; }
}

/** Everyone this user has blocked or been blocked by — used to hide threads. */
export async function blockedCounterparts(userId: string): Promise<Set<string>> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('blocked_users')
      .select('blocker_uid, blocked_uid')
      .or(`blocker_uid.eq.${userId},blocked_uid.eq.${userId}`);
    if (error) return new Set();
    const out = new Set<string>();
    for (const row of data ?? []) {
      out.add(String(row.blocker_uid) === userId ? String(row.blocked_uid) : String(row.blocker_uid));
    }
    return out;
  } catch { return new Set(); }
}
