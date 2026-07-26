/**
 * Store-link (slug) rules — single source of truth.
 *
 * A store's public URL is `<domain>/<slug>` (today: localhost:3001/city-care,
 * in production: hamarmall.com/city-care — same code, the origin is read at
 * runtime). The Shell treats any single non-reserved path segment as a
 * storefront, so a slug must never collide with a real app route.
 */

/** First URL segments that are real app routes — the Shell must NOT treat
 *  these as storefront slugs. Keep in sync with views/routes.tsx. */
export const RESERVED_ROUTE_SEGMENTS = new Set([
  'dashboard', 'my-dashboard', 'inventory', 'customers', 'suppliers', 'supplier',
  'orders', 'pos', 'settings', 'profile', 'checkout', 'chat', 'notifications',
  'search', 'product', 'admin', 'staff', 'cashier-login', 'auth', 'api',
]);

/** Everything a store may not take as its link: app routes plus names that
 *  would confuse customers or clash with future pages. */
export const RESERVED_SLUGS = new Set([
  ...Array.from(RESERVED_ROUTE_SEGMENTS),
  'privacy', 'terms', 'payment', 'payments', 'legal', 'help', 'support',
  'about', 'contact', 'login', 'signup', 'signin', 'register', 'logout',
  'www', 'app', 'mail', 'blog', 'news', 'store', 'shop', 'stores',
  // Brand names — a store must never be able to impersonate the marketplace.
  // 'mogarenta' stays reserved after the rename so the old name can't be claimed.
  'mogarenta', 'hamarmall', 'hamar-mall', 'hamar',
  'official', 'null', 'undefined',
]);

/**
 * The in-app path to a store's storefront — its clean slug when it has one
 * (`/city-care-pharmacy`), falling back to `/supplier/:id`. Use this instead
 * of hard-coding `/supplier/${id}` so links read as the store's own name.
 */
export function storePath(store: { slug?: string | null; id: number }): string {
  return store.slug ? `/${store.slug}` : `/supplier/${store.id}`;
}

/** Turn a store name into a URL-safe slug: "City Care Pharmacy!" → "city-care-pharmacy". */
export function slugify(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')                 // strip accents: café → cafe
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')       // anything else becomes a dash
    .replace(/-+/g, '-')               // collapse runs of dashes
    .replace(/^-|-$/g, '')             // no leading/trailing dash
    .slice(0, 30)
    .replace(/-$/, '');
}

/** 3–30 chars, a-z 0-9 and inner dashes only, not a reserved word. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,28})?[a-z0-9]$/.test(slug)
    && slug.length >= 3
    && !RESERVED_SLUGS.has(slug);
}
