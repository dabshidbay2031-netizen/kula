import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, isMissingTableError, isMissingColumnError } from '@/lib/apiHelpers';
import { getAuthUser, ownsStoreOrAdmin } from '@/lib/apiAuth';
import { NON_REVENUE_STATUSES } from '@/lib/revenue';

/**
 * Online-payment wallet for a store.
 *
 *  • onlineTotal — this store's share of every SUCCESSFUL online-paid order
 *    (payment_method in ONLINE_METHODS, revenue-counting status). Because our
 *    checkout only places an order after the wallet charge succeeds, a
 *    Sifalo/Waafi order == a confirmed online payment.
 *  • paidOut      — sum of the store's recorded payouts (the `payouts` ledger).
 *  • balance      — onlineTotal − paidOut. Paying out deducts the exact amount.
 *  • payoutNumber — the company phone saved on the supplier; always the number a
 *    payout goes to.
 *
 * The `payouts` table and `suppliers.payout_number` column ship in schema_v3.sql;
 * run supabase/migration_payouts.sql on an existing DB. Until then this degrades:
 * onlineTotal/balance still show, but saving a number or paying out returns
 * needsMigration.
 */
const ONLINE_METHODS = new Set(['sifalo', 'waafi', 'evc', 'edahab']);
/** Cash taken in person (POS) or on delivery. Tracked alongside online money. */
const CASH_METHODS   = new Set(['cash', 'cod', 'cash_on_delivery']);

type SB = ReturnType<typeof getSupabaseAdmin>;

export interface Payout {
  id: number; supplierId: number; amount: number; phone: string;
  status: 'pending' | 'approved' | 'rejected';
  note: string | null; createdAt: string; decidedAt: string | null;
}
interface Wallet {
  /** Confirmed ONLINE payments since the wallet epoch (withdrawable). */
  onlineTotal: number;
  /** Cash taken since the wallet epoch (POS + cash-on-delivery). */
  cashTotal: number;
  /** onlineTotal + cashTotal — everything the store has collected. */
  earnedTotal: number;
  /** Approved + paid out. */
  paidOut: number;
  /** Requested but not yet decided — reserved, so it can't be double-spent. */
  pending: number;
  /** What can be requested right now: earned − paidOut − pending. */
  balance: number;
  payoutNumber: string | null; payouts: Payout[]; needsMigration: boolean;
  /** When this wallet started counting (null pre-migration). */
  walletStartedAt: string | null;
}

function mapPayout(r: Record<string, unknown>): Payout {
  return {
    id:         r.id as number,
    supplierId: r.supplier_id as number,
    amount:     Number(r.amount) || 0,
    phone:      (r.phone as string) ?? '',
    // Pre-migration rows have no status column: they were instant payouts.
    status:     ((r.status as string) ?? 'approved') as Payout['status'],
    note:       (r.note as string | null) ?? null,
    createdAt:  r.created_at as string,
    decidedAt:  (r.decided_at as string | null) ?? null,
  };
}

/**
 * This store's share of confirmed online payments — valued at the price
 * recorded AT SALE TIME, never the current price.
 *
 * For an attributed order (orders.supplier_id — v3.7+, and checkout is
 * per-shop) the whole order was this store's sale, so we use the stored
 * `subtotal` snapshot. That closes a real exploit: previously the balance was
 * recomputed as Σ(CURRENT price × qty), so a seller could raise their price and
 * retroactively inflate their withdrawable balance beyond what was collected.
 *
 * Legacy orders with no attribution fall back to item-matching; there we prefer
 * a price snapshotted on the line item and only use the current price if none
 * was stored (pre-fix rows).
 */
