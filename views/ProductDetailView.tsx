'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from '@/lib/hashRouter';
import { storePath } from '@/lib/slug';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { authHeaders } from '@/lib/clientAuth';
import { getCategoryColor, hexToRgba, discountPct, SUBCATEGORIES } from '@/lib/data';
import { CATEGORIES } from '@/lib/data';
import ProductImage from '@/components/ProductImage';
import { reliableImageSrc } from '@/lib/imageFallback';
import { useClaimProduct } from '@/lib/useClaimProduct';
import { similarProducts } from '@/lib/similarity';
import { normalizeTiers, tierForQty, unitPriceFor, tierSavingPerUnit, tierRangeLabel } from '@/lib/tierPricing';
import { recordInterest } from '@/lib/affinity';

interface Review {
  id: number; userId: string; rating: number;
  comment: string | null; userName: string; userAvatar: string; createdAt: string;
}

export default function ProductDetailPage() {
  // Reached two ways: '/product/:id' and the storefront URL
  // '/:slug/:productId' (e.g. /city-care-pharmacy/123).
  const params = useParams<{ id?: string; productId?: string; slug?: string }>();
  const router = useRouter();
  const { state, addToCart, toggleWishlist, getStock, reloadProducts } = useApp();
  const { user, currentSupplier } = useAuth();
  const { canClaim, claim, isMine, claimingId } = useClaimProduct();
  const { products, suppliers } = state;
  const [qty,        setQty]        = useState(1);
  const [photoIdx,   setPhotoIdx]   = useState(0);
  const [lightbox,   setLightbox]   = useState(false);
  // A broken/unreachable photo URL (404, timeout…) otherwise renders as raw alt
  // TEXT — track failures and drop that slide everywhere (main, thumbs, lightbox).
  const [failedPhotos, setFailedPhotos] = useState<Set<string>>(new Set());

  const swipeX   = useRef<number | null>(null);
  const swipeY   = useRef<number | null>(null);
  const didSwipe = useRef(false);

  // Reviews state
  const [reviews,       setReviews]       = useState<Review[]>([]);
  const [myRating,      setMyRating]      = useState(0);
  const [myComment,     setMyComment]     = useState('');
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  // Latest 2 shown first; "Show more" reveals 3 more per tap.
  const [visibleReviews, setVisibleReviews] = useState(2);
  // "You reviewed this product" flashes briefly after submitting, then goes away.
  const [justReviewed,  setJustReviewed]  = useState(false);

  const productId = parseInt(params.id ?? params.productId ?? '', 10);
  const product   = products.find(p => p.id === productId);

  // Viewing a product is a softer interest signal than searching for one, but
  // it still steers what Explore surfaces later.
  useEffect(() => {
    if (product?.category) recordInterest(product.category, product.subCategory, 'view');
  }, [product?.id, product?.category, product?.subCategory]);

  // Storefront context: reached via '/:slug/:productId' — reviews written here
  // credit THAT store (a claimed product credits the claiming store, not the
  // wholesaler who owns the catalog row).
  const storefrontStore = params.slug
    ? suppliers.find(s => s.slug === params.slug!.toLowerCase()) ?? null
    : null;

  // Load reviews on mount
  useEffect(() => {
    if (!productId) return;
    fetch(`/api/reviews?productId=${productId}`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) { setReviews(data); setReviewsLoaded(true); } })
      .catch(() => setReviewsLoaded(true));
  }, [productId]);

  const myExistingReview = reviews.find(r => r.userId === user?.id);

  const submitReview = async () => {
    if (!user || !myRating) return;
    setReviewLoading(true);
    const res = await fetch('/api/reviews', {
      method:  'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify({
        productId, userId: user.id,
        rating:     myRating,
        comment:    myComment.trim() || null,
        userName:   user.displayName ?? (user.email?.split('@')[0] ?? 'User'),
        userAvatar: '👤',
        // The store this review credits (storefront page → that store;
        // plain product page → the catalog owner).
        supplierId: storefrontStore?.id ?? product?.supplierId ?? null,
      }),
    });
    if (res.ok) {
      const saved = await res.json();
      setReviews(prev => {
        const filtered = prev.filter(r => r.userId !== user.id);
        return [saved, ...filtered];
      });
      setMyRating(0); setMyComment('');
      // Confirmation badge shows briefly, then disappears on its own.
      setJustReviewed(true);
      setTimeout(() => setJustReviewed(false), 4000);
      // The server just recalculated this product's average rating/count —
      // refresh now instead of waiting for the next ~15s live-poll, so the
      // star rating shown on THIS page updates immediately.
      reloadProducts().catch(() => {});
    }
    setReviewLoading(false);
  };

  /** Back, with a fallback: a page opened directly (scanned QR, shared link)
   *  has no history to go back to — go to the shop home instead. */
  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back();
    else router.push('/');
  };

  /* ── Loading skeleton ─── */
  if (state.loading) {
    return (
      <div className="page-anim detail-wrap">
        <div className="detail-img-wrap" style={{ background: 'var(--border-light)', height: 300 }}>
          <div className="skeleton" style={{ width: 112, height: 112, borderRadius: 16, margin: 'auto' }} />
        </div>
        <div className="detail-body">
          <div className="skeleton" style={{ height: 12, width: '30%', borderRadius: 6, marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 22, width: '80%', borderRadius: 6, marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 14, width: '50%', borderRadius: 6, marginBottom: 16 }} />
          <div className="skeleton" style={{ height: 80, borderRadius: 8, marginBottom: 16 }} />
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="skeleton" style={{ flex: 1, height: 48, borderRadius: 8 }} />
            <div className="skeleton" style={{ flex: 1, height: 48, borderRadius: 8 }} />
          </div>
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="empty-state" style={{ marginTop: 80 }}>
        <div className="empty-icon">🔍</div>
        <div className="empty-title">Product not found</div>
        <button className="btn btn-primary" onClick={() => router.push('/')}>Go Home</button>
      </div>
    );
  }

  const stock        = getStock(product.id);
  // A seller can't buy from their own store.
  const isOwnProduct = currentSupplier != null && product.supplierId === currentSupplier.id;
  const isWishlisted = state.wishlist.includes(product.id);
  const supplier     = suppliers.find(s => s.id === product.supplierId);

  /* Wholesale bulk pricing — the unit price depends on the quantity chosen,
     so these recompute as the buyer changes it. The server re-derives the same
     price at checkout (see /api/orders); this is what the buyer is shown. */
  const tiers        = normalizeTiers(product.priceTiers);
  const activeTier   = tierForQty(tiers, qty);
  const tierUnitPrice = unitPriceFor(product.price, tiers, qty);
  const tierSaving   = tierSavingPerUnit(product.price, tiers, qty);
  // Ranked by shared tags > shared name words > subcategory > brand > category.
  // Shows as many genuinely-related items as possible (same category + shared
  // tags rank highest), capped generously for the "You may also like" shelf.
  const similar      = similarProducts(product, products, 20);
  const color        = getCategoryColor(product.category);
  const bgStyle      = { background: `linear-gradient(135deg, ${hexToRgba(color, 0.12)}, ${hexToRgba(color, 0.06)})` };
  const pct          = discountPct(product.price, product.originalPrice);
  const photos       = (product.imageUrls?.length ? product.imageUrls
                     : product.imageUrl          ? [product.imageUrl]
                     : []).map(u => reliableImageSrc(u) ?? u).filter(url => !failedPhotos.has(url));
  const hasPhotos    = photos.length > 0;
  const markFailed   = (url: string) => setFailedPhotos(s => new Set(s).add(url));
  if (photoIdx >= photos.length && photos.length > 0) setPhotoIdx(0);
  const cat          = CATEGORIES.find(c => c.id === product.category);
  const subCat       = product.subCategory
    ? SUBCATEGORIES[product.category]?.find(s => s.id === product.subCategory)
    : null;

  const onSwipeStart = (e: React.TouchEvent) => {
    swipeX.current   = e.touches[0].clientX;
    swipeY.current   = e.touches[0].clientY;
    didSwipe.current = false;
  };
  const onSwipeEnd = (e: React.TouchEvent) => {
    if (swipeX.current === null) return;
    const dx = e.changedTouches[0].clientX - swipeX.current;
    const dy = e.changedTouches[0].clientY - (swipeY.current ?? 0);
    swipeX.current = null;
    swipeY.current = null;
    if (Math.abs(dx) < 30 || Math.abs(dy) > Math.abs(dx)) return;
    didSwipe.current = true;
    if (dx < 0) setPhotoIdx(i => (i + 1) % photos.length);
    else        setPhotoIdx(i => (i - 1 + photos.length) % photos.length);
  };

  return (
    <div className="page-anim detail-wrap">

      {/* ── Hero: photo gallery OR emoji ─── */}
      {hasPhotos ? (
        <div className="detail-gallery-wrap">
          {/* Back + wishlist */}
          <button className="detail-back" onClick={goBack} aria-label="Go back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
          </button>
          <button className="detail-wishlist" onClick={() => toggleWishlist(product.id)}>
            {isWishlisted ? '❤️' : '🤍'}
          </button>

          {/* Main photo — swipe carousel */}
          <div
            className="detail-photo-carousel"
            onTouchStart={photos.length > 1 ? onSwipeStart : undefined}
            onTouchEnd={photos.length > 1 ? onSwipeEnd : undefined}
            onClick={() => { if (!didSwipe.current) setLightbox(true); didSwipe.current = false; }}
          >
            <div className="detail-carousel-track" style={{ transform: `translateX(-${photoIdx * 100}%)` }}>
              {photos.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={url} src={url} alt={`${product.name} ${i + 1}`} className="detail-carousel-slide" loading="lazy"
                  onError={() => markFailed(url)} />
              ))}
            </div>
            {photos.length > 1 && (
              <>
                <button
                  className="detail-carousel-btn detail-carousel-prev"
                  onClick={e => { e.stopPropagation(); setPhotoIdx(i => (i - 1 + photos.length) % photos.length); }}
                  aria-label="Previous photo"
                >‹</button>
                <button
                  className="detail-carousel-btn detail-carousel-next"
                  onClick={e => { e.stopPropagation(); setPhotoIdx(i => (i + 1) % photos.length); }}
                  aria-label="Next photo"
                >›</button>
              </>
            )}
            {pct > 0 && <span className="detail-discount-float">-{pct}% OFF</span>}
          </div>

          {/* Thumbnails */}
          {photos.length > 1 && (
            <div className="detail-thumbs">
              {photos.map((url, i) => (
                <button
                  key={url}
                  className={`detail-thumb${i === photoIdx ? ' active' : ''}`}
                  onClick={() => setPhotoIdx(i)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`Photo ${i + 1}`} onError={() => markFailed(url)} />
                </button>
              ))}
            </div>
          )}

          {/* Dot indicators */}
          {photos.length > 1 && (
            <div className="detail-dots">
              {photos.map((_, i) => (
                <button
                  key={i}
                  className={`detail-dot${i === photoIdx ? ' active' : ''}`}
                  onClick={() => setPhotoIdx(i)}
                />
              ))}
            </div>
          )}
          {/* A single-photo product has no thumbnails/dots to show, but the
              page below (name, price, etc.) should start at the same spot as
              a multi-photo product — reserve the space instead of the layout
              shrinking to feel sparser. */}
          {photos.length <= 1 && <div className="detail-gallery-spacer" aria-hidden="true" />}
        </div>
      ) : (
        /* Emoji fallback */
        <div className="detail-img-wrap" style={bgStyle}>
          <button className="detail-back" onClick={goBack} aria-label="Go back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
          </button>
          <button className="detail-wishlist" onClick={() => toggleWishlist(product.id)}>
            {isWishlisted ? '❤️' : '🤍'}
          </button>
          <svg viewBox="0 0 48 48" width="96" height="96" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".2"><rect x="4" y="4" width="40" height="40" rx="6"/><path d="M4 34l10-10 8 8 8-12 14 16"/><circle cx="16" cy="16" r="4"/></svg>
          {pct > 0 && (
            <span style={{ position:'absolute', top:16, left:'50%', transform:'translateX(-50%)', background:'var(--danger)', color:'white', fontSize:'.72rem', fontWeight:700, padding:'3px 10px', borderRadius:99 }}>
              -{pct}% OFF
            </span>
          )}
        </div>
      )}

      {/* ── Product info ─── */}
      <div className="detail-body">
        <div className="detail-category">
          {cat?.icon} {cat?.name ?? product.category}
          {subCat && <span style={{ color:'var(--text-muted)' }}> › {subCat.icon} {subCat.name}</span>}
        </div>
        <h1 className="detail-name">{product.name}</h1>
        {product.brand && (
          <div style={{ fontSize:'.82rem', color:'var(--text-muted)', marginBottom:6 }}>
            by <strong>{product.brand}</strong>
          </div>
        )}

        <div className="detail-rating">
          <div className="stars">
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className="star-icon">
                {i < Math.floor(product.rating) ? '★' : i < product.rating ? '⭐' : '☆'}
              </span>
            ))}
          </div>
          <span className="detail-rating-text">
            {product.rating} ({product.reviews} reviews · {product.sold} sold)
          </span>
        </div>

        <div className="detail-price-row">
          {/* With bulk tiers the headline price follows the chosen quantity, so
              the buyer sees the rate they'll actually pay before adding. */}
          <span className="detail-price">${tierUnitPrice.toFixed(2)}</span>
          {tierUnitPrice < product.price ? (
            <span className="detail-orig">${product.price.toFixed(2)}</span>
          ) : product.originalPrice > product.price && (
            <span className="detail-orig">${product.originalPrice.toFixed(2)}</span>
          )}
          {pct > 0 && <span className="detail-discount-badge">-{pct}%</span>}
          {product.taxMode === 'included' && (
            <span className="tax-badge tax-included">VAT incl.</span>
          )}
          {product.taxMode === 'excluded' && (
            <span className="tax-badge tax-excluded">+5% VAT at checkout</span>
          )}
        </div>

        {/* Wholesale bulk pricing — buy more, pay less per unit */}
        {tiers.length > 0 && (
          <div style={{ margin: '10px 0 4px', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', background: 'var(--surface)', fontWeight: 700, fontSize: '.82rem' }}>
              📦 Bulk pricing
            </div>
            {tiers.map((t, i) => {
              const active = activeTier != null && t.minQty === activeTier.minQty && t.price === activeTier.price;
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '7px 12px', fontSize: '.83rem',
                    borderTop: '1px solid var(--border-light, #f1f5f9)',
                    background: active ? 'var(--primary-soft, rgba(99,102,241,.1))' : 'transparent',
                    fontWeight: active ? 700 : 400,
                    color: active ? 'var(--primary)' : 'inherit',
                  }}
                >
                  <span>{tierRangeLabel(t)} pcs</span>
                  <span>${t.price.toFixed(2)} each{active ? ' ← your price' : ''}</span>
                </div>
              );
            })}
            {tierSaving > 0 && (
              <div style={{ padding: '7px 12px', fontSize: '.78rem', fontWeight: 700, color: '#059669', borderTop: '1px solid var(--border-light, #f1f5f9)' }}>
                You save ${(tierSaving * qty).toFixed(2)} on {qty} pcs
              </div>
            )}
          </div>
        )}

        <p className="detail-desc">{product.description}</p>

        {/* Feature tags */}
        {product.tags && product.tags.length > 0 && (
          <div className="claim-tags-row" style={{ marginBottom: 14 }}>
            {product.tags.map(t => (
              <span key={t} className="claim-tag">{t}</span>
            ))}
          </div>
        )}

        {/* Barcode */}
        {product.barcode && (
          <div style={{ fontSize:'.76rem', color:'var(--text-muted)', marginBottom:12, fontFamily:'monospace' }}>
            🔢 {product.barcode}
          </div>
        )}

        <div className="detail-meta">
          <span className="meta-chip">SKU: {product.sku}</span>
          <span className={`meta-chip ${stock === 0 ? 'stock-danger' : stock <= 10 ? 'stock-warn' : 'stock-ok'}`}>
            {stock === 0 ? '❌ Out of Stock' : stock <= 10 ? `⚠️ Only ${stock} left` : `✓ ${stock} in stock`}
          </span>
          {supplier && (
            <button
              className="meta-chip"
              style={{ cursor:'pointer', color:'var(--primary)', fontWeight:600 }}
              onClick={() => router.push(storePath(supplier))}
            >
              🏭 {supplier.name}
              {supplier.verified && ' ✓'}
            </button>
          )}
        </div>

        {stock > 0 && (
          <div className="detail-qty">
            <span className="detail-qty-label">Quantity</span>
            <div className="detail-qty-control">
              <button className="dqty-btn" onClick={() => setQty(q => Math.max(1, q - 1))}>−</button>
              <span className="dqty-val">{qty}</span>
              <button className="dqty-btn" onClick={() => setQty(q => Math.min(stock, q + 1))}>+</button>
            </div>
          </div>
        )}

        {/* Business claim CTA — add this catalog product to your own store */}
        {canClaim && !isOwnProduct && (
          isMine(product.id) ? (
            <div className="empty-sub" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '12px 16px', borderRadius: 12, marginBottom: 10,
              background: 'var(--surface)', border: '1px solid var(--border)', fontWeight: 600,
            }}>
              ✓ This product is in your store.{' '}
              <button
                className="btn-link"
                style={{ background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 700, cursor: 'pointer', padding: 0 }}
                onClick={() => router.push('/inventory')}
              >
                Manage in Inventory
              </button>
            </div>
          ) : (
            <button
              className="btn btn-primary btn-lg"
              style={{ width: '100%', marginBottom: 10 }}
              disabled={claimingId === product.id}
              onClick={() => claim(product.id)}
            >
              {claimingId === product.id ? 'Adding…' : '➕ Add to My Store'}
            </button>
          )
        )}

        {isOwnProduct ? (
          <div className="empty-sub" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '14px 16px', borderRadius: 12, marginTop: 4,
            background: 'var(--surface)', border: '1px solid var(--border)', fontWeight: 600,
          }}>
            🏪 This is your store&apos;s product — you can&apos;t buy it yourself.
          </div>
        ) : (
          <div className="detail-cta">
            <button className="btn btn-outline btn-lg" disabled={stock === 0}
              onClick={() => addToCart(product.id, qty)}>
              Add to Cart
            </button>
            <button className="btn btn-primary btn-lg" disabled={stock === 0}
              onClick={() => {
                addToCart(product.id, qty);
                // Shop-scoped checkout keeps the store's name/logo on the
                // receipt and attributes the sale to the right seller.
                router.push(product.supplierId != null ? `/checkout/${product.supplierId}` : '/checkout');
              }}>
              Buy Now
            </button>
          </div>
        )}
      </div>

      {/* ── Reviews ─── */}
      <div className="review-section">
        <div className="review-section-header">
          <div className="review-section-title">
            ⭐ Reviews ({reviews.length})
          </div>
          {reviews.length > 0 && (
            <div className="review-avg">
              {(reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)} / 5
            </div>
          )}
        </div>

        {/* Write a review */}
        {user && !myExistingReview && (
          <div className="review-write-box">
            <div className="review-write-title">Write a Review</div>
            <div className="review-stars-row">
              {[1,2,3,4,5].map(n => (
                <button key={n} className={`review-star-btn${myRating >= n ? ' active' : ''}`}
                  onClick={() => setMyRating(n)}>★</button>
              ))}
              {myRating > 0 && <span className="review-rating-label">{['','Poor','Fair','Good','Great','Excellent'][myRating]}</span>}
            </div>
            <textarea
              className="form-input"
              rows={2}
              style={{ resize:'vertical', fontFamily:'inherit', marginTop:8 }}
              placeholder="Share your experience (optional)…"
              value={myComment}
              onChange={e => setMyComment(e.target.value)}
            />
            <button
              className="btn btn-primary btn-sm"
              style={{ marginTop: 8 }}
              onClick={submitReview}
              disabled={!myRating || reviewLoading}
            >
              {reviewLoading ? 'Submitting…' : 'Submit Review'}
            </button>
          </div>
        )}
        {/* Brief confirmation right after submitting — hides itself */}
        {user && justReviewed && myExistingReview && (
          <div className="review-my-badge">
            ✓ You reviewed this product — {['','★','★★','★★★','★★★★','★★★★★'][myExistingReview.rating]}
          </div>
        )}
        {!user && (
          <div className="review-signin-prompt">
            <button className="btn btn-ghost btn-sm" onClick={() => router.push('/auth/login')}>
              Sign in to write a review
            </button>
          </div>
        )}

        {/* Reviews list */}
        {reviewsLoaded && reviews.length === 0 && (
          <div className="review-empty">No reviews yet — be the first!</div>
        )}
        <div className="review-list">
          {reviews.slice(0, visibleReviews).map(r => (
            <div key={r.id} className="review-card">
              <div className="review-card-header">
                <span className="review-avatar">{r.userAvatar}</span>
                <div>
                  <div className="review-user-name">{r.userName}</div>
                  <div className="review-date">
                    {new Date(r.createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}
                  </div>
                </div>
                <div className="review-rating-stars">
                  {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}
                </div>
              </div>
              {r.comment && <div className="review-comment">{r.comment}</div>}
            </div>
          ))}
        </div>
        {/* Latest 2 first; each tap reveals 3 more */}
        {reviews.length > visibleReviews && (
          <button
            className="btn btn-ghost btn-sm"
            style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
            onClick={() => setVisibleReviews(n => n + 3)}
          >
            Show more (+{Math.min(3, reviews.length - visibleReviews)} of {reviews.length - visibleReviews})
          </button>
        )}
      </div>

      {/* ── Similar products ─── */}
      {similar.length > 0 && (
        <div className="similar-section">
          <div className="section-header" style={{ padding:'20px 0 12px' }}>
            <span className="section-title">Similar Products</span>
          </div>
          <div className="similar-scroll">
            {similar.map(p => (
              <div key={p.id} className="similar-card" onClick={() => { router.push(`/product/${p.id}`); setPhotoIdx(0); }}>
                <div className="similar-photo">
                  <ProductImage imageUrl={p.imageUrl} imageUrls={p.imageUrls} name={p.name} />
                </div>
                <div className="similar-body">
                  <div className="similar-name">{p.name}</div>
                  <div className="similar-price">${p.price.toFixed(2)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Lightbox ─── */}
      {lightbox && hasPhotos && (
        <div
          className="lightbox-overlay"
          onClick={() => setLightbox(false)}
        >
          <button className="lightbox-close" onClick={() => setLightbox(false)}>✕</button>
          {photos.length > 1 && (
            <button className="lightbox-prev"
              onClick={e => { e.stopPropagation(); setPhotoIdx(i => (i - 1 + photos.length) % photos.length); }}>
              ‹
            </button>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photos[photoIdx]}
            alt={product.name}
            className="lightbox-img"
            onClick={e => e.stopPropagation()}
            onError={() => { markFailed(photos[photoIdx]); setLightbox(false); }}
          />
          {photos.length > 1 && (
            <button className="lightbox-next"
              onClick={e => { e.stopPropagation(); setPhotoIdx(i => (i + 1) % photos.length); }}>
              ›
            </button>
          )}
          {photos.length > 1 && (
            <div className="lightbox-counter">{photoIdx + 1} / {photos.length}</div>
          )}
        </div>
      )}
    </div>
  );
}
