import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireStaff, canAccessStore, requireSupplierAccess } from '@/lib/apiAuth';
import { errMsg, isMissingTableError, jsonWithEtag } from '@/lib/apiHelpers';
import { pingRealtime } from '@/lib/realtimeServer';

function mapProduct(p: Record<string, unknown>) {
  return {
    id:            p.id,
    name:          p.name,
    price:         p.price,
    originalPrice: p.original_price,
    cost:          p.cost,
    category:      p.category,
    subCategory:   p.sub_category ?? null,
    icon:          p.icon,
    stock:         p.stock,
    sku:           p.sku,
    supplierId:    p.supplier_id  ?? null,
    rating:        p.rating,
    reviews:       p.reviews,
    sold:          p.sold,
    description:   p.description,
    barcode:       p.barcode      ?? null,
    tags:          p.tags         ?? [],
    brand:         p.brand        ?? null,
    imageUrl:      p.image_url    ?? null,
    imageUrls:     p.image_urls   ?? [],
  };
}

/** Per-store overrides. NULL => inherit the catalog value (see lib/listings). */
function mapOverrides(row: Record<string, unknown>) {
  return {
    name:          row.name           ?? null,
    description:   row.description    ?? null,
    imageUrl:      row.image_url      ?? null,
    imageUrls:     row.image_urls     ?? null,
    brand:         row.brand          ?? null,
    category:      row.category       ?? null,
    subCategory:   row.sub_category   ?? null,
    tags:          row.tags           ?? null,
    sku:           row.sku            ?? null,
    originalPrice: row.original_price ?? null,
    cost:          row.cost           ?? null,
  };
}

function mapBP(row: Record<string, unknown>) {
  return {
    id:          row.id,
    supplierId:  row.supplier_id,
    productId:   row.product_id,
    customPrice: row.custom_price,
    stockQty:    row.stock_qty,
    moq:         (row.moq as number) ?? 1,
    isActive:    row.is_active,
    createdAt:   row.created_at,
    customizedAt: row.customized_at ?? null,
    overrides:   mapOverrides(row),
    product:     row.products
      ? mapProduct(row.products as Record<string, unknown>)
      : null,
  };
}

/** GET /api/business-products?supplierId=X
 *  Returns a store's claimed catalog — including cost, custom prices and stock.
 *  That's sensitive seller data, so this is gated exactly like the POST below:
 *  the owner, a platform admin, or a staff cashier of THIS store. Without this
 *  check a competitor could enumerate supplierId=1..N and read every rival's
 *  cost basis. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const supplierId = searchParams.get('supplierId');
  if (!supplierId) return NextResponse.json({ error: 'supplierId required' }, { status: 400 });

  // Ownership gate — same helper the POST handler uses. Returns null on
  // success, a 401/403 Response otherwise.
  const denied = await requireSupplierAccess(req, parseInt(supplierId, 10));
  if (denied) return denied;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('business_products')
      .select('*, products(*)')
      .eq('supplier_id', parseInt(supplierId, 10))
      .order('created_at', { ascending: false });

    if (error) throw error;
    // ETag: the dashboard polls this every 30s alongside orders. A 304 keeps
    // the payload off the wire and stops the client re-rendering unchanged data.
    return jsonWithEtag(req, data.map(r => mapBP(r as Record<string, unknown>)),
      { 'Cache-Control': 'private, no-cache' });
  } catch (e) {
    if (isMissingTableError(e)) {
      // Table doesn't exist yet — run migration.sql
      return NextResponse.json([]);
    }
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}

/** POST /api/business-products — claim a product into a business's store */
export async function POST(req: Request) {
  { const denied = await requireStaff(req, 'inventory_edit'); if (denied) return denied; }
  const body = await req.json();
  const { supplierId, productId, customPrice, stockQty = 0, moq = 1 } = body;

  if (!supplierId || !productId || customPrice === undefined) {
    return NextResponse.json(
      { error: 'supplierId, productId and customPrice are required' },
      { status: 400 }
    );
  }

  // A store may only claim products INTO ITS OWN inventory — otherwise any
  // business could stuff products into a rival's store by spoofing supplierId.
  // Owner/admin OR a staff cashier of that store with 'inventory_edit'.
  if (!(await canAccessStore(req, parseInt(String(supplierId), 10), 'inventory_edit'))) {
    return NextResponse.json({ error: 'Forbidden — not your store' }, { status: 403 });
  }

  try {
    const sb = getSupabaseAdmin();
    const payload = {
      supplier_id:  parseInt(String(supplierId), 10),
      product_id:   parseInt(String(productId),  10),
      custom_price: parseFloat(String(customPrice)),
      stock_qty:    parseInt(String(stockQty),    10),
      moq:          Math.max(1, parseInt(String(moq), 10)),
      is_active:    true,
    };

    let { data, error } = await sb
      .from('business_products')
      .upsert(payload, { onConflict: 'supplier_id,product_id' })
      .select('*, products(*)')
      .single();

    // Self-heal a desynced SERIAL sequence: rows were seeded with explicit ids,
    // so the `id` sequence can lag behind max(id) and a fresh claim's INSERT
    // collides on the primary key. Assign the next id explicitly and retry so
    // the claim still succeeds (the permanent fix is scripts/fix-bp-sequence.sql).
    if (error && /business_products_pkey/i.test(error.message ?? '')) {
      const { data: top } = await sb
        .from('business_products')
        .select('id').order('id', { ascending: false }).limit(1).maybeSingle();
      const nextId = ((top?.id as number) ?? 0) + 1;
      ({ data, error } = await sb
        .from('business_products')
        .insert({ id: nextId, ...payload })
        .select('*, products(*)')
        .single());
    }

    if (error) throw error;
    pingRealtime(['catalog']); // new claim appears in search/nearby instantly
    return NextResponse.json(mapBP(data as Record<string, unknown>), { status: 201 });
  } catch (e) {
    if (isMissingTableError(e)) {
      return NextResponse.json({
        error: 'business_products table missing. Run supabase/migration.sql in your Supabase SQL editor.',
        needsMigration: true,
      }, { status: 500 });
    }
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