async function computeTotals(
  sb: SB, supplierId: number, since: string | null,
): Promise<{ online: number; cash: number }> {
  const [{ data: owned }, { data: claims }] = await Promise.all([
    sb.from('products').select('id, price').eq('supplier_id', supplierId),
    sb.from('business_products').select('product_id, custom_price').eq('supplier_id', supplierId),
  ]);
  const priceById = new Map<number, number>();
  for (const p of owned ?? [])  priceById.set(p.id as number,         Number(p.price) || 0);
  for (const c of claims ?? []) priceById.set(c.product_id as number, Number(c.custom_price) || 0); // claim overrides

  // The wallet epoch is what makes the balance start at zero: orders taken
  // before the store's wallet was switched on are simply not counted.
  // NO .limit() here. Earnings were capped at the most recent 1000 orders
  // while payouts were summed in full, so past that point the balance silently
  // dropped older income but kept subtracting older withdrawals — a number
  // that drifts wrong and always in the seller's disfavour. Page through
  // everything instead; `since` (the wallet epoch) already bounds the range.
  const PAGE = 1000;
  async function readAllOrders(withFeeCol: boolean): Promise<Record<string, unknown>[] | null> {
    const cols = withFeeCol
      ? 'items, payment_method, status, supplier_id, subtotal, created_at, fee_paid_by_store'
      : 'items, payment_method, status, supplier_id, subtotal, created_at';
    const out: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += PAGE) {
      let page = sb.from('orders').select(cols)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (since) page = page.gte('created_at', since);
      const { data, error } = await page;
      if (error) return null;                       // caller retries without the fee column
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      out.push(...rows);
      if (rows.length < PAGE) return out;           // last page
    }
  }

  // fee_paid_by_store ships in migration_v4_2 — on an older DB the select above
  // errors, so retry without it rather than reporting a zero balance.
  let orders: Record<string, unknown>[] | null = await readAllOrders(true);
  if (!orders) {
    orders = await readAllOrders(false);
  }
  if (!orders) {
    const { data } = await sb.from('orders')
      .select('items, payment_method, status, supplier_id, subtotal, created_at')
      .order('created_at', { ascending: false }).limit(PAGE);
    orders = data as Record<string, unknown>[] | null;
  }

  let online = 0;
  let cash   = 0;
  for (const o of orders ?? []) {
    const method   = String(o.payment_method);
    const isOnline = ONLINE_METHODS.has(method);
    const isCash   = CASH_METHODS.has(method);
    if (!isOnline && !isCash) continue;
    if (NON_REVENUE_STATUSES.has(String(o.status))) continue;

    let amount = 0;
    const attributed = (o as { supplier_id?: number | null }).supplier_id;
    if (attributed != null) {
      // Snapshot path: trust the amount recorded at sale time.
      if (Number(attributed) !== supplierId) continue; // belongs to another store
      amount = Number(o.subtotal) || 0;
    } else {
      // Legacy fallback (no attribution): match this store's items. Prefer the
      // price frozen on the line item; only reach for the current price if the
      // order predates the snapshot.
      if (priceById.size === 0) continue;
      const items = Array.isArray(o.items) ? o.items : [];
      for (const it of items) {
        const line = it as { id: number; qty: number; price?: number };
        const snap = line.price;
        const price = snap != null && Number.isFinite(Number(snap)) ? Number(snap) : priceById.get(line.id);
        if (price != null) amount += price * (Number(line.qty) || 0);
      }
    }

    // A fee the store agreed to absorb is the platform's money, not theirs —
    // deduct it so the withdrawable balance can't include it.
    amount -= Number((o as { fee_paid_by_store?: number }).fee_paid_by_store) || 0;

    if (isOnline) online += amount;
    else          cash   += amount;
  }
  return {
    online: Math.round(online * 100) / 100,
    cash:   Math.round(cash   * 100) / 100,
  };
}

async function loadWallet(sb: SB, supplierId: number): Promise<Wallet> {
  let needsMigration = false;

  // Saved payout number + wallet epoch (both may be missing pre-migration).
  let payoutNumber: string | null = null;
  let walletStartedAt: string | null = null;
  const { data: supRow, error: supErr } = await sb
    .from('suppliers').select('payout_number, wallet_started_at').eq('id', supplierId).maybeSingle();
  if (!supErr) {
    payoutNumber    = (supRow?.payout_number as string | null) ?? null;
    walletStartedAt = (supRow?.wallet_started_at as string | null) ?? null;
  } else if (isMissingColumnError(supErr)) {
    needsMigration = true;
    // Fall back to just the payout number on a pre-v4_1 schema.
    const { data: legacy } = await sb
      .from('suppliers').select('payout_number').eq('id', supplierId).maybeSingle();
    payoutNumber = (legacy?.payout_number as string | null) ?? null;
  } else throw supErr;

  const { online: onlineTotal, cash: cashTotal } = await computeTotals(sb, supplierId, walletStartedAt);
  const earnedTotal = Math.round((onlineTotal + cashTotal) * 100) / 100;

  // Payout ledger (payouts table — may not exist pre-migration)
  let payouts: Payout[] = [];
  let paidOut = 0;
  let pending = 0;
  const { data: prows, error: pErr } = await sb
    .from('payouts').select('*').eq('supplier_id', supplierId)
    .order('created_at', { ascending: false });
  if (!pErr) {
    payouts = (prows ?? []).map(r => mapPayout(r as Record<string, unknown>));
    // A rejected request costs nothing; a pending one is reserved so the same
    // money can't be requested twice while an admin is still deciding.
    paidOut = payouts.filter(p => p.status === 'approved').reduce((s, p) => s + p.amount, 0);
    pending = payouts.filter(p => p.status === 'pending').reduce((s, p) => s + p.amount, 0);
    paidOut = Math.round(paidOut * 100) / 100;
    pending = Math.round(pending * 100) / 100;
  } else if (isMissingTableError(pErr)) needsMigration = true;
  else throw pErr;

  const balance = Math.max(0, Math.round((earnedTotal - paidOut - pending) * 100) / 100);
  return {
    onlineTotal, cashTotal, earnedTotal,
    paidOut, pending, balance,
    payoutNumber, payouts, needsMigration, walletStartedAt,
  };
}

