import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getAuthUser } from '@/lib/apiAuth';
import { getCashierActor } from '@/lib/cashierAuth';
import { pingRealtime, runAfterResponse } from '@/lib/realtimeServer';
import { sendPushToUsers, sellerStoreIds } from '@/lib/pushNotify';

const STATUS_LABEL: Record<string, string> = {
  pending:    '🕐 Pending',
  processing: '📦 Being prepared',
  shipped:    '🚚 Shipped',
  completed:  '✅ Completed',
  cancelled:  '❌ Cancelled',
  refunded:   '💸 Refunded',
};

/** Live fan-out after an order changed: pings + push to the buyer. */
function notifyOrderChanged(order: Record<string, unknown>, newStatus?: string) {
  runAfterResponse(async () => {
    const items   = (Array.isArray(order.items) ? order.items : []) as Array<{ id: number }>;
    const userId  = order.user_id != null ? String(order.user_id) : null;
    const sellers = await sellerStoreIds(items);
    pingRealtime([
      'orders',
      userId ? `user:${userId}` : null,
      ...sellers.map(s => `store:${s}`),
    ]);
    if (userId && newStatus && newStatus !== 'deleted') {
      await sendPushToUsers([userId], {
        title: STATUS_LABEL[newStatus] ?? `Order ${newStatus}`,
        body:  `Your order ${order.id} is now ${newStatus}.`,
        url:   `/#/orders/${order.id}`,
        tag:   `order-${order.id}`,
      });
    }
  });
}

/**
 * Order management (status change, soft-delete) is a SELLER/admin action.
 * Allowed for platform admins, or a store that actually sells at least one
 * product in the order — NOT for a business that merely placed the order as a
 * buyer. (GET stays public so shared receipt QR codes keep resolving.)
 */
async function requireOrderSeller(req: Request, orderId: string): Promise<Response | null> {
  const sb = getSupabaseAdmin();
  const user = await getAuthUser(req);

  let supplierId: number | null = null;

  if (user) {
    const { data: admin } = await sb.from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (admin) return null;
    const { data: sup } = await sb.from('suppliers').select('id').eq('auth_user_id', user.id).maybeSingle();
    supplierId = (sup?.id as number | undefined) ?? null;
  } else {
    // STAFF cashier: no Supabase JWT. They manage their own store's orders
    // when the owner granted them the 'orders' privilege.
    const actor = await getCashierActor(req);
    if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!actor.privileges.includes('orders')) {
      return NextResponse.json({ error: 'Forbidden — your account cannot manage orders' }, { status: 403 });
    }
    supplierId = actor.supplierId;
  }

  if (supplierId == null) {
    return NextResponse.json({ error: 'Forbidden — store access required' }, { status: 403 });
  }

  const { data: ord } = await sb.from('orders').select('items, supplier_id').eq('id', orderId).maybeSingle();
  if (!ord) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  // Attributed order — the fastest, most accurate ownership signal.
  if (ord.supplier_id != null) {
    return Number(ord.supplier_id) === supplierId
      ? null
      : NextResponse.json({ error: 'Forbidden — you are not the seller of this order' }, { status: 403 });
  }
  const itemIds = (Array.isArray(ord.items) ? ord.items as Array<{ id: number }> : [])
    .map(i => Number(i.id)).filter(n => Number.isInteger(n) && n > 0);
  if (itemIds.length === 0) return NextResponse.json({ error: 'Forbidden — not your order' }, { status: 403 });

  // Seller iff the order contains a product this store OWNS or CLAIMS.
  const [{ data: owned }, { data: claimed }] = await Promise.all([
    sb.from('products').select('id').eq('supplier_id', supplierId).in('id', itemIds),
    sb.from('business_products').select('product_id').eq('supplier_id', supplierId).in('product_id', itemIds),
  ]);
  if ((owned && owned.length) || (claimed && claimed.length)) return null;
  return NextResponse.json({ error: 'Forbidden — you are not the seller of this order' }, { status: 403 });
}

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
    paymentMethod: o.payment_method,
    status:        o.status,
    notes:         o.notes          ?? null,
    sessionId:     o.session_id     ?? null,
    cashierName:   o.cashier_name   ?? null,
    supplierId:    o.supplier_id    ?? null,
    createdAt:     o.created_at,
  };
}

/** "Ahmed Hassan" → "A." — enough to recognize yourself, nothing to harvest. */
function maskName(name: unknown): string {
  const s = String(name ?? '').trim();
  return s ? `${s[0].toUpperCase()}.` : '';
}
/** "+252611234567" → "•••••67" */
function maskPhone(phone: unknown): string {
  const s = String(phone ?? '').trim();
  return s.length > 2 ? `•••••${s.slice(-2)}` : '';
}

/**
 * True when the caller may see the order's customer PII: the buyer who
 * placed it, a store that sells something in it, or a platform admin.
 * A receipt QR is public — anyone scanning it gets the order status and
 * totals, but NOT the customer's name and phone number.
 */
