import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireAdmin, getAuthUser } from '@/lib/apiAuth';
import { pingRealtime } from '@/lib/realtimeServer';
import { sanitizeTiers, EMPTY_TIERS, type FeedTiers } from '@/lib/feedTiers';

/**
 * Explore feed priority tiers — which stores/categories/products get drawn
 * first, and the hard per-store cap on the grid.
 *
 *   GET  /api/settings/feed-tiers   — public; the Explore grid reads this.
 *   PUT  /api/settings/feed-tiers   — full admins only; replaces the config.
 *
 * Stored as a single JSONB row in `site_settings` (key = 'feed_tiers'), the
 * same table the hero banner uses. See supabase/migration_v4_8.sql.
 *
 * GET never fails the caller: a missing table (migration not yet run) or an
 * unreachable DB returns empty tiers, and empty tiers make the feed behave
 * exactly as it did before this feature existed. A misconfigured settings row
 * must never be able to take the storefront down.
 */

const KEY = 'feed_tiers';

export async function GET() {
  try {
    const { data } = await getSupabaseAdmin()
      .from('site_settings').select('value').eq('key', KEY).maybeSingle();
    return NextResponse.json(data?.value ? sanitizeTiers(data.value) : EMPTY_TIERS);
  } catch {
    // Table missing or DB unreachable — fall back to "no rules set".
    return NextResponse.json(EMPTY_TIERS);
  }
}

export async function PUT(req: Request) {
  const denied = await requireAdmin(req, { role: 'admin' });
  if (denied) return denied;

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  // Reject a body that carries tier values we don't recognise instead of
  // silently dropping them: a typo'd tier ("hiden") would otherwise save as a
  // no-op and leave the admin believing a store was hidden when it wasn't.
  const invalid = collectInvalidTiers(body);
  if (invalid.length) {
    return NextResponse.json(
      { error: `Invalid tier value(s): ${invalid.slice(0, 5).join(', ')}. Allowed: normal, reduced, low, hidden.` },
      { status: 400 },
    );
  }

  const tiers: FeedTiers = { ...sanitizeTiers(body), updatedAt: new Date().toISOString() };
  const user = await getAuthUser(req);

  try {
    const { error } = await getSupabaseAdmin()
      .from('site_settings')
      .upsert({ key: KEY, value: tiers, updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
              { onConflict: 'key' });
    if (error) throw error;
    // Open Explore pages re-sort the grid the moment this lands.
    pingRealtime(['settings', 'catalog']);
    return NextResponse.json(tiers);
  } catch (e) {
    return NextResponse.json(
      { error: 'Save failed — has migration_v3_4.sql been run?', detail: String(e) },
      { status: 500 },
    );
  }
}

/** Every tier value in the payload that isn't one of the four allowed strings,
 *  reported as "map.key" so the admin can see exactly which row is wrong. */
function collectInvalidTiers(body: unknown): string[] {
  const o = (body ?? {}) as Record<string, unknown>;
  const bad: string[] = [];
  for (const map of ['stores', 'categories', 'subs', 'products'] as const) {
    const m = o[map];
    if (!m || typeof m !== 'object') continue;
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (v === 'normal' || v === 'reduced' || v === 'low' || v === 'hidden') continue;
      bad.push(`${map}.${k}=${JSON.stringify(v)}`);
    }
  }
  return bad;
}
