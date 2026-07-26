import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireStaff, requireSupplierAccess } from '@/lib/apiAuth';
import { errMsg, isMissingColumnError, isForeignKeyError, jsonWithEtag } from '@/lib/apiHelpers';
import { pingRealtime } from '@/lib/realtimeServer';
import { similarProducts } from '@/lib/similarity';
import type { Product } from '@/lib/types';

function mapProduct(p: Record<string, unknown>) {
  const id      = typeof p.id === 'number' ? p.id : parseInt(String(p.id), 10);
  // Dedupe + trim tags — seeded rows contained ['electronics','electronics'],
  // which breaks React list keys and double-counts in similarity scoring.
  const tags    = Array.isArray(p.tags)
    ? Array.from(new Set((p.tags as string[]).map(t => String(t).trim()).filter(Boolean)))
    : [];
  const brand   = (p.brand   && String(p.brand).trim())   ? String(p.brand)   : null;
  const barcode = (p.barcode && String(p.barcode).trim())  ? String(p.barcode) : null;
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
    supplierId:    p.supplier_id   ?? null,
    rating:        p.rating,
    reviews:       p.reviews,
    sold:          p.sold,
    description:   p.description,
    barcode,
    tags,
    brand,
    imageUrl:      p.image_url     ?? null,
    imageUrls:     p.image_urls    ?? [],
    priceTiers:    Array.isArray(p.price_tiers) ? p.price_tiers : [],
    isB2b:         Boolean(p.is_b2b ?? false),
    moq:           (p.moq as number) ?? 1,
    taxMode:       (p.tax_mode as 'none' | 'included' | 'excluded') ?? 'none',
    // Provenance for a copied listing (migration_v4_0) — absent column → null.
    copiedFromProductId: (p.copied_from_product_id as number | undefined) ?? null,
    // Store pays the 3% platform fee for this product (migration_v4_2).
    feeAbsorbedByStore: Boolean(p.fee_absorbed_by_store ?? false),
  };
}

/** Search filter — checks name, description, sku, brand, tags */
function matchesQuery(p: { name?: unknown; description?: unknown; sku?: unknown; brand?: unknown | null; tags?: unknown }, q: string): boolean {
  const qL   = q.toLowerCase();
  const name = String(p.name  ?? '').toLowerCase();
  const desc = String(p.description ?? '').toLowerCase();
  const sku  = String(p.sku   ?? '').toLowerCase();
  const brand= String(p.brand ?? '').toLowerCase();
  const tags = Array.isArray(p.tags) ? (p.tags as string[]) : [];
  return name.includes(qL)  || desc.includes(qL) || sku.includes(qL) ||
         brand.includes(qL) || tags.some(t => String(t).toLowerCase().includes(qL));
}

/**
 * Fetches the full product catalog directly from the DB.
 * DB is the ONLY source of truth — no static seed fallback.
 * Returns null only when the DB is completely unreachable.
 */
async function getCatalogFromDB(): Promise<ReturnType<typeof mapProduct>[] | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('products').select('*').order('id');
    if (error) throw error;
    return (data ?? []).map(r => mapProduct(r as Record<string, unknown>));
  } catch {
    return null; // DB unreachable
  }
}

