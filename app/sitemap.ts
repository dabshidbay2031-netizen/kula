import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/siteMeta';
import { getSupabaseAdmin } from '@/lib/supabase';

/**
 * Sitemap.
 *
 * IMPORTANT CAVEAT, so nobody is misled by this file existing: the app is a
 * HASH-ROUTED single page (`/#/store/abc`). Everything after the `#` is never
 * sent to the server, so Google sees one URL — the homepage — no matter how
 * many entries are listed here. Store links are included because they are
 * real, shareable and used in social previews, and because the moment the
 * routing moves to real paths this file starts working properly with no
 * further changes.
 *
 * The genuine fix is server-rendered routes for stores and products. See the
 * note in the launch checklist.
 */
export const revalidate = 3600;   // rebuild hourly at most

async function storeSlugs(): Promise<{ slug: string; updated: Date }[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('suppliers')
      .select('slug, created_at')
      .not('slug', 'is', null)
      .in('account_type', ['business', 'supplier'])
      .limit(5000);
    if (error) return [];
    return (data ?? [])
      .filter(r => typeof r.slug === 'string' && r.slug)
      .map(r => ({ slug: String(r.slug), updated: new Date(String(r.created_at ?? Date.now())) }));
  } catch {
    // A sitemap that 500s is worse than a small one — always return something.
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`,            lastModified: now, changeFrequency: 'daily',   priority: 1 },
    { url: `${SITE_URL}/#/search`,    lastModified: now, changeFrequency: 'daily',   priority: 0.8 },
    { url: `${SITE_URL}/#/suppliers`, lastModified: now, changeFrequency: 'weekly',  priority: 0.7 },
    { url: `${SITE_URL}/#/about`,     lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE_URL}/#/contact`,   lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE_URL}/#/refunds`,   lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
    { url: `${SITE_URL}/#/privacy`,   lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
    { url: `${SITE_URL}/#/terms`,     lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
  ];

  const stores = (await storeSlugs()).map(s => ({
    url: `${SITE_URL}/#/${s.slug}`,
    lastModified: s.updated,
    changeFrequency: 'weekly' as const,
    priority: 0.6,
  }));

  return [...staticRoutes, ...stores];
}
