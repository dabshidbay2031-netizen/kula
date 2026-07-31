'use client';

import { memo, useState, useRef } from 'react';
import { useRouter } from '@/lib/hashRouter';
import { getCategoryColor, hexToRgba, discountPct } from '@/lib/data';
import { reliableImageSrc } from '@/lib/imageFallback';
import type { Product } from '@/lib/types';

interface Props {
  product:          Product;
  isWishlisted:     boolean;
  stock:            number;
  /** Stable reference — pass addToCart from useApp() directly */
  onAddToCart:      (id: number) => void;
  /** Stable reference — pass toggleWishlist from useApp() directly */
  onToggleWishlist: (id: number) => void;
  /** When true (a business browsing the catalog) the primary action becomes
   *  "Add to Store" (claim) instead of "Add to Cart". */
  canClaim?:        boolean;
  /** This product is already in the store (owned or claimed). */
  isClaimed?:       boolean;
  /** A claim request for this product is in flight. */
  claiming?:        boolean;
  /** Stable reference — one-click claim from useClaimProduct(). */
  onClaim?:         (id: number) => void;
  /** Human-readable store area (district recognised from the store's GPS). */
  storeDistrict?:   string | null;
  /** The selling store is internet-only — show "🌐 Online store" not a district. */
  storeOnlineOnly?: boolean;
  /** The name of the store selling this product — shown on the card. */
  storeName?:       string | null;
  /** The selling store is admin-verified — show a ✓ next to its name. */
  storeVerified?:   boolean;
}

/**
 * Memoised: only re-renders when product data, wishlist status, or stock
 * changes for THIS specific product. Decoupled from AppContext so the
 * parent's re-renders don't cascade into 30+ card re-renders.
 */