async function canSeeCustomerPII(req: Request, order: Record<string, unknown>): Promise<boolean> {
  const user = await getAuthUser(req);
  if (!user) {
    // STAFF cashier of the selling store (with the 'orders' privilege) is a
    // seller for this purpose — they fulfil the order, so they need the
    // customer's name/phone just like the owner does.
    const actor = await getCashierActor(req);
    if (actor && actor.supplierId != null && actor.privileges.includes('orders')) {
      return order.supplier_id != null && Number(order.supplier_id) === actor.supplierId;
    }
    return false;
  }
  if (order.user_id != null && String(order.user_id) === user.id) return true;
  const sb = getSupabaseAdmin();
  const { data: admin } = await sb.from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
  if (admin) return true;
  const { data: sup } = await sb.from('suppliers').select('id').eq('auth_user_id', user.id).maybeSingle();
  if (!sup) return false;
  const supplierId = sup.id as number;
  if (order.supplier_id != null && Number(order.supplier_id) === supplierId) return true;
  const itemIds = (Array.isArray(order.items) ? order.items as Array<{ id: number }> : [])
    .map(i => Number(i.id)).filter(n => Number.isInteger(n) && n > 0);
  if (itemIds.length === 0) return false;
  const [{ data: owned }, { data: claimed }] = await Promise.all([
    sb.from('products').select('id').eq('supplier_id', supplierId).in('id', itemIds),
    sb.from('business_products').select('product_id').eq('supplier_id', supplierId).in('product_id', itemIds),
  ]);
  return !!((owned && owned.length) || (claimed && claimed.length));
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { data, error } = await getSupabaseAdmin()
    .from('orders').select('*').eq('id', (await params).id).single();
  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const order = mapOrder(data);
  if (await canSeeCustomerPII(req, data as Record<string, unknown>)) {
    return NextResponse.json(order);
  }
  // Public view (scanned receipt QR): status + totals stay, PII is masked.
  // notes can carry the customer's name/address, so they're dropped too.
  return NextResponse.json({
    ...order,
    customerName:  maskName(order.customerName),
    customerPhone: maskPhone(order.customerPhone),
    userId:        null,
    notes:         null,
    masked:        true,
  });
}

/* Fulfillment pipeline rank — an order may only move FORWARD through it.
   Terminal exits (cancelled/refunded/deleted) are allowed from any live
   stage, but a completed order can't go back to processing, a shipped one
   can't become pending again, and a terminal order can't be revived. */
/** The only statuses an order may hold — mirrors the DB CHECK constraint. */
const VALID_STATUS = new Set([
  'pending', 'processing', 'shipped', 'completed',
  'cancelled', 'refunded', 'bulk_pending', 'deleted',
]);

const STAGE_RANK: Record<string, number> = {
  bulk_pending: 0, pending: 0, processing: 1, shipped: 2, completed: 3,
};
const TERMINAL = new Set(['cancelled', 'refunded', 'deleted']);

function forwardOnlyViolation(current: string, next: string): string | null {
  if (current === next) return null;
  if (TERMINAL.has(current)) return `Order is already ${current} and can't change`;
  if (TERMINAL.has(next)) return null;              // live → cancel/refund is fine
  const from = STAGE_RANK[current];
  const to   = STAGE_RANK[next];
  if (from === undefined || to === undefined) return null; // unknown label — don't block
  if (to < from) return `Order can't move back from ${current} to ${next}`;
  return null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const orderId = (await params).id;
  const denied = await requireOrderSeller(req, orderId);
  if (denied) return denied;

  const body = await req.json();
  const updates: Record<string, unknown> = {};
  if (body.status !== undefined) {
    // Validate against the whitelist BEFORE the forward-only rule. That rule
    // deliberately passes unknown labels through ("don't block"), so without
    // this a status of "h4ck3d" reached the DB and came back as an ugly 500
    // from the CHECK constraint instead of a clean 400.
    if (!VALID_STATUS.has(String(body.status))) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    const { data: cur } = await getSupabaseAdmin()
      .from('orders').select('status').eq('id', orderId).maybeSingle();
    const violation = cur ? forwardOnlyViolation(String(cur.status ?? 'pending'), String(body.status)) : null;
    if (violation) return NextResponse.json({ error: violation }, { status: 409 });
    updates.status = body.status;
  }
  if (body.customerName  !== undefined) updates.customer_name  = body.customerName;
  if (body.customerPhone !== undefined) updates.customer_phone = body.customerPhone;
  // Only include notes if it exists (old schema may not have it)
  if (body.notes !== undefined) updates.notes = body.notes;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const { data, error } = await getSupabaseAdmin()
    .from('orders').update(updates).eq('id', orderId).select().maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  notifyOrderChanged(data as Record<string, unknown>, typeof body.status === 'string' ? body.status : undefined);
  return NextResponse.json(mapOrder(data as Record<string, unknown>));
}

/**
 * RULE: orders are NEVER physically deleted. "Delete" marks the order
 * status as 'deleted' — it stays in the history (labeled), keeps its
 * receipt/QR resolvable, and is excluded from all revenue figures
 * (see lib/revenue.ts). There is intentionally no hard-delete path.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const orderId = (await params).id;
  const denied = await requireOrderSeller(req, orderId);
  if (denied) return denied;

  const { data, error } = await getSupabaseAdmin()
    .from('orders')
    .update({ status: 'deleted' })
    .eq('id', orderId)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  notifyOrderChanged(data as Record<string, unknown>); // ping only — no push for soft-deletes
  return NextResponse.json({ success: true, softDeleted: true, order: mapOrder(data as Record<string, unknown>) });
}
