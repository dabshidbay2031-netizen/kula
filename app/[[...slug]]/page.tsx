import type { Metadata } from 'next';
import AppShell from '@/components/AppShell';
import SeoOnly from '@/components/SeoOnly';
import StorefrontSeo from '@/components/StorefrontSeo';
import { getStoreBySlug, getStoreProducts } from '@/lib/storefrontData';
import { RESERVED_ROUTE_SEGMENTS } from '@/lib/slug';
import { SITE_URL, SITE_NAME, SITE_TITLE, SITE_DESCRIPTION, OG_IMAGE } from '@/lib/siteMeta';

/**
 * The app's single page route — now a SERVER component.
 *
 * Everything interactive still happens client-side in <AppShell> exactly as
 * before. What changed is that a clean storefront URL (/city-care-pharmacy)
 * is now rendered on the SERVER first: the store's name, description and
 * products are in the HTML, with per-store <title>/<meta> and Product
 * structured data.
 *
 * Previously this file was 'use client', so the server emitted only a splash
 * screen. Every store looked identical and empty to a crawler, and the whole
 * marketplace was a single indexable page.
 *
 * The other ~33 routes are authenticated (dashboard, POS, inventory, admin…)
 * and must never be indexed, so they stay on hash routing untouched.
 */

/** A single non-reserved segment is a store slug, e.g. /city-care-pharmacy */
function slugFrom(params: { slug?: string[] }): string | null {
  const segs = params.slug ?? [];
  if (segs.length !== 1) return null;
  const first = segs[0].toLowerCase();
  return RESERVED_ROUTE_SEGMENTS.has(first) ? null : first;
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug?: string[] }> },
): Promise<Metadata> {
  const slug = slugFrom(await params);
  // `absolute` everywhere in here: the layout's "%s — Hamar Mall" template
  // would otherwise append the brand a second time, giving
  // "Hamar Mall — Somalia's Online Marketplace — Hamar Mall".
  if (!slug) {
    return {
      title: { absolute: SITE_TITLE },
      description: SITE_DESCRIPTION,
      alternates: { canonical: '/' },
    };
  }

  const store = await getStoreBySlug(slug);
  // Unknown slug: the shell will handle it. Don't invent metadata for it.
  if (!store) {
    return { title: { absolute: SITE_TITLE }, description: SITE_DESCRIPTION };
  }

  const url   = `${SITE_URL}/${store.slug}`;
  // `absolute` bypasses the layout's "%s — Hamar Mall" template, which would
  // otherwise produce a second em-dash: "Prioche — Shop online in Somalia —
  // Hamar Mall". Keeps it readable and under the ~60 chars Google shows.
  const title = `${store.name} — Shop online in Somalia | ${SITE_NAME}`;
  const desc  = (store.description || store.bio
    || `Buy from ${store.name} on ${SITE_NAME}. Order online and pay with EVC Plus, ZAAD, SAHAL or eDahab.`
  ).slice(0, 155);

  return {
    title: { absolute: title },
    description: desc,
    alternates: { canonical: `/${store.slug}` },
    openGraph: {
      type: 'website',
      title, description: desc, url,
      siteName: SITE_NAME,
      images: [{ url: OG_IMAGE, width: 512, height: 512, alt: store.name }],
    },
    twitter: { card: 'summary_large_image', title, description: desc, images: [OG_IMAGE] },
  };
}

export default async function Page(
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const slug  = slugFrom(await params);
  const store = slug ? await getStoreBySlug(slug) : null;

  // Not a storefront (or no such store) — behave exactly as before.
  if (!store) return <AppShell />;

  const products = await getStoreProducts(store.id);

  return (
    <>
      {/* Real content for crawlers and the first paint. Removes itself once
          the interactive storefront has hydrated, so nothing renders twice. */}
      <SeoOnly>
        <StorefrontSeo store={store} products={products} />
      </SeoOnly>
      <AppShell />
    </>
  );
}
