'use client';

import { useState, useMemo, useEffect, Suspense, lazy } from 'react';
import { useSearchParams, useRouter } from '@/lib/hashRouter';
import { storePath } from '@/lib/slug';
import ProductCard from '@/components/ProductCard';
import ProductImage from '@/components/ProductImage';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { CATEGORIES, SUBCATEGORIES, stockedCategories } from '@/lib/data';
import { useClaimProduct } from '@/lib/useClaimProduct';
import { useIncrementalList } from '@/lib/useIncrementalList';
import { recordInterest } from '@/lib/affinity';
import { useLiveLocation } from '@/lib/useLiveLocation';
import { formatDistance, distanceKm } from '@/lib/geo';
import { districtFor, MOGADISHU_DISTRICTS } from '@/lib/districts';
import StoreAvatar from '@/components/StoreAvatar';
import type { Product } from '@/lib/types';

/** One product offered by one specific store (original uploader OR a store that claimed it). */
interface NearbyOffer {
  productId: number;
  name:      string;
  price:     number;
  imageUrl:  string | null;
  imageUrls: string[];
  stock:     number;
  claimed:   boolean;
  store: {
    id:         number;
    name:       string;
    slug:       string | null;
    icon:       string;
    location:   string | null;
    distanceKm: number | null;
  };
}

const BarcodeScanner = lazy(() => import('@/components/BarcodeScanner'));

/* ── Product Claim Modal ──────────────────────────────────────────────────── */
interface ClaimModalProps {
  product:    Product;
  supplierId: number;
  onClose:    () => void;
  onClaimed:  () => void;
}

