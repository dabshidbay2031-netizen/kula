/**
 * Canonical site identity — one source of truth for SEO, social cards and
 * structured data.
 *
 * Set NEXT_PUBLIC_SITE_URL to the real domain in production. Everything that
 * needs an absolute URL (Open Graph images, canonicals, the sitemap) reads it
 * from here, so there is exactly one place to change on launch.
 */
import { PHONES, SOCIAL_URLS, SUPPORT_EMAIL } from '@/lib/contactInfo';

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://hamarmall.com'
).replace(/\/$/, '');

export const SITE_NAME = 'Hamar Mall';

/** Under ~60 chars so Google doesn't truncate it in results. */
export const SITE_TITLE = "Hamar Mall — Somalia's Online Marketplace";

/**
 * Under ~155 chars, leads with what the page IS and who it serves. Search
 * engines rewrite descriptions freely, but a clear one still wins the click.
 */
export const SITE_DESCRIPTION =
  'Shop online in Somalia. Buy from local stores in Mogadishu and across the ' +
  'country, pay with EVC Plus, ZAAD, SAHAL or eDahab, and get it delivered.';

/**
 * The phrases real buyers and sellers actually type. Meta keywords carry no
 * ranking weight with Google any more — these exist for the smaller engines
 * that still read them, and to keep the vocabulary in one reviewable place.
 */
export const SITE_KEYWORDS = [
  'Somalia marketplace', 'Somalia online shopping', 'Mogadishu online store',
  'suuq online Soomaaliya', 'iibso online Soomaaliya', 'online shopping Somalia',
  'Somali ecommerce', 'buy online Mogadishu', 'EVC Plus shopping',
  'ZAAD online payment', 'eDahab shopping', 'Hamar Mall',
  'wholesale Somalia', 'point of sale Somalia', 'POS Soomaaliya',
];

export const OG_IMAGE = `${SITE_URL}/icons/icon-512.png`;

/**
 * Organization + WebSite structured data.
 *
 * The WebSite node carries a SearchAction, which is what lets Google show a
 * search box under the listing. Serialised into a <script type="application/
 * ld+json"> in the root layout.
 */
export function siteJsonLd() {
  // Phone + social profiles come from lib/contactInfo so the footer, the
  // contact page and this schema can never drift apart.
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: SITE_NAME,
        url: SITE_URL,
        logo: { '@type': 'ImageObject', url: OG_IMAGE, width: 512, height: 512 },
        description: SITE_DESCRIPTION,
        areaServed: { '@type': 'Country', name: 'Somalia' },
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Mogadishu',
          addressCountry: 'SO',
        },
        email: SUPPORT_EMAIL,
        telephone: PHONES.map(p => `+${p.e164}`),
        // `sameAs` is how Google links this site to the Facebook and TikTok
        // accounts — without it they're treated as unrelated strangers.
        sameAs: SOCIAL_URLS,
        contactPoint: PHONES.map(p => ({
          '@type': 'ContactPoint',
          telephone: `+${p.e164}`,
          contactType: 'customer service',
          areaServed: 'SO',
          availableLanguage: ['so', 'en'],
        })),
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: SITE_URL,
        name: SITE_TITLE,
        description: SITE_DESCRIPTION,
        publisher: { '@id': `${SITE_URL}/#organization` },
        inLanguage: ['en', 'so'],
        potentialAction: {
          '@type': 'SearchAction',
          target: {
            '@type': 'EntryPoint',
            urlTemplate: `${SITE_URL}/#/search?q={search_term_string}`,
          },
          'query-input': 'required name=search_term_string',
        },
      },
      {
        '@type': 'OnlineStore',
        '@id': `${SITE_URL}/#store`,
        name: SITE_NAME,
        url: SITE_URL,
        image: OG_IMAGE,
        description: SITE_DESCRIPTION,
        areaServed: { '@type': 'Country', name: 'Somalia' },
        currenciesAccepted: 'USD',
        paymentAccepted: 'Cash, EVC Plus, ZAAD, SAHAL, eDahab, Premier Wallet',
        telephone: `+${PHONES[0].e164}`,
        email: SUPPORT_EMAIL,
        sameAs: SOCIAL_URLS,
      },
    ],
  };
}
