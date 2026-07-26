import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/apiAuth';
import { isMissingTableError } from '@/lib/apiHelpers';
import { sendPushToUsers } from '@/lib/pushNotify';

/**
 * POST /api/push/test — send a push to the caller's own devices.
 *
 * Exists because "notifications don't work" is otherwise undiagnosable: this
 * proves the whole chain (VAPID keys → subscription row → browser push service
 * → service worker) in one click, and names the exact broken link when it
 * fails, rather than failing silently the way a real order push would.
 */
export async function POST(req: Request) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });

  // VAPID keys must be present or every send is a silent no-op.
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return NextResponse.json(
      { error: 'VAPID keys are not configured on the server', reason: 'no-vapid' },
      { status: 503 },
    );
  }

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('push_subscriptions')
      .select('endpoint')
      .eq('user_id', user.id);
    if (error) throw error;

    if (!data?.length) {
      return NextResponse.json(
        { error: 'This device isn’t subscribed yet — tap Enable first', reason: 'no-subscription' },
        { status: 409 },
      );
    }

    await sendPushToUsers([user.id], {
      title: '🔔 Hamar Mall',
      body:  'Test notification — push is working on this device.',
      url:   '/#/notifications',
      tag:   'hamar-test',
    });

    return NextResponse.json({ ok: true, devices: data.length });
  } catch (e) {
    if (isMissingTableError(e)) {
      return NextResponse.json(
        { error: 'push_subscriptions table missing — run supabase/migration_v3_5.sql', reason: 'needs-setup' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
