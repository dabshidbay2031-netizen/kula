import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireProductOwner } from '@/lib/apiAuth';
import { isMissingColumnError } from '@/lib/apiHelpers';
import { pingRealtime } from '@/lib/realtimeServer';
function mapProduct(p: Record<string, unknown>) {
  const id      = typeof p.id === 'number' ? p.id : parseInt(String(p.id), 10);
  const tags    = Array.isArray(p.tags) ? p.tags as string[] : [];
  const brand   = (p.brand   && String(p.brand).trim())  ? String(p.brand)  : null;
  const barcode = (p.barcode && String(p.barcode).trim()) ? String(p.barcode): null;
  const subCat  = (p.sub_category && String(p.sub_category).trim()) ? String(p.sub_category) : null;

  return {
    id,
    name:          p.name,
    price:         p.price,
    originalPrice: p.original_price,
    cost:          Number(p.cost ?? 0),
    category:      p.category,
    subCategory:   subCat,
    stock:         p.stock,
    sku:           p.sku,
    supplierId:    p.supplier_id  ?? null,
    rating:        p.rating,
    reviews:       p.reviews,
    sold:          p.sold,
    description:   p.description,
    barcode,
    tags,
    brand,
    imageUrl:      p.image_url    ?? null,
    imageUrls:     p.image_urls   ?? [],
    priceTiers:    Array.isArray(p.price_tiers) ? p.price_tiers : [],
    isB2b:         Boolean(p.is_b2b ?? false),
    moq:           (p.moq as number) ?? 1,
    taxMode:       (p.tax_mode as 'none' | 'included' | 'excluded') ?? 'none',
    copiedFromProductId: (p.copied_from_product_id as number | undefined) ?? null,
    feeAbsorbedByStore:  Boolean(p.fee_absorbed_by_store ?? false),
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id, 10);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('products').select('*').eq('id', id).single();
    if (error) throw error;
    return NextResponse.json(mapProduct(data));
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id, 10);
  { const denied = await requireProductOwner(req, id); if (denied) return denied; }
  const body = await req.json();

  const updates: Record<string, unknown> = {};
  if (body.name          !== undefined) updates.name          = body.name;
  if (body.price         !== undefined) updates.price         = parseFloat(body.price);
  if (body.originalPrice !== undefined) updates.original_price= parseFloat(body.originalPrice);
  if (body.cost          !== undefined) updates.cost          = parseFloat(body.cost) || 0;
  if (body.category      !== undefined) updates.category      = body.category;
  if (body.stock         !== undefined) updates.stock         = parseInt(body.stock, 10);
  if (body.sku           !== undefined) updates.sku           = body.sku;
  if (body.supplierId    !== undefined) updates.supplier_id   = body.supplierId
    ? parseInt(String(body.supplierId), 10) : null;
  if (body.description   !== undefined) updates.description   = body.description;
  if (body.imageUrl      !== undefined) updates.image_url     = body.imageUrl;
  if (body.imageUrls     !== undefined) updates.image_urls    = Array.isArray(body.imageUrls) ? body.imageUrls : [];
  if (body.subCategory   !== undefined) updates.sub_category  = body.subCategory ?? null;
  if (body.barcode       !== undefined) updates.barcode       = body.barcode ?? null;
  if (body.tags          !== undefined) updates.tags          = Array.isArray(body.tags) ? body.tags : [];
  if (body.brand         !== undefined) updates.brand         = body.brand ?? null;
  if (body.priceTiers    !== undefined) updates.price_tiers   = Array.isArray(body.priceTiers) ? body.priceTiers : [];
  if (body.isB2b         !== undefined) updates.is_b2b        = Boolean(body.isB2b);
  if (body.moq           !== undefined) updates.moq           = parseInt(String(body.moq), 10);
  if (body.taxMode       !== undefined) updates.tax_mode      = (['none','included','excluded'] as const).includes(body.taxMode) ? body.taxMode : 'none';
  if (body.feeAbsorbedByStore !== undefined) updates.fee_absorbed_by_store = Boolean(body.feeAbsorbedByStore);

  let { data, error } = await getSupabaseAdmin()
    .from('products').update(updates).eq('id', id).select().single();

  // `cost` (migration_v3_3) may not exist on the live DB yet — drop it and
  // retry so the rest of the edit still saves instead of 500ing outright.
  if (error && isMissingColumnError(error) && 'cost' in updates) {
    const { cost: _cost, ...rest } = updates;
    ({ data, error } = await getSupabaseAdmin()
      .from('products').update(rest).eq('id', id).select().single());
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  pingRealtime(['catalog']);
  return NextResponse.json(mapProduct(data));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseInt((await params).id, 10);
  { const denied = await requireProductOwner(req, id); if (denied) return denied; }
  const sb = getSupabaseAdmin();

  // Related rows in business_products / reviews / wishlists cascade away
  // automatically. The one blocker is order_items, whose product FK is
  // ON DELETE RESTRICT — so a product that has ever been sold can't be
  // deleted. order_items is a normalized analytics table the app does NOT
  // read (every screen uses orders.items JSONB, which stays intact), so we
  // clear this product's lines and retry. The orders themselves are untouched.
  let { error } = await sb.from('products').delete().eq('id', id);
  if (error && /order_items/i.test(error.message)) {
    await sb.from('order_items').delete().eq('product_id', id);
    ({ error } = await sb.from('products').delete().eq('id', id));
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  pingRealtime(['catalog']);
  return NextResponse.json({ success: true });
}
