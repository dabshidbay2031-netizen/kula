import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, jsonWithEtag } from '@/lib/apiHelpers';
import { rateLimit, clientIp } from '@/lib/rateLimit';
import { getAuthUser, isAdminUser, ownsStoreOrAdmin, requireSupplierAccess } from '@/lib/apiAuth';
import { pingRealtime, runAfterResponse } from '@/lib/realtimeServer';
import { sendPushToStores, sellerStoreIds } from '@/lib/pushNotify';
import { createNotifications } from '@/lib/notify';
import { computePlatformFee } from '@/lib/fees';
import { unitPriceFor } from '@/lib/tierPricing';
import type { PriceTier } from '@/lib/types';

function mapOrder(o: Record<string, unknown>) {
  return {
    id:            o.id,
    customerName:  o.customer_name,
    customerPhone: o.customer_phone,
    userId:        o.user_id        ?? null,
    items:         o.items,
    subtotal:      o.subtotal,
    discount:      o.discount,
    total:         o.total,
    /* Platform transaction fee (migration_v4_2) — buyer-charged portion, and
       the portion the store chose to absorb. Absent columns map to 0. */
    platformFee:     Number(o.platform_fee ?? 0),
    feePaidByStore:  Number(o.fee_paid_by_store ?? 0),
    paymentMethod: o.payment_method,
    status:        o.status,
    notes:         o.notes          ?? null,
    sessionId:     o.session_id     ?? null,
    cashierName:   o.cashier_name   ?? null,
    supplierId:    o.supplier_id    ?? null,
    createdAt:     o.created_at,
  };
}

/** Collision-resistant server-side order id: prefix + ms timestamp (base36) + 4 random chars */
function newOrderId(prefix: 'ORD' | 'BULK'): string {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

const VALID_STATUS = new Set(['pending', 'processing', 'shipped', 'completed', 'cancelled', 'refunded', 'bulk_pending']);

/**
 * Page window for order listings. Replaces the old hard `.limit(500)`, which
 * made a busy store's older orders permanently invisible with no way to ask
 * for them. `X-Has-More` on the response tells the client whether to offer
 * "load more".
 */
const MAX_PAGE = 500;
function pageParams(sp: URLSearchParams): { limit: number; offset: number } {
  const rawLimit = parseInt(sp.get('limit') ?? '', 10);
  const rawOff   = parseInt(sp.get('offset') ?? '', 10);
  // The DEFAULT must stay at the old cap. Dashboards call this with no limit
  // and aggregate everything they get back — defaulting to a smaller page
  // silently truncated their KPIs, charts and PDF totals to the newest 100
  // orders. Only a caller that explicitly pages (OrdersView) asks for less.
  const limit  = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_PAGE) : MAX_PAGE;
  const offset = Number.isFinite(rawOff) && rawOff > 0 ? rawOff : 0;
  return { limit, offset };
}

/**
 * Payment methods the platform actually supports. An unrecognised string used
 * to be stored verbatim AND treated as cash — so `paymentMethod: "freemoney"`
 * silently skipped the 3% platform fee (isOnlinePayment only matches the known
 * online wallets). Anything not on this list is now coerced to 'cash'.
 *
 * 'bulk' MUST stay here: `isBulk` is derived from it and drives the entire
 * wholesale order path.
 */
const VALID_PAYMENT_METHODS = new Set([
  'cash', 'bulk', 'invoice', 'card',
  'sifalo', 'waafi', 'evc', 'edahab', 'pbwallet',
]);

/**
 * Statuses a BUYER may request when creating an order. Anything beyond these
 * (completed, shipped…) is a seller/staff decision — otherwise a direct API
 * call could self-mark an order 'completed' and skip delivery and payment.
 */
const BUYER_SETTABLE_STATUS = new Set(['pending', 'bulk_pending']);