/** Auth: signed-in owner of `supplierId` (or admin). Returns the id or a Response. */
async function guard(req: Request, supplierId: number): Promise<Response | null> {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await ownsStoreOrAdmin(user.id, supplierId))) {
    return NextResponse.json({ error: 'Forbidden — not your store' }, { status: 403 });
  }
  return null;
}

/** GET /api/payouts?supplierId=X — the store's online-payment wallet. */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('supplierId');
  const supplierId = parseInt(raw ?? '', 10);
  if (Number.isNaN(supplierId)) return NextResponse.json({ error: 'supplierId required' }, { status: 400 });

  const denied = await guard(req, supplierId);
  if (denied) return denied;

  try {
    return NextResponse.json(await loadWallet(getSupabaseAdmin(), supplierId));
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

/** PATCH /api/payouts — save/replace the store's payout phone number. */
export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const supplierId = parseInt(String(body.supplierId ?? ''), 10);
  const phone = String(body.phone ?? '').trim();
  if (Number.isNaN(supplierId)) return NextResponse.json({ error: 'supplierId required' }, { status: 400 });
  if (!phone) return NextResponse.json({ error: 'phone required' }, { status: 400 });

  const denied = await guard(req, supplierId);
  if (denied) return denied;

  const { error } = await getSupabaseAdmin()
    .from('suppliers').update({ payout_number: phone.slice(0, 40) }).eq('id', supplierId);
  if (error) {
    if (isMissingColumnError(error)) {
      return NextResponse.json({ error: 'payout_number column missing — run migration_payouts.sql', needsMigration: true }, { status: 500 });
    }
    return NextResponse.json({ error: errMsg(error) }, { status: 500 });
  }
  return NextResponse.json({ success: true, payoutNumber: phone });
}

/**
 * POST /api/payouts — REQUEST a payout.
 *
 * Creates a `pending` request; the amount is reserved against the balance so it
 * can't be requested twice. An admin approves or rejects it via
 * PATCH /api/admin/payouts. Money only leaves on approval.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const supplierId = parseInt(String(body.supplierId ?? ''), 10);
  const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
  if (Number.isNaN(supplierId)) return NextResponse.json({ error: 'supplierId required' }, { status: 400 });
  if (!(amount > 0)) return NextResponse.json({ error: 'amount must be greater than 0' }, { status: 400 });

  const denied = await guard(req, supplierId);
  if (denied) return denied;

  const sb = getSupabaseAdmin();
  let wallet: Wallet;
  try {
    wallet = await loadWallet(sb, supplierId);
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }

  if (!wallet.payoutNumber) {
    return NextResponse.json({ error: 'Save your payout number first' }, { status: 400 });
  }
  // `balance` already excludes anything pending, so this also blocks requesting
  // the same money twice while an earlier request is still awaiting a decision.
  if (amount > wallet.balance + 0.001) {
    return NextResponse.json({
      error: wallet.pending > 0
        ? `Amount exceeds your available balance ($${wallet.balance.toFixed(2)}) — you have $${wallet.pending.toFixed(2)} awaiting approval`
        : `Amount exceeds your balance ($${wallet.balance.toFixed(2)})`,
    }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { error } = await sb.from('payouts').insert({
    supplier_id: supplierId, amount, phone: wallet.payoutNumber,
    status: 'pending', requested_at: now,
  });
  if (error) {
    if (isMissingTableError(error)) {
      return NextResponse.json({ error: 'payouts table missing — run migration_payouts.sql', needsMigration: true }, { status: 500 });
    }
    if (isMissingColumnError(error)) {
      return NextResponse.json({ error: 'Payout approvals not enabled yet — run migration_v4_1.sql', needsMigration: true }, { status: 501 });
    }
    return NextResponse.json({ error: errMsg(error) }, { status: 500 });
  }

  // Return the refreshed wallet so the client updates the balance immediately.
  try {
    return NextResponse.json({ success: true, requested: amount, ...(await loadWallet(sb, supplierId)) }, { status: 201 });
  } catch {
    return NextResponse.json({ success: true, requested: amount }, { status: 201 });
  }
}
