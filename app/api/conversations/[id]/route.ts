import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg } from '@/lib/apiHelpers';
import { requireChatMember } from '@/lib/chatAuth';
import { resolveChatUser } from '@/lib/chatHelpers';

/**
 * GET /api/conversations/[id]?viewerId=X
 * Returns conversation details with both participants' profiles resolved.
 *
 * Private: only the two participants may read it. `viewerId` is convenience
 * for display, NOT a security boundary — the caller must be authenticated and
 * a member. (Same rule the messages route's requireParticipant enforces.)
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const convId = (await params).id;

  // Auth + membership in one gate. Staff with the 'chat' privilege resolve to
  // the store owner's identity, so the shared inbox keeps working for them.
  const auth = await requireChatMember(req, convId);
  if (!auth.ok) return auth.res;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('conversations')
      .select('*')
      .eq('id', convId)
      .single();

    if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const viewerId = auth.identity.userId;
    const otherUserId = data.user_id_1 === viewerId ? data.user_id_2 : data.user_id_1;
    const [viewer, other] = await Promise.all([
      resolveChatUser(viewerId || data.user_id_1),
      resolveChatUser(otherUserId),
    ]);

    return NextResponse.json({
      id:        data.id,
      userId1:   data.user_id_1,
      userId2:   data.user_id_2,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      viewer,
      otherUser: other,
    });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
