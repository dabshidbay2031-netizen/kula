import { getSupabaseAdmin } from '@/lib/supabase';

/**
 * Server-side storefront data, for rendering a store page as real HTML.
 *
 * The SPA fetches this in the browser, which is fine for shoppers but means a
 * crawler receives an empty splash screen — the store's name, description and
 * products never exist in the HTML. Everything here runs on the server so the
 * page has content before any JavaScript executes.
 *
 * PUBLIC DATA ONLY. A storefront is world-readable, so nothing here needs (or
 * gets) the caller's identity — no contact numbers, no owner ids, no stock
 * counts for a store that hides them.
 */

export interface SeoProduct {
  id:       number;
  name:     string;
  price:    number;
  imageUrl: string | null;
  category: string;
  inStock:  boolean;
}

export interface SeoStore {
  id:          number;
  name:        string;
  slug:        string;
  description: string;
  bio:         string;
  icon:        string;
  location:    string;
  verified:    boolean;
  rating:      number;
  reviews:     number;
  onlineOnly:  boolean;
}

/** Look a store up by its clean URL slug. Null when there isn't one. */
export async function getStoreBySlug(slug: string): Promise<SeoStore | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('suppliers')
      .select('id, name, slug, description, bio, icon, location, verified, rating, reviews, online_only, account_type, approval_status')
      .eq('slug', slug.toLowerCase())
      .maybeSingle();
    if (error || !data) return null;

    // Agents and customers have no storefront to show.
    if (data.account_type !== 'business' && data.account_type !== 'supplier') return null;

    return {
      id:          Number(data.id),
      name:        String(data.name ?? ''),
      slug:        String(data.slug ?? ''),
      description: String(data.description ?? ''),
      bio:         String(data.bio ?? ''),
      icon:        String(data.icon ?? '🏪'),
      location:    String(data.location ?? ''),
      verified:    Boolean(data.verified),
      rating:      Number(data.rating) || 0,
      reviews:     Number(data.reviews) || 0,
      onlineOnly:  Boolean(data.online_only),
    };
  } catch {
    return null;
  }
}

/**
 * What this store sells: catalog rows it OWNS plus rows it CLAIMS from a
 * wholesaler (at the store's own price). Mirrors the split the dashboard uses
 * — a store selling only claimed items would otherwise look empty.
 */
export async function getStoreProducts(storeId: number, limit = 60): Promise<SeoProduct[]> {
  const sb = getSupabaseAdmin();
  const out = new Map<number, SeoProduct>();

  const shape = (p: Record<string, unknown>, price?: number, stock?: number): SeoProduct => ({
    id:       Number(p.id),
    name:     String(p.name ?? ''),
    price:    Number(price ?? p.price) || 0,
    imageUrl: (Array.isArray(p.image_urls) && p.image_urls.length
                ? String(p.image_urls[0])
                : (p.image_url as string | null)) ?? null,
    category: String(p.category ?? ''),
    inStock:  Number(stock ?? p.stock ?? 0) > 0,
  });

  try {
    const { data: owned } = await sb
      .from('products')
      .select('id, name, price, stock, category, image_url, image_urls')
      .eq('supplier_id', storeId)
      .limit(limit);
    for (const p of owned ?? []) out.set(Number(p.id), shape(p as Record<string, unknown>));
  } catch { /* a store with no owned rows is normal */ }

  try {
    const { data: claims } = await sb
      .from('business_products')
      .select('custom_price, stock_qty, is_active, products(id, name, price, stock, category, image_url, image_urls)')
      .eq('supplier_id', storeId)
      .eq('is_active', true)
      .limit(limit);
    for (const row of claims ?? []) {
      const p = (row as Record<string, unknown>).products as Record<string, unknown> | null;
      if (!p) continue;
      // The claim record wins — it carries this store's own price and stock.
      out.set(Number(p.id), shape(p, Number(row.custom_price), Number(row.stock_qty)));
    }
  } catch { /* claim table absent on older schemas */ }

  return Array.from(out.values()).slice(0, limit);
}