const DEFAULT_PAGE_SIZE = 300;
const MAX_PAGE_SIZE     = 500;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const barcode    = searchParams.get('barcode');
  const category   = searchParams.get('category');
  const q          = searchParams.get('q');
  const supplierId = searchParams.get('supplierId');
  const similarTo  = searchParams.get('similarTo');
  const pageParam  = searchParams.get('page');

  // Edge-cacheable: the first shopper in a region pays the origin+DB cost, then
  // Vercel serves everyone else from the edge for a minute (and stale for 5 more
  // while it refreshes). Combined with the ETag, repeat visitors get a 0-byte 304.
  const CACHE = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' };

  // ── Supplier product filter (full fields — inventory/dashboard need them) ──
  if (supplierId) {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from('products').select('*').eq('supplier_id', parseInt(supplierId, 10)).order('id');
      if (error) throw error;
      return NextResponse.json((data ?? []).map(r => mapProduct(r as Record<string, unknown>)));
    } catch {
      return NextResponse.json([]);
    }
  }

  // ── Barcode lookup (exact match) ──────────────────────────────
  if (barcode) {
    try {
      const { data } = await getSupabaseAdmin()
        .from('products').select('*').eq('barcode', barcode).maybeSingle();
      if (data) return NextResponse.json(mapProduct(data as Record<string, unknown>));
    } catch { /* fall through */ }
    return NextResponse.json(null, { status: 404 });
  }

  // ── Build catalog purely from DB ─────────────────────────────
  const catalog = await getCatalogFromDB();
  const all = catalog ?? []; // DB unreachable → empty (never static seed)

  // ── "Similar products" — computed over the WHOLE catalog ──────
  // Returns as many genuinely-related items as possible (same category +
  // shared tags rank highest); independent of what the client has paged in.
  if (similarTo) {
    const id = parseInt(similarTo, 10);
    const allP = all as unknown as Product[];
    const base = allP.find(p => p.id === id);
    if (!base) return jsonWithEtag(req, [], CACHE);
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '24', 10) || 24, 1), 100);
    return jsonWithEtag(req, similarProducts(base, allP, limit), CACHE);
  }

  // ── Apply filters (before paging) ─────────────────────────────
  let result = all;
  if (category) result = result.filter(p => p.category === category);
  if (q)        result = result.filter(p => matchesQuery(p, q));

  // ── Server-side pagination (opt-in via ?page) ─────────────────
  // Default 300 per page. Returns an envelope; the un-paged call still
  // returns a flat array so existing in-memory consumers keep working.
  if (pageParam !== null) {
    const page     = Math.max(parseInt(pageParam, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const total    = result.length;
    const start    = (page - 1) * pageSize;
    const items    = result.slice(start, start + pageSize);
    return jsonWithEtag(req, {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
      hasMore: start + pageSize < total,
    }, CACHE);
  }

  return jsonWithEtag(req, result, CACHE);
}

export async function POST(req: Request) {
  { const denied = await requireStaff(req, 'inventory_edit'); if (denied) return denied; }
  const body = await req.json();
  const {
    name, price, originalPrice, cost, category, subCategory, stock,
    sku, description, imageUrl, imageUrls, supplierId, barcode, tags, brand,
    priceTiers, isB2b, moq, taxMode, feeAbsorbedByStore,
  } = body;

  if (!name || !price || !category) {
    return NextResponse.json({ error: 'name, price, and category are required' }, { status: 400 });
  }

  // Store-scope the create: a product attributed to a store may only be made by
  // that store's owner / staff / admin, or the field agent currently setting it
  // up. Without this, requireStaff alone let ANY seller stuff a product into a
  // rival's store by spoofing supplierId (and it's what lets an agent add
  // products to the store they onboarded).
  if (supplierId) {
    const denied = await requireSupplierAccess(req, parseInt(String(supplierId), 10), 'inventory_edit');
    if (denied) return denied;
  }

  const fullProduct: Record<string, unknown> = {
    name:           String(name).trim(),
    price:          parseFloat(price),
    original_price: parseFloat(originalPrice ?? price),
    cost:           parseFloat(cost ?? '0') || 0,
    category,
    sub_category:   subCategory  ?? null,
    stock:          parseInt(stock ?? '0', 10),
    sku:            sku?.trim()  ?? `SKU-${Date.now()}`,
    supplier_id:    supplierId   ? parseInt(String(supplierId), 10) : null,
    rating: 0, reviews: 0, sold: 0,
    description:    description?.trim() ?? '',
    barcode:        barcode?.trim()     ?? null,
    tags:           Array.isArray(tags) ? tags : [],
    brand:          brand?.trim()       ?? null,
    image_url:      imageUrl            ?? null,
    image_urls:     Array.isArray(imageUrls) ? imageUrls : [],
    price_tiers:    Array.isArray(priceTiers) ? priceTiers : [],
    is_b2b:         Boolean(isB2b ?? false),
    moq:            parseInt(moq ?? '1', 10),
    tax_mode:       (['none','included','excluded'] as const).includes(taxMode) ? taxMode : 'none',
    fee_absorbed_by_store: Boolean(feeAbsorbedByStore ?? false),
  };

  const basicProduct: Record<string, unknown> = {
    name: fullProduct.name, price: fullProduct.price,
    original_price: fullProduct.original_price, category: fullProduct.category,
    stock: fullProduct.stock, sku: fullProduct.sku,
    supplier_id: fullProduct.supplier_id, rating: 0, reviews: 0, sold: 0,
    description: fullProduct.description,
  };

  // Compute next safe ID (bypasses broken SERIAL sequence)
  const { data: maxRow } = await getSupabaseAdmin()
    .from('products').select('id').order('id', { ascending: false }).limit(1).maybeSingle();
  const nextId = ((maxRow?.id as number) ?? 0) + 1;

  const LEGACY_CATS: Record<string, string> = {
    medicine:'health', cosmetics:'health', construction:'home',
    furniture:'home',  cars:'home',        books:'food',
    clothes:'fashion', other:'sports',
  };

  // `cost` (migration_v3_3) may not exist on the live DB. Retry WITHOUT just
  // that column before collapsing to basicProduct — the old fallback silently
  // threw away photos/barcode/tags/brand whenever any one column was missing.
  const { cost: _cost, ...fullNoCost } = fullProduct;
  // fee_absorbed_by_store ships in migration_v4_2 — drop it before falling all
  // the way back to basicProduct, which would also discard photos/tags/barcode.
  const { fee_absorbed_by_store: _fee, ...fullNoFee }     = fullProduct;
  const { fee_absorbed_by_store: _fee2, ...noCostNoFee }  = fullNoCost;
  const attempts = [
    { ...fullProduct,  id: nextId },
    { ...fullNoFee,    id: nextId },
    { ...fullNoCost,   id: nextId },
    { ...noCostNoFee,  id: nextId },
    { ...basicProduct, id: nextId },
    { ...basicProduct, id: nextId, category: LEGACY_CATS[category] ?? 'electronics' },
  ];

  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      const { data, error } = await getSupabaseAdmin()
        .from('products').insert(attempt).select().single();
      if (error) throw error;
      const result = mapProduct(data as Record<string, unknown>);
      pingRealtime(['catalog']); // storefronts refresh instantly
      return NextResponse.json({ ...result, category }, { status: 201 });
    } catch (e) {
      lastErr = e;
      if (!isMissingColumnError(e) && !isForeignKeyError(e)) break;
    }
  }
  return NextResponse.json({ error: errMsg(lastErr) }, { status: 500 });
}
