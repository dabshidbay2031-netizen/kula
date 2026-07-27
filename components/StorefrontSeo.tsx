import { SITE_URL, SITE_NAME } from '@/lib/siteMeta';
import type { SeoStore, SeoProduct } from '@/lib/storefrontData';

/**
 * Server-rendered storefront.
 *
 * This is what a crawler — and the first paint — actually receives: the store
 * name, what it sells, and every product with a price and stock state, as
 * plain HTML with real links. No JavaScript required.
 *
 * The Product structured data is the point. It's what lets Google show a
 * price and "In stock" beside the result, which is the difference between a
 * blue link and a listing someone clicks.
 */

function storeJsonLd(store: SeoStore, products: SeoProduct[]) {
  const url = `${SITE_URL}/${store.slug}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Store',
        '@id': `${url}#store`,
        name: store.name,
        url,
        description: store.description || store.bio || `${store.name} on ${SITE_NAME}`,
        ...(store.location ? { address: { '@type': 'PostalAddress', addressLocality: store.location, addressCountry: 'SO' } } : {}),
        ...(store.reviews > 0 ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: store.rating,
            reviewCount: store.reviews,
          },
        } : {}),
        parentOrganization: { '@id': `${SITE_URL}/#organization` },
      },
      {
        '@type': 'ItemList',
        '@id': `${url}#products`,
        numberOfItems: products.length,
        itemListElement: products.map((p, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'Product',
            '@id': `${url}/${p.id}#product`,
            name: p.name,
            url: `${url}/${p.id}`,
            ...(p.imageUrl ? { image: p.imageUrl } : {}),
            ...(p.category ? { category: p.category } : {}),
            offers: {
              '@type': 'Offer',
              price: p.price.toFixed(2),
              priceCurrency: 'USD',
              availability: p.inStock
                ? 'https://schema.org/InStock'
                : 'https://schema.org/OutOfStock',
              url: `${url}/${p.id}`,
              seller: { '@id': `${url}#store` },
            },
          },
        })),
      },
    ],
  };
}

export default function StorefrontSeo({
  store, products,
}: { store: SeoStore; products: SeoProduct[] }) {
  const url = `${SITE_URL}/${store.slug}`;
  const blurb = store.description || store.bio
    || `Shop ${store.name} on ${SITE_NAME} — order online and pay with EVC Plus, ZAAD, SAHAL or eDahab.`;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
      <script
        type="application/ld+json"
        // Built from our own DB rows, serialised — never raw user markup.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(storeJsonLd(store, products)) }}
      />

      <header style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: '2.5rem' }} aria-hidden="true">{store.icon}</span>
        <div>
          <h1 style={{ fontSize: '1.6rem', fontWeight: 800, margin: 0 }}>
            {store.name}
            {store.verified && <span style={{ fontSize: '.8rem', marginLeft: 8, color: '#059669' }}>✓ Verified</span>}
          </h1>
          {store.location && (
            <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '.9rem' }}>
              {store.onlineOnly ? '🌐 Online only' : `📍 ${store.location}`}
            </p>
          )}
        </div>
      </header>

      <p style={{ color: '#475569', maxWidth: 700, lineHeight: 1.6 }}>{blurb}</p>

      <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '28px 0 12px' }}>
        {products.length > 0
          ? `${products.length} product${products.length === 1 ? '' : 's'} from ${store.name}`
          : `${store.name} hasn't listed any products yet`}
      </h2>

      {products.length > 0 && (
        <ul style={{
          listStyle: 'none', padding: 0, margin: 0, display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14,
        }}>
          {products.map(p => (
            <li key={p.id} style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 12 }}>
              <a href={`${url}/${p.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                {p.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.imageUrl}
                    alt={p.name}
                    width={300}
                    height={200}
                    loading="lazy"
                    style={{ width: '100%', height: 130, objectFit: 'cover', borderRadius: 8, marginBottom: 8 }}
                  />
                )}
                <div style={{ fontWeight: 600, fontSize: '.9rem', lineHeight: 1.35 }}>{p.name}</div>
                <div style={{ marginTop: 4, fontWeight: 800 }}>${p.price.toFixed(2)}</div>
                <div style={{ fontSize: '.75rem', color: p.inStock ? '#059669' : '#dc2626' }}>
                  {p.inStock ? 'In stock' : 'Out of stock'}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
