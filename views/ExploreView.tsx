'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter } from '@/lib/hashRouter';
import Header from '@/components/Header';
import ProductCard from '@/components/ProductCard';
import ProductImage from '@/components/ProductImage';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { CATEGORIES, SUBCATEGORIES, stockedCategories } from '@/lib/data';
import { useClaimProduct } from '@/lib/useClaimProduct';
import { useShuffleSeed } from '@/lib/shuffle';
import { personalizeMix, useAffinity, useRecordInterest } from '@/lib/affinity';
import { useHeroBanner } from '@/lib/useHeroBanner';
import { useFeedTiers } from '@/lib/useFeedTiers';
import { rankAndDiversify, tierFor } from '@/lib/feedRanking';
import { districtFor, MOGADISHU_DISTRICTS } from '@/lib/districts';

export default function ExplorePage() {
  const router = useRouter();
  const { state, setCartOpen, addToCart, toggleWishlist } = useApp();
  const shuffleSeed = useShuffleSeed();
  const affinity    = useAffinity();
  const record      = useRecordInterest();
  const { accountType } = useAuth();
  const { products, loading } = state;
  const { canClaim, claim, isMine, claimingId } = useClaimProduct();
  const hero = useHeroBanner();
  const feedTiers = useFeedTiers();
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [activeSub, setActiveSub] = useState('all');
  const [activeDistrict, setActiveDistrict] = useState('all');

  // Subcategories for the selected category (only shown once a category is picked)
  const subCats = activeCategory !== 'all' ? (SUBCATEGORIES[activeCategory] ?? []) : [];

  /**
   * Only offer categories that actually have something to show — the same rule
   * the POS shelf already follows. A chip for a category with no products
   * filters the grid to nothing, which reads as a broken page rather than an
   * empty shelf.
   *
   * Measured against the *discoverable* pool: B2B-only stock the shopper can't
   * see, and anything an admin marked Hidden, must not keep a chip alive.
   */
  const availableCategories = useMemo(() => {
    const discoverable = products.filter(p =>
      (!p.isB2b || accountType === 'business' || accountType === 'supplier') &&
      tierFor(p, feedTiers) !== 'hidden');
    return stockedCategories(discoverable);
  }, [products, accountType, feedTiers]);

  // A category can empty out while it is selected (last unit sold, product
  // hidden by an admin). Its chip disappears but the selection would persist,
  // leaving an empty grid and no lit chip to explain why — fall back to All.
  useEffect(() => {
    if (activeCategory !== 'all' && !availableCategories.some(c => c.id === activeCategory)) {
      setActiveCategory('all');
      setActiveSub('all');
    }
  }, [availableCategories, activeCategory]);

  // O(1) lookups instead of Array.includes in every card render
  const wishlistSet  = useMemo(() => new Set(state.wishlist),    [state.wishlist]);
  const inventoryMap = useMemo(() =>
    new Map(state.inventory.map(i => [i.id, i.stock])),
  [state.inventory]);

  // Store GPS → recognised district ("📍 Hodan"), falling back to the store's
  // free-text location when it has no coordinates yet.
  const districtBySupplier = useMemo(() =>
    new Map(state.suppliers.map(s =>
      [s.id, districtFor(s.latitude, s.longitude) ?? (s.location || null)])),
  [state.suppliers]);

  // Which stores are internet-only (no shopfront) → card shows "🌐 Online store".
  const onlineBySupplier = useMemo(() =>
    new Map(state.suppliers.map(s => [s.id, !!s.onlineOnly])),
  [state.suppliers]);

  // Store name + verified flag per supplier → shown on each product card.
  const nameBySupplier = useMemo(() =>
    new Map(state.suppliers.map(s => [s.id, s.name])),
  [state.suppliers]);
  const verifiedBySupplier = useMemo(() =>
    new Map(state.suppliers.map(s => [s.id, !!s.verified])),
  [state.suppliers]);

  // Recognised Mogadishu district per store (GPS only, no free-text fallback) —
  // powers the district filter so "Hodan" matches only stores actually in Hodan.
  const recognizedDistrictBySupplier = useMemo(() =>
    new Map(state.suppliers.map(s => [s.id, districtFor(s.latitude, s.longitude)])),
  [state.suppliers]);

  // Only offer districts that actually have products, so the picker never
  // shows an option that resolves to an empty grid.
  const availableDistricts = useMemo(() => {
    const present = new Set<string>();
    for (const p of products) {
      const d = p.supplierId != null ? recognizedDistrictBySupplier.get(p.supplierId) : null;
      if (d) present.add(d);
    }
    return MOGADISHU_DISTRICTS.filter(d => present.has(d.name))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b));
  }, [products, recognizedDistrictBySupplier]);

  const filtered = useMemo(() => {
    // The API returns the catalog ordered by id, so without this a bulk import
    // shows up as one solid block. Shuffle the base list (fresh each visit,
    // stable while scrolling) and blend ~30% toward what this shopper looks
    // for — filtering below preserves that order.
    const base = personalizeMix(products, affinity, shuffleSeed);
    // Filter out B2B-only products for non-business/supplier users
    let list = base.filter(p => !p.isB2b || accountType === 'business' || accountType === 'supplier');
    if (activeCategory !== 'all') list = list.filter(p => p.category === activeCategory);
    if (activeSub !== 'all')      list = list.filter(p => p.subCategory === activeSub);
    if (activeDistrict !== 'all') list = list.filter(p =>
      p.supplierId != null && recognizedDistrictBySupplier.get(p.supplierId) === activeDistrict);
    if (search.trim()) {
      const q = search.toLowerCase();
      // Match the subcategory's display NAME too (e.g. searching "laptops")
      const subName = (p: typeof products[number]) =>
        (SUBCATEGORIES[p.category]?.find(s => s.id === p.subCategory)?.name ?? '').toLowerCase();
      list = list.filter(p =>
        p.name.toLowerCase().includes(q)             ||
        p.description.toLowerCase().includes(q)      ||
        p.sku.toLowerCase().includes(q)              ||
        p.category.toLowerCase().includes(q)         ||
        subName(p).includes(q)                       ||
        (p.brand ?? '').toLowerCase().includes(q)    ||
        (p.tags  ?? []).some(t => t.toLowerCase().includes(q))
      );
    }
    // Rank LAST, over exactly what this view will show.
    //
    // Ranking before the filters only holds the "≤N cards from one store per 10"
    // invariant on the unfiltered grid: narrowing to a category preserves
    // relative order but not the spacing, so an electronics-heavy store could
    // still take 6 of the first 10 under the Electronics chip. Running the pass
    // over the filtered list makes the cap true in EVERY view, and it is cheaper
    // — the scheduler walks a shorter list, and this memo already recomputes on
    // each filter change regardless. Empty tiers ⇒ returns the list unchanged.
    return rankAndDiversify(list, feedTiers, verifiedBySupplier, shuffleSeed);
  }, [products, affinity, shuffleSeed, feedTiers, verifiedBySupplier, search, activeCategory, activeSub, activeDistrict, recognizedDistrictBySupplier, accountType]);

  // Best Sellers renders on the Explore page, so it is part of Explore discovery
  // and must honour Hidden too — otherwise a product an admin hid would keep
  // showing here, in the most prominent strip on the page. (Only Hidden applies:
  // Reduced/Low bias the *draw* into the grid, and this row is ranked by sales.)
  const bestSellers = useMemo(() =>
    products.filter(p => tierFor(p, feedTiers) !== 'hidden')
      .sort((a, b) => b.sold - a.sold).slice(0, 8),
  [products, feedTiers]);

  // ── Pagination: 300 products per page ─────────────────────────
  // Replaces infinite scroll — a bounded page keeps the DOM small (≤300 cards
  // instead of the whole catalog) and gives clear Prev/Next controls.
  const PAGE_SIZE = 300;
  const [page, setPage] = useState(1);
  const filterKey = `${search}|${activeCategory}|${activeSub}|${activeDistrict}`;
  // A new filter/search always starts back on page 1.
  useEffect(() => { setPage(1); }, [filterKey]);

  const totalPages = Math.max(Math.ceil(filtered.length / PAGE_SIZE), 1);
  const safePage   = Math.min(page, totalPages);
  const pageStart  = (safePage - 1) * PAGE_SIZE;
  const visible     = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const goToPage = (n: number) => {
    const clamped = Math.min(Math.max(n, 1), totalPages);
    setPage(clamped);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Compact page-number window around the current page (… for gaps).
  const pageNumbers = useMemo<(number | '…')[]>(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const out: (number | '…')[] = [1];
    const lo = Math.max(2, safePage - 1), hi = Math.min(totalPages - 1, safePage + 1);
    if (lo > 2) out.push('…');
    for (let i = lo; i <= hi; i++) out.push(i);
    if (hi < totalPages - 1) out.push('…');
    out.push(totalPages);
    return out;
  }, [totalPages, safePage]);

  return (
    <div className="page-anim">
      {/* The Explore header search hands off to the dedicated Search page
          (better results: stores, nearby offers, barcode) instead of the
          simple in-place filter. */}
      <Header searchQuery={search} onSearch={setSearch} onSearchFocus={() => router.push('/search')} />

      {/* Hot Deals Banner — copy & image configurable by admins (Admin → Storefront) */}
      {!search && activeCategory === 'all' && activeDistrict === 'all' && hero.enabled && (
        <div className={`banner${hero.imageUrl ? ' banner-has-photo' : ''}`}>
          {hero.imageUrl && (
            // Full-bleed hero photo behind the copy (aria-hidden — decorative)
            // eslint-disable-next-line @next/next/no-img-element
            <img className="banner-bg" src={hero.imageUrl} alt="" aria-hidden="true" />
          )}
          <div className="banner-content">
            {hero.tag && <span className="banner-tag">{hero.tag}</span>}
            {hero.title && <h2>{hero.title}</h2>}
            {hero.subtitle && <p>{hero.subtitle}</p>}
            {hero.ctaLabel && (
              <button className="btn btn-secondary btn-sm" onClick={() => setCartOpen(true)}>
                {hero.ctaLabel}
              </button>
            )}
          </div>
          {!hero.imageUrl && <span className="banner-emoji">🛍️</span>}
        </div>
      )}

      {/* District filter — browse products by Mogadishu district */}
      <div className="district-filter">
        <span className="district-filter-label">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          District
        </span>
        <select
          className="district-select"
          value={activeDistrict}
          onChange={e => setActiveDistrict(e.target.value)}
          aria-label="Filter products by Mogadishu district"
        >
          <option value="all">All Mogadishu</option>
          {availableDistricts.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {activeDistrict !== 'all' && (
          <button className="district-clear" onClick={() => setActiveDistrict('all')} aria-label="Clear district filter">✕</button>
        )}
      </div>

      {/* Category chips */}
      <div className="explore-categories">
        <div className="chips-row">
          <button
            className={`chip ${activeCategory === 'all' ? 'active' : ''}`}
            onClick={() => { setActiveCategory('all'); setActiveSub('all'); }}
          >
            All
          </button>
          {availableCategories.map(cat => (
            <button
              key={cat.id}
              className={`chip ${activeCategory === cat.id ? 'active' : ''}`}
              onClick={() => { setActiveCategory(cat.id); setActiveSub('all'); record(cat.id, null, 'category'); }}
            >
              {cat.icon} {cat.name}
            </button>
          ))}
        </div>

        {/* Subcategory chips — shown once a category is selected */}
        {subCats.length > 0 && (
          <div className="chips-row" style={{ marginTop: 6 }}>
            <button
              className={`chip chip-sm ${activeSub === 'all' ? 'active' : ''}`}
              onClick={() => setActiveSub('all')}
            >
              All
            </button>
            {subCats.map(s => (
              <button
                key={s.id}
                className={`chip chip-sm ${activeSub === s.id ? 'active' : ''}`}
                onClick={() => { setActiveSub(s.id); record(activeCategory, s.id, 'category'); }}
              >
                {s.icon} {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Best Sellers */}
      {!search && activeCategory === 'all' && activeDistrict === 'all' && bestSellers.length > 0 && (
        <>
          <div className="section-header">
            <span className="section-title">🏆 Best Sellers</span>
          </div>
          <div style={{ overflowX: 'auto', display: 'flex', gap: 12, padding: '0 16px 16px', scrollbarWidth: 'none' }}>
            {bestSellers.map(p => (
              <div
                key={p.id}
                className="similar-card bestseller-card"
                style={{ flexShrink: 0, width: 140 }}
                onClick={() => router.push(`/product/${p.id}`)}
              >
                <div className="similar-img">
                  <ProductImage imageUrl={p.imageUrl} imageUrls={p.imageUrls} name={p.name} style={{ borderRadius: 8 }} />
                </div>
                <div className="similar-body">
                  <div className="similar-name">{p.name}</div>
                  <div className="similar-price">${p.price.toFixed(2)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Products grid */}
      <div className="section-header">
        <span className="section-title">
          {search
            ? `Results for "${search}"`
            : activeCategory === 'all'
              ? '🛒 All Products'
              : CATEGORIES.find(c => c.id === activeCategory)?.name}
          {activeDistrict !== 'all' && (
            <span style={{ color: 'var(--primary)', fontWeight: 700 }}> · 📍 {activeDistrict}</span>
          )}
        </span>
        <span className="text-muted text-sm">
          {filtered.length > PAGE_SIZE
            ? `${pageStart + 1}–${Math.min(pageStart + PAGE_SIZE, filtered.length)} of ${filtered.length}`
            : `${filtered.length} items`}
        </span>
      </div>

      {loading ? (
        <div className="product-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="product-card">
              <div className="skeleton" style={{ aspectRatio: '1' }} />
              <div className="product-body" style={{ gap: 8 }}>
                <div className="skeleton" style={{ height: 14, borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 12, width: '60%', borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 32, borderRadius: 8 }} />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <div className="empty-title">No products found</div>
          <div className="empty-sub">Try a different search or category</div>
        </div>
      ) : (
        <>
          <div className="product-grid">
            {visible.map(p => (
              <ProductCard
                key={p.id}
                product={p}
                storeDistrict={p.supplierId != null ? districtBySupplier.get(p.supplierId) ?? null : null}
                storeOnlineOnly={p.supplierId != null ? onlineBySupplier.get(p.supplierId) ?? false : false}
                storeName={p.supplierId != null ? nameBySupplier.get(p.supplierId) ?? null : null}
                storeVerified={p.supplierId != null ? verifiedBySupplier.get(p.supplierId) ?? false : false}
                isWishlisted={wishlistSet.has(p.id)}
                stock={inventoryMap.get(p.id) ?? p.stock}
                onAddToCart={addToCart}
                onToggleWishlist={toggleWishlist}
                canClaim={canClaim}
                isClaimed={canClaim && isMine(p.id)}
                claiming={claimingId === p.id}
                onClaim={claim}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <nav className="pagination" aria-label="Product pages">
              <button
                className="page-btn"
                onClick={() => goToPage(safePage - 1)}
                disabled={safePage === 1}
                aria-label="Previous page"
              >
                ← Prev
              </button>

              {pageNumbers.map((n, i) =>
                n === '…' ? (
                  <span key={`gap-${i}`} className="page-gap">…</span>
                ) : (
                  <button
                    key={n}
                    className={`page-btn${n === safePage ? ' active' : ''}`}
                    onClick={() => goToPage(n)}
                    aria-current={n === safePage ? 'page' : undefined}
                  >
                    {n}
                  </button>
                )
              )}

              <button
                className="page-btn"
                onClick={() => goToPage(safePage + 1)}
                disabled={safePage === totalPages}
                aria-label="Next page"
              >
                Next →
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
