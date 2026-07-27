import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, isMissingColumnError } from '@/lib/apiHelpers';
import { getAuthUser, getAdminRole, canAccessStore } from '@/lib/apiAuth';
import { getCashierActor } from '@/lib/cashierAuth';
import { isValidSlug } from '@/lib/slug';
import { pingRealtime } from '@/lib/realtimeServer';

/** Privileged fields only a platform admin may change (not the store owner). */
const ADMIN_ONLY_FIELDS = ['verified', 'approvalStatus', 'accountType'] as const;

function mapSupplier(s: Record<string, unknown>) {
  return {
    id: s.id,
    name: s.name,
    rating: s.rating,
    reviews: s.reviews,
    location: s.location,
    minOrder: s.min_order,
    categories: s.categories ?? [],
    icon: s.icon,
    description: s.description,
    productIds: s.product_ids ?? [],
    discount: s.discount,
    deliveryDays: s.delivery_days,
    verified: s.verified,
    badge: s.badge,
    bio: s.bio ?? '',
    contactNumbers: (s.contact_numbers as string[]) ?? [],
    authUserId: s.auth_user_id ?? null,
    slug:      (s.slug as string | null | undefined) ?? null,
    latitude:  (s.latitude  as number | null | undefined) ?? null,
    longitude: (s.longitude as number | null | undefined) ?? null,
    hideStock: Boolean(s.hide_stock ?? false),
    onlineOnly: Boolean(s.online_only ?? false),
    accountType: (s.account_type as string) ?? 'business',
    /* Trial/approval — absent columns (pre-migration schema) map to null */
    approvalStatus:      (s.approval_status as string | undefined) ?? null,
    trialStartedAt:      (s.trial_started_at as string | undefined) ?? null,
    approvalRequestedAt: (s.approval_requested_at as string | undefined) ?? null,
    /* Subscription billing — absent columns map to null. billingEnabled tells the
       client the columns EXIST, so "not paid" can't be confused with
       "migration_subscriptions.sql hasn't run" (which must never lock a seller). */
    billingEnabled:         'subscription_paid_at' in s,
    monthlyBillingEnabled:  'subscription_period_end' in s,
    subscriptionPaidAt:     (s.subscription_paid_at as string | undefined) ?? null,
    subscriptionRefundedAt: (s.subscription_refunded_at as string | undefined) ?? null,
    subscriptionPeriodEnd:  (s.subscription_period_end as string | undefined) ?? null,
    /* Admin-granted free trial (migration_v4_6) — unlocks the dashboard
       without payment, and never counts as a payment. */
    trialEndsAt:            (s.trial_ends_at as string | undefined) ?? null,
    /* Field-agent vetting: an agent earns nothing until an admin approves. */
    agentApprovedAt:        (s.agent_approved_at as string | undefined) ?? null,
    agentRejectedAt:        (s.agent_rejected_at as string | undefined) ?? null,
    subscriptionPlan:       (s.subscription_plan as string | undefined) ?? null,
    subscriptionAmount:     s.subscription_amount != null ? Number(s.subscription_amount) : null,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id, 10);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('suppliers').select('*').eq('id', id).single();
    if (error) throw error;
    return NextResponse.json(mapSupplier(data));
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id, 10);

  // ── Authorize: admin, the store OWNER, or a STAFF cashier with 'settings' ──
  const user = await getAuthUser(req);
  const adminRole = user ? await getAdminRole(req) : null;
  const isAdmin = adminRole === 'admin';
  if (!isAdmin) {
    if (!(await canAccessStore(req, id, 'settings'))) {
      const actor = user ? null : await getCashierActor(req);
      if (!user && !actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      return NextResponse.json({ error: 'Forbidden — not your store' }, { status: 403 });
    }
  }

  const body = await req.json();
  // Non-admins cannot grant themselves verification/approval/role.
  if (!isAdmin) {
    for (const f of ADMIN_ONLY_FIELDS) {
      if (body[f] !== undefined) {
        return NextResponse.json(
          { error: `Forbidden — '${f}' can only be changed by an admin` }, { status: 403 });
      }
    }
  }
  const updates: Record<string, unknown> = {};
  if (body.name          !== undefined) updates.name          = body.name;
  if (body.bio           !== undefined) updates.bio           = body.bio;
  if (body.contactNumbers!== undefined) updates.contact_numbers = body.contactNumbers.slice(0, 4);
  if (body.location      !== undefined) updates.location      = body.location;
  if (body.latitude      !== undefined) updates.latitude      = body.latitude  === null ? null : Number(body.latitude);
  if (body.longitude     !== undefined) updates.longitude     = body.longitude === null ? null : Number(body.longitude);
  if (body.minOrder      !== undefined) updates.min_order     = parseInt(body.minOrder, 10);
  if (body.categories    !== undefined) updates.categories    = body.categories;
  if (body.icon          !== undefined) updates.icon          = body.icon;
  if (body.description   !== undefined) updates.description   = body.description;
  if (body.discount      !== undefined) updates.discount      = parseInt(body.discount, 10);
  if (body.deliveryDays  !== undefined) updates.delivery_days = body.deliveryDays;
  if (body.verified      !== undefined) updates.verified      = body.verified;
  if (body.badge         !== undefined) updates.badge         = body.badge;
  if (body.slug !== undefined) {
    if (body.slug === null || body.slug === '') {
      updates.slug = null;
    } else {
      const slug = String(body.slug).trim().toLowerCase();
      // Reserved words would shadow real app routes (/pos, /admin…)
      if (!isValidSlug(slug)) {
        return NextResponse.json(
          { error: 'That store link is reserved or invalid — use 3–30 letters, numbers, or hyphens' },
          { status: 400 });
      }
      // One link = one store
      const { data: dupe } = await getSupabaseAdmin()
        .from('suppliers').select('id').eq('slug', slug).neq('id', id).maybeSingle();
      if (dupe) {
        return NextResponse.json(
          { error: 'That store link is already taken — try another' }, { status: 409 });
      }
      updates.slug = slug;
    }
  }
  if (body.hideStock     !== undefined) updates.hide_stock    = Boolean(body.hideStock);
  if (body.onlineOnly    !== undefined) updates.online_only   = Boolean(body.onlineOnly);
  if (body.accountType   !== undefined) updates.account_type  = body.accountType;
  // Admin approval decision (see also /request-approval for the user side)
  if (body.approvalStatus !== undefined
      && ['trial', 'pending', 'approved', 'rejected'].includes(body.approvalStatus)) {
    updates.approval_status = body.approvalStatus;
  }

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('suppliers').update(updates).eq('id', id).select().single();
    if (error) throw error;
    // Store details live on every product card AND in the owner's own session
    // (the ✓ verified badge, the name, online-only…). Without these pings an
    // admin verifying a store left the owner staring at "Request Verification"
    // until they manually reloaded the whole app.
    //   catalog  → everyone's product cards / store lists
    //   store:id → that owner's own AuthContext (see AuthProvider)
    pingRealtime(['catalog', `store:${id}`]);
    return NextResponse.json(mapSupplier(data));
  } catch (e) {
    // Pre-migration schema: optional columns (slug, latitude, longitude) may
    // not exist yet. Drop them and retry so the rest of the settings still save
    // instead of the whole update failing.
    const OPTIONAL = ['slug', 'latitude', 'longitude', 'online_only'];
    if (isMissingColumnError(e) && OPTIONAL.some(c => c in updates)) {
      const dropped = OPTIONAL.filter(c => c in updates);
      for (const c of dropped) delete updates[c];
      if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: 'Those fields require the v3.1 migration', skippedColumns: dropped }, { status: 400 });
      }
      const { data, error } = await getSupabaseAdmin()
        .from('suppliers').update(updates).eq('id', id).select().single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ...mapSupplier(data), skippedColumns: dropped });
    }
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (await getAdminRole(req) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 });
  }
  const id = parseInt((await params).id, 10);
  const { error } = await getSupabaseAdmin().from('suppliers').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
