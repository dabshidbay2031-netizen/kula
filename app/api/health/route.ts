import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/health — uptime/readiness probe for monitoring (UptimeRobot, etc.)
 * and the connectivity check in <OfflineBanner>. Never throws; returns 200 when
 * the app is up, with `db: 'up' | 'down'` for the database.
 *
 * `dbMs` / `region` are here to settle "is the app slow or is the database
 * slow?" without guessing. Compare `dbMs` (this server → Postgres round trip)
 * against the total request time measured from the client: a small `dbMs` with
 * a large total means the cost is network distance, not the database.
 */
export async function GET() {
  let db: 'up' | 'down' = 'down';
  const started = Date.now();
  try {
    const { error } = await getSupabaseAdmin()
      .from('products').select('id', { head: true, count: 'exact' }).limit(1);
    db = error ? 'down' : 'up';
  } catch {
    db = 'down';
  }
  const dbMs = Date.now() - started;

  return NextResponse.json(
    {
      status: 'ok',
      db,
      dbMs,
      // Which Vercel region served this — every DB round trip starts here.
      region: process.env.VERCEL_REGION ?? null,
      time: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
