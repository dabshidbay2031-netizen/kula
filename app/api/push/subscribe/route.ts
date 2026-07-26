import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/apiAuth';
import { isMissingTableError } from '@/lib/apiHelpers';

/**
 * POST   /api/push/subscribe — save the caller's browser push subscription.
 *        Body: { endpoint, keys: { p256dh, auth } }  (PushSubscription.toJSON())
 * DELETE /api/push/subscribe — remove it. Body: { endpoint }
 *
 * Auth required — a subscription is always tied to the signed-in user so
 * order/chat pushes reach the right person. Upsert on endpoint: re-subscribing
 * (or another account signing in on the same browser) re-points the endpoint.
 */

export async function POST(req: Request) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized — sign in required' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  const keys     = (body.keys ?? {}) as Record<string, unknown>;
  const p256dh   = typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth     = typeof keys.auth   === 'string' ? keys.auth   : '';
  if (!endpoint.startsWith('https://') || !p256dh || !auth) {
    return NextResponse.json({ error: 'endpoint, keys.p256dh and keys.auth required' }, { status: 400 });
  }

  try {
    const { error } = await getSupabaseAdmin()
      .from('push_subscriptions')
      .upsert({ user_id: user.id, endpoint, p256dh, auth }, { onConflict: 'endpoint' });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    // The table not existing is a setup step, not a runtime fault — flag it so
    // the UI can say exactly what to do instead of "try again later".
    if (isMissingTableError(e)) {
      return NextResponse.json(
        { error: 'push_subscriptions table missing — run supabase/migration_v3_5.sql', needsMigration: true },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: 'Could not save the subscription', detail: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  if (!endpoint) return NextResponse.json({ error: 'endpoint required' }, { status: 400 });

  try {
    await getSupabaseAdmin()
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .eq('user_id', user.id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true }); // idempotent
  }
}
