import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, isMissingTableError } from '@/lib/apiHelpers';
import { pingRealtime, runAfterResponse } from '@/lib/realtimeServer';
import { sendPushToUsers } from '@/lib/pushNotify';
import { rateLimit, clientIp } from '@/lib/rateLimit';
import { requireChatMember, isBlockedEitherDirection } from '@/lib/chatAuth';

/**
 * Authorize the caller as a participant of the conversation.
 * Returns the chat identity's user id on success, or a Response to send back.
 *
 * Delegates to lib/chatAuth so STAFF with the 'chat' privilege are recognised.
 * They hold no Supabase JWT, so the previous getAuthUser-only check 401'd every
 * cashier — they could see the inbox list but never open a thread.
 */
async function requireParticipant(req: Request, convId: string): Promise<string | Response> {
  const r = await requireChatMember(req, convId);
  return r.ok ? r.identity.userId : r.res;
}

function mapMsg(m: Record<string, unknown>) {
  return {
    id:             m.id,
    conversationId: m.conversation_id,
    senderId:       m.sender_id,
    content:        m.content       ?? null,
    imageUrl:       m.image_url     ?? null,
    messageType:    m.message_type  ?? 'text',
    readAt:         m.read_at       ?? null,
    createdAt:      m.created_at,
  };
}

/**
 * GET /api/conversations/[id]/messages?before=ISO&limit=50
 * Returns messages in this conversation, newest-first (paginated).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const convId = (await params).id;
  const auth = await requireParticipant(req, convId);
  if (auth instanceof Response) return auth;

  const { searchParams } = new URL(req.url);
  const before = searchParams.get('before');
  const limit  = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 100);

  try {
    let query = getSupabaseAdmin()
      .from('messages')
      .select('*')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) query = query.lt('created_at', before);

    const { data, error } = await query;
    if (error) throw error;

    // Return chronological order (oldest first)
    return NextResponse.json((data ?? []).reverse().map(mapMsg));
  } catch (e) {
    if (isMissingTableError(e)) return NextResponse.json([]);
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

/**
 * POST /api/conversations/[id]/messages
 * Send a message.
 * Body: { senderId, content?, imageUrl?, messageType }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const convId = (await params).id;
  const auth = await requireParticipant(req, convId);
  if (auth instanceof Response) return auth;
  const senderId = auth; // authoritative: the sender IS the authenticated caller

  // Rate limit: a logged-in user can send at most 30 messages / 10s from one
  // IP. Stops spam/flood harassment (see lib/rateLimit.ts). Idempotent reads
  // (GET) are not limited.
  const rl = rateLimit(`chat-msg:${clientIp(req)}`, 30, 10_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'You are sending messages too fast. Please slow down.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const body = await req.json();
  const { content, imageUrl, messageType = 'text' } = body;

  if (!content && !imageUrl) {
    return NextResponse.json({ error: 'content or imageUrl required' }, { status: 400 });
  }

  // Block enforcement: if either party blocked the other, refuse the send.
  // Resolve the other participant from the conversation row requireParticipant
  // already validated against.
  const { data: convRow } = await getSupabaseAdmin()
    .from('conversations')
    .select('user_id_1, user_id_2')
    .eq('id', convId)
    .maybeSingle();
  const otherId = convRow
    ? (String(convRow.user_id_1) === senderId ? String(convRow.user_id_2) : String(convRow.user_id_1))
    : null;
  if (otherId && (await isBlockedEitherDirection(senderId, otherId))) {
    return NextResponse.json(
      { error: "You can't message this user." },
      { status: 403 },
    );
  }

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('messages')
      .insert({
        conversation_id: convId,
        sender_id:       senderId,
        content:         content    ?? null,
        image_url:       imageUrl   ?? null,
        message_type:    messageType,
      })
      .select()
      .single();

    if (error) throw error;

    // Bump conversation updated_at so it sorts to top of list
    await getSupabaseAdmin()
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', convId);

    // Live fan-out to the OTHER participant: realtime ping (chat list bumps
    // instantly) + Web Push if their browser is subscribed. The open room
    // itself already streams the row via postgres_changes.
    runAfterResponse(async () => {
      if (!otherId) return;
      pingRealtime([`user:${otherId}`]);
      await sendPushToUsers([otherId], {
        title: '💬 New message',
        body:  messageType === 'image' ? '📷 Photo' : String(content ?? '').slice(0, 120),
        url:   `/#/chat/${convId}`,
        tag:   `chat-${convId}`,
      });
    });

    return NextResponse.json(mapMsg(data as Record<string, unknown>), { status: 201 });
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

/**
 * PATCH /api/conversations/[id]/messages
 * Mark all messages from the other user as read.
 * Body: { readerId }
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const convId = (await params).id;
  const auth = await requireParticipant(req, convId);
  if (auth instanceof Response) return auth;
  const readerId = auth; // the reader IS the authenticated caller

  try {
    await getSupabaseAdmin()
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('conversation_id', convId)
      .neq('sender_id', readerId)
      .is('read_at', null);

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