/**
 * Fire the live-update fan-out for a freshly created order — realtime pings
 * (buyer, selling stores, admin dashboard) and a Web Push to the store
 * owner(s). Runs after the response so checkout latency is untouched.
 */
function notifyNewOrder(orderId: string, userId: string | null, items: OrderItem[], total: number) {
  runAfterResponse(async () => {
    const sellers = await sellerStoreIds(items);

    // In-app notifications (Notifications page + bell badge): one for the buyer,
    // one for each selling store's owner. Look up owners from the store rows.
    let ownerIds: string[] = [];
    try {
      if (sellers.length) {
        const { data } = await getSupabaseAdmin()
          .from('suppliers')
          .select('auth_user_id')
          .in('id', sellers);
        ownerIds = (data ?? [])
          .map(s => s.auth_user_id as string | null)
          .filter((v): v is string => !!v && v !== userId);
      }
    } catch { /* owners are best-effort */ }

    await createNotifications([
      ...(userId ? [{
        userId, type: 'order', icon: '🛍️',
        title:   'Order placed',
        message: `Your order ${orderId} for $${total.toFixed(2)} was placed.`,
      }] : []),
      ...ownerIds.map(owner => ({
        userId: owner, type: 'order', icon: '🛍️',
        title:   'New order received',
        message: `Order ${orderId} — $${total.toFixed(2)}`,
      })),
    ]);

    pingRealtime([
      'orders',
      'notifications',
      userId ? `user:${userId}` : null,
      ...sellers.map(s => `store:${s}`),
    ]);
    await sendPushToStores(sellers, {
      title: '🛍️ New order received',
      body:  `Order ${orderId} — $${total.toFixed(2)}`,
      url:   `/#/orders/${orderId}`,
      tag:   `order-${orderId}`,
    });
  });
}

interface OrderItem { id: number; qty: number; }

/** Parse and bound-check the items payload. Returns null if invalid. */
function parseItems(raw: unknown): OrderItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) return null;
  const items: OrderItem[] = [];
  for (const it of raw) {
    const id  = Number((it as Record<string, unknown>)?.id);
    const qty = Number((it as Record<string, unknown>)?.qty ?? 1);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (!Number.isInteger(qty) || qty <= 0 || qty > 10000) return null;
    items.push({ id, qty });
  }
  return items;
}

