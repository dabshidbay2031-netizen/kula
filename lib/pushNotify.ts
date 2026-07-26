import webpush from 'web-push';
import { getSupabaseAdmin } from '@/lib/supabase';

/**
 * Server-side Web Push sender. API routes call these AFTER a successful
 * mutation, fire-and-forget — a push failure must never fail the request.
 *
 * Requires VAPID keys in env (NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
 * VAPID_SUBJECT) and the push_subscriptions table (migration_v3_5.sql).
 * Missing either → every call is a silent no-op.
 */

export interface PushPayload {
  title: string;
  body:  string;
  /** Hash route to open on click, e.g. '/#/orders/ORD-123' */
  url?:  string;
  /** Same tag replaces the previous notification instead of stacking. */
  tag?:  string;
}

let vapidReady: boolean | null = null;
function ensureVapid(): boolean {
  if (vapidReady !== null) return vapidReady;
  const pub  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT ?? 'mailto:admin@hamarmall.com';
  if (!pub || !priv) { vapidReady = false; return false; }
  try {
    webpush.setVapidDetails(subj, pub, priv);
    vapidReady = true;
  } catch {
    vapidReady = false;
  }
  return vapidReady;
}

/** Send a push to every subscribed browser of the given users. */
export async function sendPushToUsers(userIds: Array<string | null | undefined>, payload: PushPayload): Promise<void> {
  if (!ensureVapid()) return;
  const ids = Array.from(new Set(userIds.filter((u): u is string => !!u)));
  if (!ids.length) return;

  const sb = getSupabaseAdmin();
  try {
    const { data: subs } = await sb
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .in('user_id', ids);
    if (!subs?.length) return;

    const body = JSON.stringify(payload);
    await Promise.all(subs.map(async s => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint as string, keys: { p256dh: s.p256dh as string, auth: s.auth as string } },
          body,
        );
      } catch (err) {
        // 404/410 = browser unsubscribed / endpoint dead → prune the row
        const code = (err as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) {
          await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint as string).then(() => {}, () => {});
        }
      }
    }));
  } catch { /* push is best-effort */ }
}

/** Send a push to the owners of the given stores (suppliers.auth_user_id). */
export async function sendPushToStores(supplierIds: number[], payload: PushPayload): Promise<void> {
  if (!supplierIds.length || !ensureVapid()) return;
  try {
    const { data } = await getSupabaseAdmin()
      .from('suppliers')
      .select('auth_user_id')
      .in('id', Array.from(new Set(supplierIds)));
    const owners = (data ?? []).map(s => s.auth_user_id as string | null).filter(Boolean) as string[];
    await sendPushToUsers(owners, payload);
  } catch { /* best-effort */ }
}

/**
 * The stores that SELL the given order items — owners (products.supplier_id)
 * plus claimants (business_products). Mirrors the filter GET /api/orders uses,
 * so a store is pinged exactly when the order would appear in its Orders tab.
 */
export async function sellerStoreIds(items: Array<{ id: number }>): Promise<number[]> {
  const ids = items.map(i => Number(i.id)).filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  try {
    const sb = getSupabaseAdmin();
    const [{ data: owned }, { data: claimed }] = await Promise.all([
      sb.from('products').select('supplier_id').in('id', ids),
      sb.from('business_products').select('supplier_id').in('product_id', ids),
    ]);
    const out = new Set<number>();
    for (const r of owned   ?? []) if (r.supplier_id != null) out.add(r.supplier_id as number);
    for (const r of claimed ?? []) if (r.supplier_id != null) out.add(r.supplier_id as number);
    return Array.from(out);
  } catch {
    return [];
  }
}
