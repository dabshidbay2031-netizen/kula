import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { sumRevenue } from '@/lib/revenue';
import { requireAdmin } from '@/lib/apiAuth';

function mapOrder(o: Record<string, unknown>) {
  return {
    id:            o.id,
    customerName:  o.customer_name,
    customerPhone: o.customer_phone,
    items:         o.items,
    subtotal:      o.subtotal,
    discount:      o.discount,
    total:         o.total,
    paymentMethod: o.payment_method,
    status:        o.status,
    createdAt:     o.created_at,
  };
}

const sb = () => getSupabaseAdmin();

/**
 * Platform KPIs must reflect the real business, so seed/test rows are excluded
 * wherever the `is_seed` flag exists. 455 of 491 orders carry no supplier_id
 * and are pure seeded volume — counting them made GMV meaningless.
 *
 * The flag arrives with RUN-THIS-grants-and-seed-flags.sql. Until that runs the
 * column is absent, and a filter on a missing column errors — which the old
 * `catch { return 0 }` would have turned into a silent zero on the admin
 * dashboard. So every helper retries unfiltered instead of reporting nothing.
 */
const SEED_TABLES = ['suppliers', 'orders'] as const;
let seedFlagAvailable: boolean | null = null;   // cached per server process

async function detectSeedFlag(): Promise<boolean> {
  if (seedFlagAvailable !== null) return seedFlagAvailable;
  const { error } = await sb().from('orders').select('is_seed').limit(1);
  seedFlagAvailable = !error;
  return seedFlagAvailable;
}

async function getCount(table: string, filter?: { col: string; val: string }): Promise<number> {
  const build = (excludeSeed: boolean) => {
    let q = sb().from(table).select('*', { count: 'exact', head: true });
    if (filter) q = q.eq(filter.col, filter.val);
    if (excludeSeed) q = q.eq('is_seed', false);
    return q;
  };
  const canFilter = (SEED_TABLES as readonly string[]).includes(table) && await detectSeedFlag();
  try {
    const { count, error } = await build(canFilter);
    if (!error) return count ?? 0;
    if (canFilter) {                        // column vanished mid-flight — retry raw
      const { count: raw } = await build(false);
      return raw ?? 0;
    }
    return 0;
  } catch { return 0; }
}

async function getRevenue(): Promise<number> {
  const excludeSeed = await detectSeedFlag();

  // Preferred: let Postgres add it up. Pulling every order row into Node just
  // to .reduce() them is fine at a few hundred orders and ruinous at 100k.
  try {
    const { data, error } = await sb().rpc('admin_revenue_total', { exclude_seed: excludeSeed });
    if (!error && data != null) return Number(data) || 0;
  } catch { /* RPC not deployed — fall through */ }

  // Fallback for a DB without the aggregate function.
  const read = async (skipSeed: boolean) => {
    // status included so deleted/cancelled/refunded money never counts
    let q = sb().from('orders').select('total, status');
    if (skipSeed) q = q.eq('is_seed', false);
    return q;
  };
  try {
    let { data, error } = await read(excludeSeed);
    if (error && excludeSeed) ({ data } = await read(false));
    return sumRevenue((data ?? []) as { total: number; status: string }[]);
  } catch { return 0; }
}

async function getRecentOrders(): Promise<ReturnType<typeof mapOrder>[]> {
  const read = async (excludeSeed: boolean) => {
    let q = sb().from('orders').select('*');
    if (excludeSeed) q = q.eq('is_seed', false);
    return q.order('created_at', { ascending: false }).limit(8);
  };
  try {
    const excludeSeed = await detectSeedFlag();
    let { data, error } = await read(excludeSeed);
    if (error && excludeSeed) ({ data } = await read(false));
    return ((data ?? []) as Record<string, unknown>[]).map(mapOrder);
  } catch { return []; }
}

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const [
    totalBusinesses,
    totalSuppliers,
    totalProducts,
    totalUsers,
    pendingVerifications,
    totalOrders,
    totalRevenue,
    recentOrders,
  ] = await Promise.all([
    getCount('suppliers', { col: 'account_type', val: 'business' }),
    getCount('suppliers', { col: 'account_type', val: 'supplier' }),
    getCount('products'),
    getCount('profiles'),
    getCount('verification_requests', { col: 'status', val: 'pending' }),
    getCount('orders'),
    getRevenue(),
    getRecentOrders(),
  ]);

  return NextResponse.json({
    totalBusinesses,
    totalSuppliers,
    totalProducts,
    totalOrders,
    totalRevenue,
    totalUsers,
    pendingVerifications,
    recentOrders,
    // Lets the dashboard say whether these numbers are seed-free, instead of
    // leaving an admin to guess why GMV dropped by $196k overnight.
    seedExcluded: await detectSeedFlag(),
  });
}
