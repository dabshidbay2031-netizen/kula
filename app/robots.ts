import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/siteMeta';

/**
 * Generated robots.txt — replaces the static public/robots.txt, which carried
 * a `# Sitemap: https://YOUR_DOMAIN/sitemap.xml` placeholder that would never
 * have pointed anywhere real.
 *
 * Crawlers are kept out of the API (order and customer data) and the
 * signed-in-only surfaces. Those are already authorised server-side; this
 * just stops crawl budget being spent on pages that can only return a login.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/auth/',
          '/#/admin',
          '/#/pos',
          '/#/checkout',
          '/#/settings',
          '/#/chat',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
