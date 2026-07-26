import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, isMissingTableError } from '@/lib/apiHelpers';
import { requireChatIdentity, resolveChatIdentity, blockedCounterparts, isBlockedEitherDirection } from '@/lib/chatAuth';
import { resolveChatUser } from '@/lib/chatHelpers';

/* ── helpers ─────────────────────────────────────── */
function mapConv(c: Record<string, unknown>) {
  return {
    id:        c.id,
    userId1:   c.user_id_1,
    userId2:   c.user_id_2,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

/**
 * GET /api/conversations?userId=X
 * Returns all conversations involving this user, ordered newest first.
 * Includes the last message and unread count for each.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const wanted = searchParams.get('userId');

  // Auth: a conversation list is private to its owner. Staff with the 'chat'
  // privilege resolve to the store owner's id so the shared inbox keeps
  // working for them (a cashier has no JWT — see lib/chatAuth).
  const auth = await requireChatIdentity(req, wanted);
  if (!auth.ok) return auth.res;
  const userId = auth.identity.userId;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('conversations')
      .select('*')
      .or(`user_id_1.eq.${userId},user_id_2.eq.${userId}`)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    // Threads with anyone either side has blocked don't belong in the inbox.
    const blocked = await blockedCounterparts(userId);
    const rows = (data ?? []).filter(c =>
      !blocked.has(String(c.user_id_1) === userId ? String(c.user_id_2) : String(c.user_id_1)));

    // Two DB round trips total instead of two PER conversation, and the other
    // participant's profile is embedded so the client doesn't then fire N more
    // requests of its own. An inbox of 100 threads was costing 300+ requests.
    const ids = rows.map(c => c.id);
    const [{ data: lastMsgs }, { data: unreadRows }] = await Promise.all([
      ids.length
        ? getSupabaseAdmin().from('messages').select('*')
            .in('conversation_id', ids).order('created_at', { ascending: false })
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      ids.length
        ? getSupabaseAdmin().from('messages').select('conversation_id')
            .in('conversation_id', ids).neq('sender_id', userId).is('read_at', null)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    ]);

    // Newest-first ordering means the FIRST row seen per conversation is its
    // last message.
    const lastByConv = new Map<string, Record<string, unknown>>();
    for (const m of (lastMsgs ?? []) as Record<string, unknown>[]) {
      const cid = String(m.conversation_id);
      if (!lastByConv.has(cid)) lastByConv.set(cid, m);
    }
    const unreadByConv = new Map<string, number>();
    for (const r of (unreadRows ?? []) as Record<string, unknown>[]) {
      const cid = String(r.conversation_id);
      unreadByConv.set(cid, (unreadByConv.get(cid) ?? 0) + 1);
    }

    const enriched = await Promise.all(rows.map(async (conv) => {
      const otherUserId = conv.user_id_1 === userId ? conv.user_id_2 : conv.user_id_1;
      const lastMsg = lastByConv.get(String(conv.id)) ?? null;
      return {
        ...mapConv(conv),
        otherUserId,
        otherUser: await resolveChatUser(String(otherUserId)),
        lastMessage: lastMsg ? {
          id:          lastMsg.id,
          content:     lastMsg.content,
          imageUrl:    lastMsg.image_url,
          messageType: lastMsg.message_type,
          senderId:    lastMsg.sender_id,
          createdAt:   lastMsg.created_at,
        } : null,
        unreadCount: unreadByConv.get(String(conv.id)) ?? 0,
      };
    }));

    return NextResponse.json(enriched);
  } catch (e) {
    if (isMissingTableError(e)) return NextResponse.json([]);
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

/**
 * POST /api/conversations
 * Find existing conversation between two users, or create one.
 * Body: { userId1, userId2 }
 */
export async function POST(req: Request) {
  const { userId1, userId2 } = await req.json();
  if (!userId1 || !userId2) {
    return NextResponse.json({ error: 'userId1 and userId2 required' }, { status: 400 });
  }
  if (userId1 === userId2) {
    return NextResponse.json({ error: 'Cannot chat with yourself' }, { status: 400 });
  }

  // Auth: only a participant of the new conversation may open it. Without this,
  // anyone could force-create a chat between two arbitrary users (e.g. an
  // attacker pre-seeding a victim's inbox).
  const auth = await resolveChatIdentity(req);
  if (!auth.ok) return auth.res;
  const me = auth.identity.userId;
  if (me !== userId1 && me !== userId2) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // A blocked pair may not open a fresh thread either.
  const other = me === userId1 ? userId2 : userId1;
  if (await isBlockedEitherDirection(me, other)) {
    return NextResponse.json({ error: 'You cannot start a conversation with this user.' }, { status: 403 });
  }

  // Normalize: always store smaller id first to ensure uniqueness
  const [u1, u2] = [userId1, userId2].sort();

  try {
    // Try to find existing
    const { data: existing } = await getSupabaseAdmin()
      .from('conversations')
      .select('*')
      .eq('user_id_1', u1)
      .eq('user_id_2', u2)
      .maybeSingle();

    if (existing) return NextResponse.json(mapConv(existing));

    // Create new
    const { data, error } = await getSupabaseAdmin()
      .from('conversations')
      .insert({ user_id_1: u1, user_id_2: u2 })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json(mapConv(data as Record<string, unknown>), { status: 201 });
  } catch (e) {
    if (isMissingTableError(e)) {
      return NextResponse.json({
        error: 'Chat tables missing. Run supabase/migration.sql.',
        needsMigration: true,
      }, { status: 500 });
    }
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