export async function GET(req: Request) {
  // Orders carry customer PII (names, phones, totals). Reads require auth and
  // an ownership check — otherwise anyone could enumerate supplierId/userId and
  // scrape every store's order history (IDOR).
  const { searchParams } = new URL(req.url);
  const userId        = searchParams.get('userId');
  const supplierParam = searchParams.get('supplierId');

  // ── Supplier orders filter ─────────────────────────────────
  // Checked FIRST and with its own guard: a STAFF cashier has no Supabase JWT,
  // so requiring a signed-in user up front would lock staff out of their own
  // store's orders ("Sign in to view orders").
  if (supplierParam !== null) {
    const supplierId = parseInt(supplierParam, 10);
    if (Number.isNaN(supplierId)) {
      return NextResponse.json({ error: 'supplierId must be a number' }, { status: 400 });
    }
    // Owner, admin, or a STAFF cashier of this store holding 'orders'.
    // 401 when there's no credential at all, 403 when it's the wrong store.
    { const denied = await requireSupplierAccess(req, supplierId, 'orders'); if (denied) return denied; }
    try {
      // A store sees ONLY the orders attributed to it (orders.supplier_id,
      // stamped by checkout / POS / invoicing). We deliberately do NOT fall
      // back to matching an order's items against the store's product ids:
      // catalog product ids are shared across stores (and were re-used when the
      // catalog was reseeded), so item-matching leaked every other store's
      // orders into this store's list.
      // Paginated: the old hard .limit(500) silently hid a long-running
      // store's older orders with no way to reach them.
      const { limit, offset } = pageParams(searchParams);
      const { data: orderData, error } = await getSupabaseAdmin()
        .from('orders').select('*')
        .eq('supplier_id', supplierId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      const rows = (orderData ?? []).map(o => mapOrder(o as Record<string, unknown>));
      // ETag: these screens poll every 30s. Without a conditional response the
      // whole order list crosses the wire again each time even when nothing
      // changed — expensive on a mobile connection, and it forced the client
      // to replace its state and re-render for no reason.
      return jsonWithEtag(req, rows, {
        'X-Has-More':    rows.length === limit ? '1' : '0',
        'Cache-Control': 'private, no-cache',
      });
    } catch (e) {
      // NEVER return [] here. An empty array with HTTP 200 makes a server
      // failure look like "no sales in this period" — the seller sees a
      // cheerful zero and never learns their data failed to load.
      console.error('[orders GET supplier]', errMsg(e));
      return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
    }
  }

  // Personal order history — this branch is Supabase-user only (a cashier has
  // no personal orders; theirs is the store branch above).
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized — sign in required' }, { status: 401 });

  // A signed-in customer may read only their OWN orders; only an admin may
  // read across users (the no-userId "all orders" dump).
  if (!userId || userId !== user.id) {
    if (!(await isAdminUser(user.id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  try {
    const { limit, offset } = pageParams(searchParams);
    let query = getSupabaseAdmin()
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []).map(mapOrder);
    return jsonWithEtag(req, rows, {
      'X-Has-More':    rows.length === limit ? '1' : '0',
      'Cache-Control': 'private, no-cache',
    });
  } catch (e) {
    // Same rule as above: a failure must not masquerade as "no orders".
    console.error('[orders GET]', errMsg(e));
    return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
  }
}

/**
 * POST /api/orders — server-authoritative order placement.
 *
 * The client sends WHAT it wants (items, coupon code, contact info).
 * The server decides PRICES (from the DB), DISCOUNT (validates + consumes
 * the coupon), TOTAL, the ORDER ID (collision-proof), and STOCK
 * (atomic decrement). Client-supplied subtotal/discount/total/id are ignored.
 *
 * Body: { customerName, customerPhone, userId?, items: [{id, qty}],
 *         paymentMethod?, status?, notes?, couponCode? }
 *
 * Bulk orders (paymentMethod 'bulk') are supplier inquiries: priced from
 * the DB like everything else, but stock is NOT decremented and no coupon
 * applies — nothing has been sold yet.
 */
export async function POST(req: Request) {
  // Public endpoint (guest checkout) — throttle to curb spam/abuse.
  const rl = rateLimit(`orders:${clientIp(req)}`, 20, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many requests. Please slow down.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const items = parseItems(body.items);
  if (!items) {
    return NextResponse.json({ error: 'items must be a non-empty array of { id, qty } with positive integer values' }, { status: 400 });
  }

  const rawMethod     = typeof body.paymentMethod === 'string' ? body.paymentMethod.toLowerCase() : 'cash';
  const paymentMethod = VALID_PAYMENT_METHODS.has(rawMethod) ? rawMethod : 'cash';
  const isBulk        = paymentMethod === 'bulk';

  // Status: buyers may only open an order as pending. A seller-only status
  // (completed/shipped/…) requires proof the caller runs the store it is
  // attributed to — checked below, once we know supplierId.
  let requestedStatus = isBulk ? 'bulk_pending' : 'pending';
  const askedStatus   = typeof body.status === 'string' ? body.status : null;
  const customerName  = String(body.customerName  ?? '').slice(0, 200);
  const customerPhone = String(body.customerPhone ?? '').slice(0, 50);
  const userId        = body.userId != null ? String(body.userId) : null;
  const notes         = body.notes != null ? String(body.notes).slice(0, 2000) : null;
  const couponCode    = typeof body.couponCode === 'string' && body.couponCode.trim() ? body.couponCode.trim() : null;
  const sessionId     = body.sessionId   != null ? String(body.sessionId)   : null;
  const cashierName   = body.cashierName != null ? String(body.cashierName) : null;
  // Which STORE sold this order (checkout shop / POS register / invoice).
  // Drives per-store dashboards; without it legacy item-matching applies.
  const supplierId    = Number.isInteger(Number(body.supplierId)) && Number(body.supplierId) > 0
    ? Number(body.supplierId) : null;

  const sb = getSupabaseAdmin();

  // ── Requested status — STAFF ONLY beyond 'pending' ────────────
  if (askedStatus) {
    if (!VALID_STATUS.has(askedStatus)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    if (BUYER_SETTABLE_STATUS.has(askedStatus)) {
      requestedStatus = askedStatus;
    } else {
      // 'completed'/'shipped'/… — only the store that owns the sale (or an
      // admin) may open an order already in that state.
      const staff = await getAuthUser(req);
      const allowed = staff != null && supplierId != null
        && await ownsStoreOrAdmin(staff.id, supplierId);
      if (!allowed) {
        return NextResponse.json(
          { error: 'Forbidden — only the store can set that status' }, { status: 403 });
      }
      requestedStatus = askedStatus;
    }
  }

  // ── Idempotency — a double-tapped "Place Order" must not double-charge ──
  // The client sends one key per checkout attempt; a repeat of the same key
  // returns the ORIGINAL order instead of creating a second one.
  const idempotencyKey = req.headers.get('Idempotency-Key')?.slice(0, 100) || null;
  if (idempotencyKey) {
    const { data: dupe, error: dupeErr } = await sb
      .from('orders').select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
    // A missing column (pre-migration) errors — ignore and create normally.
    if (!dupeErr && dupe) {
      return NextResponse.json({ ...mapOrder(dupe as Record<string, unknown>), duplicate: true }, { status: 200 });
    }
  }

  // ── Manual (POS) discount — STAFF ONLY ────────────────────────
  // A public/guest order can never discount itself (that would let a buyer
  // zero out their total). We honour body.discount only when the caller holds
  // a valid JWT and owns the store the sale is attributed to (or is an admin).
  // The amount is re-clamped against the DB subtotal below.
  let staffDiscount = 0;
  const requestedDiscount = Math.round((Number(body.discount) || 0) * 100) / 100;
  if (!isBulk && requestedDiscount > 0 && supplierId != null) {
    const staff = await getAuthUser(req);
    if (staff && (await ownsStoreOrAdmin(staff.id, supplierId))) {
      staffDiscount = requestedDiscount;
    }
  }

  // ── Pricing inputs: bulk tiers + who pays the platform fee ────
  // Read from the DB, never the client. Both columns are optional on older
  // schemas, so the select degrades rather than failing the sale.
  let fee = { buyerFee: 0, storeFee: 0, totalFee: 0 };
  let hasTieredItem = false;
  if (!isBulk) {
    const { data: withFeeCol } = await sb
      .from('products').select('id, price, price_tiers, fee_absorbed_by_store').in('id', items.map(i => i.id));
    let feeRows = withFeeCol as Record<string, unknown>[] | null;
    if (!feeRows) {
      const { data } = await sb
        .from('products').select('id, price, price_tiers').in('id', items.map(i => i.id));
      feeRows = data as Record<string, unknown>[] | null;
    }
    if (feeRows?.length) {
      const byId = new Map(feeRows.map(p => [p.id as number, p as Record<string, unknown>]));
      // The fee is 3% of what's ACTUALLY charged, so it must see the tier price.
      const lines = items.map(i => {
        const p     = byId.get(i.id);
        const tiers = p?.price_tiers as PriceTier[] | null | undefined;
        if (Array.isArray(tiers) && tiers.length) hasTieredItem = true;
        return {
          price: unitPriceFor(Number(p?.price) || 0, tiers, i.qty),
          qty:   i.qty,
          feeAbsorbedByStore: Boolean(p?.fee_absorbed_by_store),
        };
      });
      fee = computePlatformFee(lines, paymentMethod);
    }
  }

  // ── Atomic path: place_order() RPC (schema v2) for real sales ──
  // Locks product rows, verifies + decrements stock, consumes the coupon,
  // and inserts the order in ONE transaction. Skipped when a manual staff
  // discount applies — the RPC can't take one, so we use the JS path below.
  // Also skipped when any item has bulk tiers: the RPC prices from the list
  // price and knows nothing about tiers, so it would silently charge the
  // wholesale buyer full price. The JS path below applies them properly.
  if (!isBulk && staffDiscount === 0 && !hasTieredItem) {
    try {
      const { data, error } = await sb.rpc('place_order', {
        p_customer_name:  customerName,
        p_customer_phone: customerPhone,
        p_user_id:        userId,
        p_items:          items,
        p_payment_method: paymentMethod,
        p_coupon_code:    couponCode,
        p_notes:          notes,
      });
      if (!error && data) {
        const created = data as Record<string, unknown>;
        // The RPC predates attribution/POS columns — stamp them after the
        // fact. STORE ATTRIBUTION (supplier_id + cashier_name) matters most:
        // without it the sale is invisible on the store's dashboard. session_id
        // is the fragile field (FK to pos_sessions) — a sale rung up on a
        // register opened OFFLINE points at a session not in the DB, so the
        // update fails on it; we then retry keeping supplier_id + cashier_name
        // and drop only session_id.
        if (supplierId != null || sessionId != null || cashierName != null) {
          const full: Record<string, unknown> = {};
          if (supplierId  != null) full.supplier_id  = supplierId;
          if (cashierName != null) full.cashier_name = cashierName;
          if (sessionId   != null) full.session_id   = sessionId;
          const stampAttempts = [
            full,
            { supplier_id: full.supplier_id, cashier_name: full.cashier_name }, // drop session_id
            { supplier_id: full.supplier_id },                                  // drop cashier_name
          ]
            .map(o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)))
            .filter(o => Object.keys(o).length);
          for (const upd of stampAttempts) {
            try {
              const { error: exErr } = await sb.from('orders').update(upd).eq('id', String(created.id));
              if (!exErr) { Object.assign(created, upd); break; }
            } catch { /* try the next, leaner stamp */ }
          }
        }
        // The RPC knows nothing about the platform fee, so add it here: record
        // both portions and top up the buyer's total. Best-effort — on a DB
        // without migration_v4_2 the update fails and the order simply carries
        // no fee, rather than the sale being lost.
        if (fee.totalFee > 0) {
          const newTotal = Math.round(((Number(created.total) || 0) + fee.buyerFee) * 100) / 100;
          try {
            const { error: feeErr } = await sb.from('orders')
              .update({ platform_fee: fee.buyerFee, fee_paid_by_store: fee.storeFee, total: newTotal })
              .eq('id', String(created.id));
            if (!feeErr) {
              created.platform_fee      = fee.buyerFee;
              created.fee_paid_by_store = fee.storeFee;
              created.total             = newTotal;
            }
          } catch { /* pre-migration DB — order still stands */ }
        }
        notifyNewOrder(String(created.id), userId, items, Number(created.total ?? 0));
        return NextResponse.json(mapOrder(created), { status: 201 });
      }
      if (error) {
        const code = String(error.code ?? '');
        const msg  = errMsg(error);
        // Function not installed yet (old schema) → fall through to JS path
        const fnMissing = code === 'PGRST202' || code === '42883' || msg.includes('place_order');
        if (!fnMissing) {
          // Real business failure from the transaction (e.g. insufficient stock)
          const status = msg.toLowerCase().includes('stock') ? 409 : 500;
          return NextResponse.json({ error: msg }, { status });
        }
      }
    } catch { /* fall through to JS path */ }
  }

  // ── Fallback path (works on the legacy schema) ────────────────
  // Server-side pricing is still enforced; stock decrement is
  // best-effort (not transactional) until schema v2 is applied.
  try {
    // 1. Price every item from the DB — never from the client
    const ids = items.map(i => i.id);
    const withTiers = await sb
      .from('products').select('id, price, stock, sold, price_tiers, supplier_id').in('id', ids);
    let prods: Record<string, unknown>[] | null = withTiers.data as Record<string, unknown>[] | null;
    let prodErr = withTiers.error;
    // price_tiers predates this feature on some schemas — retry without it.
    if (prodErr) {
      const legacy = await sb.from('products').select('id, price, stock, sold, supplier_id').in('id', ids);
      prods   = legacy.data as Record<string, unknown>[] | null;
      prodErr = legacy.error;
    }
    if (prodErr) throw prodErr;

    const byId = new Map((prods ?? []).map(p => [p.id as number, p as Record<string, unknown>]));
    let subtotal = 0;
    for (const item of items) {
      const p = byId.get(item.id);
      if (!p) {
        return NextResponse.json({ error: `Product ${item.id} not found` }, { status: 400 });
      }
      if (!isBulk && (p.stock as number) < item.qty) {
        return NextResponse.json({ error: `Insufficient stock for product ${item.id}` }, { status: 409 });
      }
      // Wholesale bulk pricing: the unit price depends on how many are bought.
      // Applied server-side so the tier discount is real, not just displayed.
      subtotal += unitPriceFor(p.price as number, p.price_tiers as PriceTier[] | null, item.qty) * item.qty;
    }
    subtotal = Math.round(subtotal * 100) / 100;

    // 2. Validate + consume coupon server-side (sales only)
    let discount = 0;
    if (!isBulk && couponCode) {
      const { data: c } = await sb
        .from('coupons').select('*')
        .eq('code', couponCode.toUpperCase()).eq('active', true)
        .maybeSingle();
      if (c
          && (!c.expires_at || new Date(c.expires_at as string) > new Date())
          && (c.max_uses == null || (c.used_count as number) < (c.max_uses as number))
          && subtotal >= parseFloat(String(c.min_order ?? 0))) {
        const value = parseFloat(String(c.value));
        discount = c.type === 'percent'
          ? Math.round(subtotal * value) / 100
          : Math.min(value, subtotal);
        discount = Math.round(discount * 100) / 100;
        await sb.from('coupons')
          .update({ used_count: (c.used_count as number) + 1 })
          .eq('id', c.id as number);
      }
    }

    // Add any staff (POS) discount on top of a coupon, clamped to the subtotal.
    if (staffDiscount > 0) {
      discount = Math.round(Math.min(discount + staffDiscount, subtotal) * 100) / 100;
    }

    // The buyer-charged portion of the platform fee rides on top of the total;
    // the absorbed portion is recorded but NOT charged to the buyer.
    const total = Math.max(Math.round((subtotal - discount + fee.buyerFee) * 100) / 100, 0);

    // Snapshot the server-priced unit price onto each line item, so a later
    // price change can never retroactively re-value this sale (the payout
    // wallet reads this frozen price for legacy/unattributed orders).
    const pricedItems = items.map(i => {
      const p = byId.get(i.id);
      return {
        id: i.id, qty: i.qty,
        // Freeze the TIER-adjusted unit price, not the list price, so the
        // receipt and the payout wallet both value the sale as it was sold.
        price: unitPriceFor(Number(p?.price) || 0, p?.price_tiers as PriceTier[] | null, i.qty),
      };
    });

    // 3a. ATOMIC PATH — one transaction for the whole sale.
    //
    // place_order_v2 takes the prices we just computed (so tiers and the staff
    // discount are honoured, which the original place_order could not do) and
    // does lock → verify → decrement → insert order → insert lines together.
    // Nothing here can half-happen. Falls through to the step-by-step path
    // below only when the function isn't deployed.
    {
      const orderPayload: Record<string, unknown> = {
        id:              newOrderId(isBulk ? 'BULK' : 'ORD'),
        customer_name:   customerName,
        customer_phone:  customerPhone,
        user_id:         userId,
        items:           pricedItems,
        subtotal, discount, total,
        payment_method:  paymentMethod,
        status:          requestedStatus,
        notes,
        supplier_id:     supplierId,
        session_id:      sessionId,
        cashier_name:    cashierName,
        idempotency_key: idempotencyKey,
        skip_stock:      isBulk,          // wholesale enquiries don't move stock
      };
      const rpcItems = pricedItems.map(pi => ({
        id:          pi.id,
        qty:         pi.qty,
        unit_price:  pi.price,
        supplier_id: (byId.get(pi.id)?.supplier_id as number | undefined) ?? supplierId ?? null,
      }));

      const { data: v2, error: v2Err } = await sb.rpc('place_order_v2', {
        p_order: orderPayload, p_items: rpcItems,
      });

      if (!v2Err && v2) {
        const created = v2 as Record<string, unknown>;
        notifyNewOrder(String(created.id), userId, items, total);
        return NextResponse.json(mapOrder(created), { status: 201 });
      }
      // A genuine stock refusal must surface as 409, not fall through and
      // decrement a second time on the legacy path.
      if (v2Err && /INSUFFICIENT_STOCK/.test(String(v2Err.message ?? ''))) {
        const pid = String(v2Err.message).split('INSUFFICIENT_STOCK:')[1]?.trim();
        return NextResponse.json(
          { error: `Insufficient stock for product ${pid ?? ''}`.trim() }, { status: 409 });
      }
      if (v2Err && /PRODUCT_MISSING/.test(String(v2Err.message ?? ''))) {
        const pid = String(v2Err.message).split('PRODUCT_MISSING:')[1]?.trim();
        return NextResponse.json({ error: `Product ${pid ?? ''} not found`.trim() }, { status: 400 });
      }
      // Anything else (function absent on this DB) → legacy path below.
    }

    // 3b. Take the stock FIRST, atomically, before any order row exists.
    //
    //    The old order was: insert order → then decrement using the stale
    //    snapshot with no guard. Two buyers could both read stock=1, both pass
    //    the check, and both write stock=0 — one apple sold twice. Worse, a
    //    crash between the two steps left a paid order that never moved stock.
    //
    //    decrement_stock() does `stock = stock - qty WHERE id = ? AND stock >= ?`
    //    inside the DB, so the read-modify-write can't interleave. If any line
    //    fails we put back everything already taken and refuse the order.
    const taken: { id: number; qty: number }[] = [];
    if (!isBulk) {
      for (const item of items) {
        let ok = false;
        const { data: rpcOk, error: rpcErr } = await sb
          .rpc('decrement_stock', { p_id: item.id, p_qty: item.qty });
        if (!rpcErr) {
          ok = rpcOk === true;
        } else {
          // Pre-migration DB: conditional update is still far better than none.
          const p = byId.get(item.id)!;
          const { data: upd } = await sb.from('products')
            .update({
              stock: Math.max((p.stock as number) - item.qty, 0),
              sold:  ((p.sold as number) ?? 0) + item.qty,
            })
            .eq('id', item.id)
            .gte('stock', item.qty)
            .select('id');
          ok = Array.isArray(upd) && upd.length > 0;
        }

        if (!ok) {
          for (const t of taken) {
            try { await sb.rpc('restore_stock', { p_id: t.id, p_qty: t.qty }); } catch { /* best effort */ }
          }
          return NextResponse.json(
            { error: `Insufficient stock for product ${item.id}` }, { status: 409 });
        }
        taken.push({ id: item.id, qty: item.qty });
      }
    }

    // 4. Insert the order. If this fails, hand the stock back.
    const basePayload: Record<string, unknown> = {
      id:             newOrderId(isBulk ? 'BULK' : 'ORD'),
      customer_name:  customerName,
      customer_phone: customerPhone,
      items:          pricedItems,
      subtotal,
      discount,
      total,
      payment_method: paymentMethod,
      status:         requestedStatus,
    };
    if (userId != null) basePayload.user_id = userId;

    // Insert, degrading gracefully. Ordered so STORE ATTRIBUTION
    // (supplier_id + cashier_name) is the LAST thing dropped — losing it would
    // hide the sale from the store's dashboard. The most fragile field is
    // session_id (FK to pos_sessions): a sale rung up on a register that was
    // opened OFFLINE references a session not yet in the DB, so on sync the FK
    // fails — we then keep everything except session_id.
    // The idempotency key rides on the order row so a retry of the same
    // checkout is recognised even across server instances. Dropped first if
    // the column isn't deployed — a duplicate order beats a failed sale.
    const withKey   = idempotencyKey ? { ...basePayload, idempotency_key: idempotencyKey } : basePayload;
    const withNotes = { ...withKey, notes };
    // Fee columns ship in migration_v4_2 — dropped first if absent, since a
    // recorded fee matters less than the sale itself.
    const withFee = fee.totalFee > 0
      ? { ...withNotes, platform_fee: fee.buyerFee, fee_paid_by_store: fee.storeFee }
      : withNotes;
    const attempts: Record<string, unknown>[] = [
      { ...withFee,   supplier_id: supplierId, cashier_name: cashierName, session_id: sessionId },
      { ...withFee,   supplier_id: supplierId, cashier_name: cashierName },  // drop session_id (offline/FK)
      { ...withNotes, supplier_id: supplierId, cashier_name: cashierName },  // drop fee cols (pre-v4.2)
      { ...withNotes, supplier_id: supplierId },                            // drop cashier_name
      withNotes,                                                            // drop supplier_id (pre-v3.7)
      { ...basePayload, notes },                                            // drop idempotency_key
      basePayload,                                                          // drop notes (oldest schema)
    ];

    let order: Record<string, unknown> | null = null;
    let lastErr: unknown = null;
    for (let i = 0; i < attempts.length; i++) {
      const { data, error } = await sb.from('orders').insert(attempts[i]).select().single();
      if (!error) { order = data as Record<string, unknown>; break; }
      lastErr = error;
    }
    if (!order) {
      // Never strand the stock we just took for an order that doesn't exist.
      for (const t of taken) {
        try { await sb.rpc('restore_stock', { p_id: t.id, p_qty: t.qty }); } catch { /* best effort */ }
      }
      throw lastErr ?? new Error('Order insert failed');
    }

    // 5. Write the normalized sales lines. place_order() has always done this,
    //    but this fallback never did — so bulk / tiered / staff-discount sales
    //    produced no order_items at all, and every per-seller revenue report
    //    built on that table silently undercounted them.
    if (pricedItems.length) {
      const lines = pricedItems.map(pi => ({
        order_id:    order!.id,
        product_id:  pi.id,
        supplier_id: (byId.get(pi.id)?.supplier_id as number | undefined) ?? supplierId ?? null,
        qty:         pi.qty,
        unit_price:  pi.price,
        line_total:  Math.round(pi.price * pi.qty * 100) / 100,
      }));
      // Reporting data — never fail a paid order because the ledger insert did.
      const { error: liErr } = await sb.from('order_items').insert(lines);
      if (liErr) console.error('[orders POST] order_items insert failed:', errMsg(liErr));
    }

    notifyNewOrder(String(order!.id), userId, items, total);
    return NextResponse.json(mapOrder(order!), { status: 201 });
  } catch (e) {
    console.error('[orders POST]', errMsg(e));
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
