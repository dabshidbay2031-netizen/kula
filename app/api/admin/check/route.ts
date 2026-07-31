import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/apiAuth';

/**
 * GET /api/admin/check   (Authorization: Bearer <jwt>)
 * Returns { role: 'admin' | 'semi_admin' | null } for the CALLER.
 *
 * The identity comes from the JWT, never from the request.
 *
 * This used to read `?uid=`, which made it an oracle: anyone could ask "is this
 * user an admin, and which role?" about any uid and get a straight answer. That
 * granted no access on its own — every real admin route validates the token —
 * but it handed an attacker the list of accounts worth attacking. Answering
 * only about the authenticated caller removes the question entirely.
 *
 * Bootstrap fallback: if the admins table has 0 rows AND the authenticated uid
 * matches BOOTSTRAP_ADMIN_UID, auto-insert as admin (first-run only). This now
 * requires a real signed-in session as well as the env var.
 */
export async function GET(req: Request) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ role: null });

  const uid = user.id;
  const sb  = getSupabaseAdmin();

  try {
    const { data, error } = await sb
      .from('admins')
      .select('role')
      .eq('user_id', uid)
      .maybeSingle();

    if (error) throw error;
    if (data) return NextResponse.json({ role: data.role as string });

    // Bootstrap: if table is empty and the signed-in uid matches the env var,
    // auto-seed as admin.
    const bootstrap = process.env.BOOTSTRAP_ADMIN_UID ?? '';
    if (bootstrap && bootstrap === uid) {
      const { count } = await sb.from('admins').select('*', { count: 'exact', head: true });
      if ((count ?? 0) === 0) {
        await sb.from('admins').insert({ user_id: uid, role: 'admin', name: 'Owner' });
        return NextResponse.json({ role: 'admin' });
      }
    }

    return NextResponse.json({ role: null });
  } catch {
    return NextResponse.json({ role: null });
  }
}