function ClaimModal({ product, supplierId, onClose, onClaimed }: ClaimModalProps) {
  const { toast }                 = useApp();
  const [price,    setPrice]      = useState(String(product.price));
  const [stockQty, setStockQty]   = useState('10');
  const [saving,   setSaving]     = useState(false);

  async function handleClaim() {
    const p = parseFloat(price);
    if (!p || p <= 0) { toast('Enter a valid price', 'error'); return; }
    setSaving(true);
    try {
      // Copies the catalog row into a NEW product owned by this store, at the
      // price/stock entered here — so the listing is truly the store's own.
      const res = await fetch('/api/products/copy', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          supplierId,
          productId: product.id,
          price:     p,
          stock:     parseInt(stockQty) || 0,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        toast(
          data?.alreadyCopied
            ? `"${product.name}" is already in your store`
            : `✅ "${product.name}" added to your store!`,
          data?.alreadyCopied ? 'default' : 'success',
        );
        onClaimed();
        onClose();
      } else {
        toast(data?.error ?? 'Failed to add product', 'error');
      }
    } catch {
      toast('Network error', 'error');
    }
    setSaving(false);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>🛒 Add to Your Store</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">

          {/* Product preview */}
          <div className="claim-product-card">
            <div className="claim-product-icon" style={{ width:48, height:48, borderRadius:8, overflow:'hidden' }}>
              <ProductImage imageUrl={product.imageUrl} imageUrls={product.imageUrls} name={product.name} />
            </div>
            <div className="claim-product-info">
              <div className="claim-product-name">{product.name}</div>
              {product.brand && (
                <div className="claim-product-brand">{product.brand}</div>
              )}
              <div className="claim-product-meta">
                {CATEGORIES.find(c => c.id === product.category)?.icon}{' '}
                {CATEGORIES.find(c => c.id === product.category)?.name}
                {product.subCategory && (
                  <span> &rsaquo; {SUBCATEGORIES[product.category]?.find(s => s.id === product.subCategory)?.name}</span>
                )}
              </div>
              {product.barcode && (
                <div className="claim-product-barcode">🔢 {product.barcode}</div>
              )}
              {product.tags && product.tags.length > 0 && (
                <div className="claim-tags-row">
                  {product.tags.slice(0, 4).map(t => (
                    <span key={t} className="claim-tag">{t}</span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="claim-price-row">
            <div style={{ fontSize: '.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>
              Global catalog price: <strong>${product.price.toFixed(2)}</strong>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group">
              <label className="form-label">Your Selling Price ($) *</label>
              <input
                className="form-input"
                type="number" min="0" step="0.01"
                value={price}
                onChange={e => setPrice(e.target.value)}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label className="form-label">Your Stock Qty</label>
              <input
                className="form-input"
                type="number" min="0"
                value={stockQty}
                onChange={e => setStockQty(e.target.value)}
              />
            </div>
          </div>

          <button
            className="btn btn-primary btn-full btn-lg"
            onClick={handleClaim}
            disabled={saving}
            style={{ marginTop: 8 }}
          >
            {saving
              ? <><span className="btn-spinner" /> Adding…</>
              : '✓ Add to My Store'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Barcode result card ──────────────────────────────────────────────────── */
interface BarcodeResultProps {
  product:    Product | null;
  barcode:    string;
  onClaim:    (p: Product) => void;
  onAddCart:  (p: Product) => void;
  onDismiss:  () => void;
  isBusiness: boolean;
}

function BarcodeResult({ product, barcode, onClaim, onAddCart, onDismiss, isBusiness }: BarcodeResultProps) {
  if (!product) {
    return (
      <div className="barcode-result not-found">
        <div className="barcode-result-icon">❓</div>
        <div>
          <div className="barcode-result-title">Product not found</div>
          <div className="barcode-result-sub">Barcode: <strong>{barcode}</strong> is not in the database yet.</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onDismiss}>✕</button>
      </div>
    );
  }

  return (
    <div className="barcode-result found">
      <div className="barcode-result-icon" style={{ width:44, height:44, borderRadius:8, overflow:'hidden' }}>
        <ProductImage imageUrl={product.imageUrl} imageUrls={product.imageUrls} name={product.name} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="barcode-result-title">{product.name}</div>
        {product.brand && <div className="barcode-result-brand">{product.brand}</div>}
        <div className="barcode-result-price">${product.price.toFixed(2)}</div>
        {product.tags && product.tags.length > 0 && (
          <div className="claim-tags-row" style={{ marginTop: 4 }}>
            {product.tags.slice(0, 3).map(t => <span key={t} className="claim-tag">{t}</span>)}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        {isBusiness ? (
          <button className="btn btn-primary btn-sm" onClick={() => onClaim(product)}>
            + Add to Store
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={() => onAddCart(product)}>
            🛒 Add to Cart
          </button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={onDismiss}>✕</button>
      </div>
    </div>
  );
}

/* ── Search inner ─────────────────────────────────────────────────────────── */
function SearchInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const { state, addToCart, toggleWishlist } = useApp();
  const { user, accountType, currentSupplier } = useAuth();
  const { products, loading }  = state;
  const { canClaim, claim, isMine, claimingId } = useClaimProduct();

  const wishlistSet  = useMemo(() => new Set(state.wishlist),    [state.wishlist]);
  const inventoryMap = useMemo(() =>
    new Map(state.inventory.map(i => [i.id, i.stock])),
  [state.inventory]);

  // Store GPS → recognised district label for the result cards
  const districtBySupplier = useMemo(() =>
    new Map(state.suppliers.map(s =>
      [s.id, districtFor(s.latitude, s.longitude) ?? (s.location || null)])),
  [state.suppliers]);

  const onlineBySupplier = useMemo(() =>
    new Map(state.suppliers.map(s => [s.id, !!s.onlineOnly])),
  [state.suppliers]);

  // Store name + verified flag per supplier → shown on each product card + offer row.
  const nameBySupplier = useMemo(() =>
    new Map(state.suppliers.map(s => [s.id, s.name])),
  [state.suppliers]);
  const verifiedBySupplier = useMemo(() =>
    new Map(state.suppliers.map(s => [s.id, !!s.verified])),
  [state.suppliers]);

  // Recognised district per store (GPS only) → powers the district filter.
  const recognizedDistrictBySupplier = useMemo(() =>
    new Map(state.suppliers.map(s => [s.id, districtFor(s.latitude, s.longitude)])),
  [state.suppliers]);

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

  const [query,           setQuery]           = useState(searchParams.get('q') ?? '');
  const [activeCategory,  setActiveCategory]  = useState('all');
  const [activeSubCat,    setActiveSubCat]    = useState('all');
  const [activeDistrict,  setActiveDistrict]  = useState('all');
  const [showScanner,     setShowScanner]     = useState(false);
  const [scanLoading,     setScanLoading]     = useState(false);
  const [scannedBarcode,  setScannedBarcode]  = useState('');
  const [scannedProduct,  setScannedProduct]  = useState<Product | null | 'none'>('none');
  const [claimProduct,    setClaimProduct]    = useState<Product | null>(null);

  useEffect(() => {
    setQuery(searchParams.get('q') ?? '');
  }, [searchParams]);

  const subCats = activeCategory !== 'all' ? (SUBCATEGORIES[activeCategory] ?? []) : [];

  /**
   * Only chip categories that have something to find, so a tap can never land
   * on an empty result set.
   *
   * Unlike Explore, this deliberately IGNORES the admin's Hidden tier: Hidden
   * means "out of Explore discovery", and a hidden product must stay findable
   * by search. Filtering it out here would make its whole category unreachable.
   */
  const availableCategories = useMemo(() =>
    stockedCategories(products.filter(p =>
      !p.isB2b || accountType === 'business' || accountType === 'supplier')),
  [products, accountType]);

  useEffect(() => {
    if (activeCategory !== 'all' && !availableCategories.some(c => c.id === activeCategory)) {
      setActiveCategory('all');
      setActiveSubCat('all');
    }
  }, [availableCategories, activeCategory]);

  const filtered = useMemo(() => {
    let list = products;
    if (activeCategory !== 'all') list = list.filter(p => p.category === activeCategory);
    if (activeSubCat  !== 'all') list = list.filter(p => p.subCategory === activeSubCat);
    if (activeDistrict !== 'all') list = list.filter(p =>
      p.supplierId != null && recognizedDistrictBySupplier.get(p.supplierId) === activeDistrict);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(p =>
        p.name.toLowerCase().includes(q)         ||
        p.description.toLowerCase().includes(q)  ||
        p.category.toLowerCase().includes(q)     ||
        p.sku.toLowerCase().includes(q)           ||
        (p.brand ?? '').toLowerCase().includes(q) ||
        (p.tags ?? []).some(t => t.toLowerCase().includes(q))
      );
    }
    return list;
  }, [products, query, activeCategory, activeSubCat, activeDistrict, recognizedDistrictBySupplier]);

  // Render the grid in slices — mounting all 600+ cards at once froze first paint
  const { visible, hasMore, sentinelRef } =
    useIncrementalList(filtered, `${query}|${activeCategory}|${activeSubCat}|${activeDistrict}`);

  /* ── Learn from searches ────────────────────────────────────────────────
     A search is the clearest statement of intent we get ("laptop" → electronics
     /laptops), so record the dominant category of the matches; Explore later
     blends ~30% of its grid toward it. Debounced, so typing "laptop" logs one
     signal rather than one per keystroke. */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || filtered.length === 0) return;
    const t = setTimeout(() => {
      const top = filtered.slice(0, 12);
      const commonest = (vals: (string | null | undefined)[]) => {
        const tally = new Map<string, number>();
        for (const v of vals) if (v) tally.set(v, (tally.get(v) ?? 0) + 1);
        return Array.from(tally.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      };
      const cat = commonest(top.map(p => p.category));
      if (!cat) return;
      const sub = commonest(top.filter(p => p.category === cat).map(p => p.subCategory));
      recordInterest(cat, sub, 'search');
    }, 1000);
    return () => clearTimeout(t);
  }, [query, filtered]);

  /* ── Nearby offers: live location + distance-ranked stores ──────────────
     Every store selling a matching product (uploader AND claimers) becomes a
     result; the server returns the best match from each of the 10 closest
     stores. watchPosition keeps `pos` live, so results re-rank as the user
     moves. The location watch only starts once they actually search. */
  const searching = query.trim().length >= 2;
  const { pos, status: locStatus } = useLiveLocation(searching);
  const [offers, setOffers]               = useState<NearbyOffer[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  // ~110 m buckets — refetch on real movement, not GPS jitter
  const posKey = pos ? `${pos.lat.toFixed(3)},${pos.lng.toFixed(3)}` : '';

  useEffect(() => {
    if (!searching) { setOffers([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setOffersLoading(true);
      try {
        const params = new URLSearchParams({ q: query.trim() });
        const [lat, lng] = posKey ? posKey.split(',') : [];
        if (lat && lng) { params.set('lat', lat); params.set('lng', lng); }
        const res  = await fetch(`/api/search/offers?${params}`, { signal: ctrl.signal });
        const data = await res.json();
        setOffers(Array.isArray(data?.offers) ? data.offers : []);
      } catch { /* aborted or offline — keep previous results */ }
      setOffersLoading(false);
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query, posKey, searching]);

  const openOffer = (o: NearbyOffer) => {
    router.push(o.store.slug ? `/${o.store.slug}/${o.productId}` : `/product/${o.productId}`);
  };

  /* ── Stores whose NAME matches the search — shown above product results
     so searching "techzone" finds the store itself, not just its items. ── */
  const matchingStores = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return state.suppliers
      .filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.slug ?? '').includes(q.replace(/\s+/g, '-')))
      .map(s => ({
        ...s,
        distKm: pos && s.latitude != null && s.longitude != null
          ? distanceKm(pos.lat, pos.lng, s.latitude, s.longitude)
          : null,
      }))
      .sort((a, b) => (a.distKm ?? Infinity) - (b.distKm ?? Infinity) || b.rating - a.rating)
      .slice(0, 5);
  }, [state.suppliers, query, pos]);

  /* ── Barcode detected callback ─── */
  async function handleBarcode(code: string) {
    setScannedBarcode(code);
    setScannedProduct(null); // loading
    setScanLoading(true);
    try {
      const res = await fetch(`/api/products?barcode=${encodeURIComponent(code)}`);
      if (res.ok) {
        const data = await res.json();
        setScannedProduct(data ?? 'none');
      } else {
        setScannedProduct('none');
      }
    } catch {
      setScannedProduct('none');
    }
    setScanLoading(false);
  }

  const isBusiness = accountType === 'business' && !!currentSupplier;

  return (
    <div className="page-anim">
      {/* ── Search bar ── */}
      <div className="search-page-header">
        <button className="search-back-btn" onClick={() => router.back()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
        </button>
        <input
          className="search-page-input"
          placeholder="Search by name, brand, tag…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
        {query && (
          <button className="search-clear-btn" onClick={() => setQuery('')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
        {/* Barcode scan button */}
        <button
          className="search-scan-btn"
          onClick={() => setShowScanner(true)}
          title="Scan barcode"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="3"  width="4" height="4" rx=".5"/>
            <rect x="17" y="3" width="4" height="4" rx=".5"/>
            <rect x="3" y="17" width="4" height="4" rx=".5"/>
            <line x1="7"  y1="5"  x2="17" y2="5"/>
            <line x1="7"  y1="19" x2="13" y2="19"/>
            <line x1="19" y1="7"  x2="19" y2="13"/>
            <line x1="5"  y1="7"  x2="5"  y2="17"/>
            <line x1="17" y1="9"  x2="17" y2="17"/>
            <line x1="9"  y1="17" x2="9"  y2="21"/>
            <line x1="13" y1="13" x2="13" y2="17"/>
            <line x1="13" y1="9"  x2="21" y2="9"/>
          </svg>
        </button>
      </div>

      {/* ── Barcode scan result ── */}
      {(scannedBarcode || scanLoading) && (
        <div style={{ padding: '8px 16px' }}>
          {scanLoading ? (
            <div className="barcode-result loading">
              <span className="btn-spinner" style={{ flexShrink: 0 }} /> Looking up barcode <strong>{scannedBarcode}</strong>…
            </div>
          ) : (
            <BarcodeResult
              product={scannedProduct === 'none' ? null : scannedProduct}
              barcode={scannedBarcode}
              isBusiness={isBusiness}
              onClaim={p => setClaimProduct(p)}
              onAddCart={p => { addToCart(p.id); setScannedBarcode(''); setScannedProduct('none'); }}
              onDismiss={() => { setScannedBarcode(''); setScannedProduct('none'); }}
            />
          )}
        </div>
      )}

      {/* ── District filter ── */}
      {availableDistricts.length > 0 && (
        <div className="district-filter" style={{ background: 'var(--surface)' }}>
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
      )}

      {/* ── Category chips ── */}
      <div className="chips-row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        <button className={`chip ${activeCategory === 'all' ? 'active' : ''}`} onClick={() => { setActiveCategory('all'); setActiveSubCat('all'); }}>All</button>
        {availableCategories.map(cat => (
          <button
            key={cat.id}
            className={`chip ${activeCategory === cat.id ? 'active' : ''}`}
            onClick={() => { setActiveCategory(cat.id); setActiveSubCat('all'); }}
          >
            {cat.icon} {cat.name}
          </button>
        ))}
      </div>

      {/* ── Subcategory chips (shown when category selected) ── */}
      {subCats.length > 0 && (
        <div className="chips-row" style={{ padding: '6px 16px', background: 'var(--bg)' }}>
          <button className={`chip chip-sm ${activeSubCat === 'all' ? 'active' : ''}`} onClick={() => setActiveSubCat('all')}>All</button>
          {subCats.map(s => (
            <button
              key={s.id}
              className={`chip chip-sm ${activeSubCat === s.id ? 'active' : ''}`}
              onClick={() => setActiveSubCat(s.id)}
            >
              {s.icon} {s.name}
            </button>
          ))}
        </div>
      )}

      {/* ── Results count ── */}
      {!loading && (query || activeCategory !== 'all' || activeDistrict !== 'all') && (
        <div className="search-results-count">
          {filtered.length === 0
            ? 'No results'
            : `${filtered.length} result${filtered.length !== 1 ? 's' : ''}${query ? ` for "${query}"` : ''}${activeDistrict !== 'all' ? ` · 📍 ${activeDistrict}` : ''}`}
        </div>
      )}

      {/* ── Stores matching the search by NAME ── */}
      {searching && matchingStores.length > 0 && (
        <div style={{ padding: '0 16px 4px' }}>
          <div className="section-header" style={{ padding: '4px 0 10px' }}>
            <span className="section-title">🏪 Stores</span>
          </div>
          {matchingStores.map(s => (
            <div
              key={s.id}
              onClick={() => router.push(storePath(s))}
              style={{
                display: 'flex', gap: 12, alignItems: 'center',
                padding: '10px 12px', marginBottom: 8, cursor: 'pointer',
                background: 'var(--card, #fff)', borderRadius: 12,
                border: '1px solid var(--border, #ececf1)',
              }}
            >
              <div style={{
                width: 44, height: 44, flexShrink: 0, borderRadius: 10, overflow: 'hidden',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--surface, #f6f7fb)', fontSize: 22,
              }}>
                <StoreAvatar value={s.icon} alt={s.name} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.name} {s.verified && <span title="Verified" style={{ color: 'var(--primary, #4F46E5)' }}>✔</span>}
                </div>
                <div className="text-muted text-sm" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {onlineBySupplier.get(s.id)
                    ? <span style={{ color: 'var(--primary, #4F46E5)', fontWeight: 700 }}>🌐 Online store</span>
                    : (districtBySupplier.get(s.id) ?? 'Store')}
                  {!onlineBySupplier.get(s.id) && s.distKm != null && <span style={{ fontWeight: 700, color: 'var(--primary, #4F46E5)' }}> · {formatDistance(s.distKm)}</span>}
                  {s.slug && <span> · /{s.slug}</span>}
                </div>
              </div>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>›</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Closest stores selling a match (uploader + claimed copies) ── */}
      {searching && (offers.length > 0 || offersLoading) && (
        <div style={{ padding: '0 16px 4px' }}>
          <div className="section-header" style={{ padding: '4px 0 10px' }}>
            <span className="section-title">
              📍 {locStatus === 'live' ? 'Closest stores' : 'Stores selling this'}
            </span>
            <span className="text-muted text-sm">
              {locStatus === 'live'      ? 'ranked by distance'
                : locStatus === 'denied' ? 'allow location for distances'
                : locStatus === 'locating' ? 'finding you…' : ''}
            </span>
          </div>

          {offers.map(o => (
            <div
              key={`${o.store.id}-${o.productId}`}
              onClick={() => openOffer(o)}
              style={{
                display: 'flex', gap: 12, alignItems: 'center',
                padding: '10px 12px', marginBottom: 8, cursor: 'pointer',
                background: 'var(--card, #fff)', borderRadius: 12,
                border: '1px solid var(--border, #ececf1)',
              }}
            >
              <div style={{ width: 52, height: 52, flexShrink: 0, borderRadius: 10, overflow: 'hidden' }}>
                <ProductImage imageUrl={o.imageUrl} imageUrls={o.imageUrls} name={o.name} style={{ borderRadius: 10 }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {o.name}
                </div>
                <div className="text-muted text-sm" style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ width: 16, height: 16, flexShrink: 0, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    <StoreAvatar value={o.store.icon} alt={o.store.name} />
                  </span>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.store.name}</span>
                  {verifiedBySupplier.get(o.store.id) && (
                    <span title="Verified store" style={{ color: 'var(--primary, #4F46E5)', flexShrink: 0 }}>✓</span>
                  )}
                  {o.claimed && (
                    <span style={{ flexShrink: 0, fontSize: '.64rem', fontWeight: 800, color: 'var(--primary, #4F46E5)', background: 'var(--primary-light, #eef2ff)', padding: '1px 6px', borderRadius: 99 }}>copy</span>
                  )}
                  {o.store.location && (
                    <span style={{ flexShrink: 0 }}>· {o.store.location}</span>
                  )}
                  {o.store.distanceKm != null && (
                    <span style={{ flexShrink: 0, fontWeight: 700, color: 'var(--primary, #4F46E5)' }}>
                      · {formatDistance(o.store.distanceKm)}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ fontWeight: 800, flexShrink: 0 }}>${Number(o.price).toFixed(2)}</div>
            </div>
          ))}

          {offersLoading && offers.length === 0 && (
            <div className="empty-state" style={{ padding: 16 }}>
              <div className="spinner" style={{ width: 20, height: 20 }} />
            </div>
          )}
        </div>
      )}

      {/* ── Products grid ── */}
      {loading ? (
        <div className="product-grid" style={{ padding: '12px 16px' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="product-card skeleton-card">
              <div className="skeleton" style={{ height: 110, borderRadius: 12 }} />
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="skeleton" style={{ height: 13, width: '80%', borderRadius: 4 }} />
                <div className="skeleton" style={{ height: 11, width: '50%', borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 60 }}>
          <div className="empty-icon">🔍</div>
          <div className="empty-title">No products found</div>
          <div className="empty-sub">
            {query ? `Try a different search term` : 'No products in this category'}
          </div>
          {user && isBusiness && (
            <button
              className="btn btn-primary"
              style={{ marginTop: 16 }}
              onClick={() => setShowScanner(true)}
            >
              📷 Scan Barcode to Add
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="product-grid" style={{ padding: '12px 16px' }}>
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
          {hasMore && (
            <div ref={sentinelRef} className="empty-state" style={{ padding: 24 }}>
              <div className="spinner" style={{ width: 22, height: 22 }} />
            </div>
          )}
        </>
      )}

      {/* ── Barcode Scanner Modal ── */}
      {showScanner && (
        <Suspense fallback={null}>
          <BarcodeScanner
            onDetected={code => { setShowScanner(false); handleBarcode(code); }}
            onClose={() => setShowScanner(false)}
          />
        </Suspense>
      )}

      {/* ── Product Claim Modal ── */}
      {claimProduct && isBusiness && (
        <ClaimModal
          product={claimProduct}
          supplierId={currentSupplier!.id}
          onClose={() => setClaimProduct(null)}
          onClaimed={() => { setScannedBarcode(''); setScannedProduct('none'); }}
        />
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="page-anim" style={{ padding: 40, textAlign: 'center' }}>Loading…</div>}>
      <SearchInner />
    </Suspense>
  );
}