function ProductCard({
  product, isWishlisted, stock, onAddToCart, onToggleWishlist,
  canClaim = false, isClaimed = false, claiming = false, onClaim,
  storeDistrict = null, storeOnlineOnly = false,
  storeName = null, storeVerified = false,
}: Props) {
  const router  = useRouter();
  const color   = getCategoryColor(product.category);
  const bgStyle = { background: hexToRgba(color, 0.12) };
  const pct     = discountPct(product.price, product.originalPrice);

  const allPhotos = (product.imageUrls?.length ? product.imageUrls
                  : product.imageUrl          ? [product.imageUrl]
                  : []).map(u => reliableImageSrc(u) ?? u);
  // A broken/unreachable photo URL (404, timeout…) otherwise renders as raw
  // alt TEXT instead of falling back to the placeholder icon. Track failures
  // per-slide (by original index) and drop them from the carousel.
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const photos = allPhotos
    .map((url, origIdx) => ({ url, origIdx }))
    .filter(p => !failed.has(p.origIdx));
  const multi = photos.length > 1;
  const [idx, setIdx] = useState(0);
  if (idx >= photos.length && photos.length > 0) setIdx(0);

  const swipeX   = useRef<number | null>(null);
  const didSwipe = useRef(false);

  const prev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIdx(i => (i - 1 + photos.length) % photos.length);
  };
  const next = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIdx(i => (i + 1) % photos.length);
  };

  const onTouchStart = (e: React.TouchEvent) => {
    swipeX.current  = e.touches[0].clientX;
    didSwipe.current = false;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (swipeX.current === null) return;
    const dx = e.changedTouches[0].clientX - swipeX.current;
    swipeX.current = null;
    if (Math.abs(dx) < 25) return;
    didSwipe.current = true;
    if (dx < 0) setIdx(i => (i + 1) % photos.length);
    else        setIdx(i => (i - 1 + photos.length) % photos.length);
  };

  return (
    <div
      className="product-card"
      onClick={() => { if (!didSwipe.current) router.push(`/product/${product.id}`); didSwipe.current = false; }}
    >
      <div className="product-img" style={bgStyle}>
        {pct > 0 && <span className="discount-tag">-{pct}%</span>}
        <button
          className={`wishlist-btn ${isWishlisted ? 'liked' : ''}`}
          aria-label={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
          onClick={e => { e.stopPropagation(); onToggleWishlist(product.id); }}
        >
          <svg viewBox="0 0 24 24" fill={isWishlisted ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </button>

        {photos.length > 0 ? (
          <div
            className="card-carousel"
            onTouchStart={multi ? onTouchStart : undefined}
            onTouchEnd={multi ? onTouchEnd : undefined}
          >
            <div className="card-carousel-track" style={{ transform: `translateX(-${idx * 100}%)` }}>
              {photos.map(({ url, origIdx }, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={origIdx} src={url} alt={`${product.name} ${i + 1}`} className="card-slide-img"
                  loading="lazy" decoding="async"
                  onError={() => setFailed(s => new Set(s).add(origIdx))} />
              ))}
            </div>
            {multi && (
              <>
                <button className="card-carousel-btn card-carousel-prev" onClick={prev} aria-label="Previous photo">‹</button>
                <button className="card-carousel-btn card-carousel-next" onClick={next} aria-label="Next photo">›</button>
                <div className="card-carousel-dots">
                  {photos.map((_, i) => (
                    <span key={i} className={`card-carousel-dot${i === idx ? ' active' : ''}`} />
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".25">
            <rect x="4" y="4" width="40" height="40" rx="6"/>
            <path d="M4 34l10-10 8 8 8-12 14 16"/>
            <circle cx="16" cy="16" r="4"/>
          </svg>
        )}
      </div>

      <div className="product-body">
        <div className="product-name">{product.name}</div>
        {storeName && (
          <div
            style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 3 }}
          >
            {/* The badge leads the name: it qualifies the store, so it has to be
                read BEFORE it. Trailing it also risked being the first thing cut
                by the ellipsis on a long store name — the shopper would lose
                exactly the signal that says this seller is trustworthy. */}
            {storeVerified
              ? <span title="Verified store" aria-label="Verified store"
                      style={{ color: 'var(--primary)', flexShrink: 0, fontSize: '.82rem' }}>✅</span>
              : <span aria-hidden="true" style={{ flexShrink: 0 }}>🏪</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{storeName}</span>
          </div>
        )}
        {storeOnlineOnly ? (
          <div
            style={{ fontSize: '.72rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--primary)' }}
          >
            🌐 Online store
          </div>
        ) : storeDistrict && (
          <div
            className="text-muted"
            style={{ fontSize: '.72rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            📍 {storeDistrict}
          </div>
        )}
        <div className="product-rating">
          <span className="star">★</span>
          {product.rating} ({product.reviews})
        </div>
        <div className="product-price">
          <span className="price-current">${product.price.toFixed(2)}</span>
          {product.originalPrice > product.price && (
            <span className="price-original">${product.originalPrice.toFixed(2)}</span>
          )}
          {product.taxMode === 'included' && (
            <span className="tax-badge tax-included">VAT incl.</span>
          )}
          {product.taxMode === 'excluded' && (
            <span className="tax-badge tax-excluded">+5% VAT</span>
          )}
        </div>
        {canClaim ? (
          <button
            className={`product-add-btn${isClaimed ? ' product-add-btn-done' : ''}`}
            onClick={e => { e.stopPropagation(); if (!isClaimed && !claiming) onClaim?.(product.id); }}
            disabled={isClaimed || claiming}
          >
            {isClaimed ? '✓ In your store' : claiming ? 'Adding…' : '➕ Add to Store'}
          </button>
        ) : (
          <button
            className="product-add-btn"
            onClick={e => { e.stopPropagation(); onAddToCart(product.id); }}
            disabled={stock === 0}
          >
            {stock === 0 ? 'Out of stock' : '+ Add to Cart'}
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(ProductCard);
