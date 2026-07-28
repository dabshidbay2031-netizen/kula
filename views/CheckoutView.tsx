'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter, useParams } from '@/lib/hashRouter';
import dynamic from 'next/dynamic';
import Header from '@/components/Header';
import ProductImage from '@/components/ProductImage';
import StoreAvatar from '@/components/StoreAvatar';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { MOGADISHU_DISTRICTS } from '@/lib/data';
import { readReceiptAutoPrintSetting } from '@/lib/receiptSettings';
import { computePlatformFee, PLATFORM_FEE_LABEL } from '@/lib/fees';
import type { SifaloGateway } from '@/lib/types';

/** Sifalo wallet options shown in checkout → mapped to a Sifalo gateway id. */
const SIFALO_WALLETS: { id: SifaloGateway; label: string; hint: string }[] = [
  { id: 'waafi',   label: 'EVC / ZAAD / SAHAL', hint: 'Waafi wallets' },
  { id: 'edahab',  label: 'eDahab',             hint: 'Somtel' },
  { id: 'pbwallet',label: 'Premier Wallet',     hint: 'USD only' },
];

const Receipt = dynamic(() => import('@/components/Receipt'), { ssr: false });

export default function CheckoutPage() {
  const router = useRouter();
  const params = useParams<{ shopId?: string }>();
  const { state, setPaymentMethod, setPaymentState, removeFromCart, reloadProducts, toast } = useApp();
  const { user } = useAuth();
  const { cart, products, suppliers, paymentMethod, paymentState } = state;

  /** Stable for the life of this checkout screen — see placeOrderNow (M5). */
  const checkoutKeyRef = useRef<string>(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `ck-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  // This checkout is scoped to ONE shop. The cart can hold items from several
  // shops; we only place/charge the items belonging to the chosen shop.
  const routeShopId = params.shopId ? parseInt(params.shopId, 10) : null;

  // Plain '/checkout' (e.g. "Buy Now"): when every cart item belongs to the
  // same shop, that IS the shop — so the receipt still gets the store's name
  // and logo, and the order is attributed to the right seller.
  const inferredShopId = useMemo(() => {
    if (routeShopId != null) return routeShopId;
    const ids = new Set<number | null>();
    for (const item of cart) {
      const p = products.find(x => x.id === item.id);
      ids.add(p?.supplierId ?? null);
    }
    if (ids.size === 1) {
      const only = ids.values().next().value;
      return only ?? null;
    }
    return null;
  }, [routeShopId, cart, products]);

  const shopId = inferredShopId;
  const shop   = shopId != null ? suppliers.find(s => s.id === shopId) : null;
  const shopName = shop?.name ?? 'Hamar Mall';
  // Online-only stores have no shopfront → delivery is the only option.
  const onlineOnly = !!shop?.onlineOnly;

  const shopCart = useMemo(() => {
    if (shopId == null) return cart;
    return cart.filter(item => {
      const p = products.find(x => x.id === item.id);
      return (p?.supplierId ?? null) === shopId;
    });
  }, [cart, products, shopId]);

  const [lastOrderId,    setLastOrderId]    = useState('');
  const [showReceipt,    setShowReceipt]    = useState(false);
  const [receiptItems,   setReceiptItems]   = useState(shopCart);
  const [receiptSubtotal,setReceiptSubtotal]= useState(0);
  const [receiptDiscount,setReceiptDiscount]= useState(0);
  const [receiptTotal,   setReceiptTotal]   = useState(0);
  const [receiptName,    setReceiptName]    = useState('');
  const [autoPrintReceipts, setAutoPrintReceipts] = useState(false);

  // Customer info
  const [name,  setName]  = useState('');

  // Fulfillment — pickup at the store, or delivery to a Mogadishu district.
  const [fulfillment, setFulfillment] = useState<'delivery' | 'pickup'>('delivery');
  const [district,      setDistrict]      = useState('');
  const [deliveryNotes, setDeliveryNotes] = useState('');

  // Payment method — SifaloPay only. Cash on delivery/pickup is not offered
  // online (it skips the platform fee and can't be verified before fulfillment);
  // cash stays available in-store via POS.
  const payMethod: 'sifalo' = 'sifalo';

  // Sifalo Pay (on OUR page) — wallet type + number. No redirect to Sifalo.
  const [sifaloGateway, setSifaloGateway] = useState<SifaloGateway>('waafi');
  const [sifaloAccount, setSifaloAccount] = useState('');

  // Coupon
  const [couponCode,     setCouponCode]     = useState('');
  const [couponLoading,  setCouponLoading]  = useState(false);
  const [couponError,    setCouponError]    = useState('');
  const [couponSuccess,  setCouponSuccess]  = useState('');
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [appliedCoupon,  setAppliedCoupon]  = useState<{ id: number; code: string } | null>(null);

  const subtotal    = shopCart.reduce((n, item) => {
    const p = products.find(x => x.id === item.id);
    return p ? n + p.price * item.qty : n;
  }, 0);
  const vatAmount   = shopCart.reduce((n, item) => {
    const p = products.find(x => x.id === item.id);
    if (!p || p.taxMode !== 'excluded') return n;
    return n + p.price * item.qty * 0.05;
  }, 0);
  const discountAmt = couponDiscount;
  // 3% platform fee — online payments only, and skipped per-product when the
  // store opted to absorb it. Mirrors the server's computation in /api/orders,
  // which is authoritative; this is what the buyer sees before confirming.
  const feeBreakdown = computePlatformFee(
    shopCart.map(item => {
      const p = products.find(x => x.id === item.id);
      return { price: p?.price ?? 0, qty: item.qty, feeAbsorbedByStore: p?.feeAbsorbedByStore };
    }),
    payMethod,
  );
  const feeAmount   = feeBreakdown.buyerFee;
  const total       = Math.max(0, subtotal + vatAmount + feeAmount - discountAmt);

  // Pre-fill name + wallet number from profile
  useEffect(() => {
    if (user?.displayName) setName(user.displayName);
    if (user?.phoneNumber) setSifaloAccount(user.phoneNumber.replace(/\D/g, '').replace(/^252/, ''));
  }, [user]);

  // Keep the global payment method in sync with the picker (used on the receipt).
  useEffect(() => { setPaymentMethod(payMethod); }, [payMethod, setPaymentMethod]);
  useEffect(() => {
    setAutoPrintReceipts(readReceiptAutoPrintSetting());
  }, []);

  if (shopCart.length === 0 && paymentState !== 'success') {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div className="empty-state" style={{ marginTop: 60 }}>
          <div className="empty-icon" aria-hidden="true">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-light)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
              <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
            </svg>
          </div>
          <div className="empty-title">Nothing to check out</div>
          <div className="empty-sub">This shop has no items in your cart</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => router.push('/')}>
            Browse Products
          </button>
        </div>
      </div>
    );
  }

  /* ── Coupon validation ─── */
  const handleApplyCoupon = async () => {
    if (!couponCode.trim()) return;
    setCouponLoading(true); setCouponError(''); setCouponSuccess('');
    try {
      const res  = await fetch('/api/coupons/validate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code: couponCode.trim(), orderTotal: subtotal }),
      });
      const data = await res.json();
      if (data.valid) {
        setCouponDiscount(data.discountAmount);
        setAppliedCoupon(data.coupon);
        setCouponSuccess(data.message);
      } else {
        setCouponError(data.message);
        setCouponDiscount(0);
        setAppliedCoupon(null);
      }
    } catch {
      setCouponError('Failed to validate coupon');
    }
    setCouponLoading(false);
  };

  const removeCoupon = () => {
    setCouponCode(''); setCouponDiscount(0); setAppliedCoupon(null);
    setCouponError(''); setCouponSuccess('');
  };

  /* ── Fulfillment note recorded on the order ─── */
  const deliveryNote = (): string => {
    if (fulfillment === 'pickup') return `Pickup at ${shopName}`;
    const parts = [`Delivery to ${district}`];
    if (deliveryNotes.trim()) parts.push(deliveryNotes.trim());
    return parts.join(' — ');
  };

  /* ── Place the order on THIS page — runs only AFTER a confirmed
     on-page Sifalo charge (sifaloSid set). ── */
  const placeOrderNow = async (sifaloSid: string | null) => {
    // One key per checkout screen. A double-tapped button, or a retry after a
    // network blip, replays the SAME key — the server then returns the order it
    // already created instead of charging the customer twice. Disabling the
    // button client-side never covered the blip-and-retry case.
    const idempotencyKey = checkoutKeyRef.current;
    const contactPhone = `+252${sifaloAccount}`;
    const notes = [deliveryNote(), sifaloSid ? `Sifalo SID: ${sifaloSid}` : null].filter(Boolean).join(' | ') || null;

    // The server is the source of truth: it prices the items from the DB,
    // validates + consumes the coupon, generates the order id, and decrements
    // stock atomically. We only describe WHAT we're buying (this shop's items).
    let order: { id: string; subtotal: number; discount: number; total: number } | null = null;
    try {
      const res = await fetch('/api/orders', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body:    JSON.stringify({
          customerName:  name,
          customerPhone: contactPhone,
          userId:        user?.id ?? null,
          items:         shopCart.map(i => ({ id: i.id, qty: i.qty })),
          paymentMethod: payMethod,
          couponCode:    appliedCoupon?.code ?? null,
          supplierId:    shopId,   // which store sold this order (dashboard attribution)
          notes,
        }),
      });
      if (res.ok) order = await res.json();
      else { const err = await res.json().catch(() => null); toast(err?.error ?? 'Order could not be placed.', 'error'); }
    } catch {
      toast('Network error — your order was NOT placed.', 'error');
    }

    if (!order) { setPaymentState('idle'); return; }

    setLastOrderId(order.id);
    setReceiptItems([...shopCart]);
    setReceiptSubtotal(order.subtotal);
    setReceiptDiscount(order.discount);
    setReceiptTotal(order.total);
    setReceiptName(name);
    // Remove only THIS shop's items — other shops stay in the cart.
    shopCart.forEach(i => removeFromCart(i.id));
    reloadProducts().catch(() => {});
    setPaymentState('success');
    toast('Payment successful!', 'success');
  };

  /* ── Pay with Sifalo, ON OUR PAGE (direct wallet debit) ──────────────
     Charges the customer's wallet directly from this page (USSD approval).
     There is NO redirect to Sifalo's hosted checkout — if the charge is not
     confirmed successful, the order is simply not placed. */
  const payWithSifalo = async () => {
    if (!name.trim()) { toast('Please enter your name', 'error'); return; }
    if (fulfillment === 'delivery' && !district) { toast('Please choose your delivery district', 'error'); return; }
    if (sifaloAccount.length < 7) { toast('Please enter a valid wallet number', 'error'); return; }
    setPaymentState('pending');
    const ref = `MG-${Date.now()}`;

    try {
      const res = await fetch('/api/payments/sifalo/initiate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: `252${sifaloAccount}`, gateway: sifaloGateway, amount: Number(total.toFixed(2)), orderId: ref }),
      });
      let r = await res.json();
      let tries = 0;
      while (r.status === 'pending' && r.sid && tries < 5) {
        await new Promise(d => setTimeout(d, 2500));
        r = await (await fetch('/api/payments/sifalo/verify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid: r.sid, orderId: ref }),
        })).json();
        tries++;
      }
      if (r.status === 'success') { await placeOrderNow(r.sid ?? null); return; }
      // Anything else = not confirmed. No hosted-page fallback.
      toast('Payment was not successful. Please approve the request and try again.', 'error');
      setPaymentState('idle');
    } catch {
      toast('Payment failed. Please try again.', 'error');
      setPaymentState('idle');
    }
  };

  if (paymentState === 'pending') {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div className="payment-pending">
          <div className="spinner" />
          <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: 8 }}>
            Processing Payment…
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '.88rem' }}>
            Confirming with Sifalo Pay — approve the request on your phone.
          </div>
        </div>
      </div>
    );
  }

  if (paymentState === 'success') {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div className="payment-success">
          <div className="success-icon" aria-hidden="true">
            <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="m8.5 12.5 2.5 2.5 5-6"/>
            </svg>
          </div>
          <div className="success-title">Payment Successful!</div>
          <div className="success-subtitle">Your order has been placed</div>
          <div className="success-order-box">
            <div className="success-order-id">{lastOrderId || 'Order Confirmed'}</div>
            <div className="success-order-total">
              Total paid: <strong>${receiptTotal.toFixed(2)}</strong>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
            <button
              className="btn btn-secondary btn-lg"
              onClick={() => setShowReceipt(true)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                <rect x="6" y="14" width="12" height="8" rx="1"/>
              </svg>
              Print Receipt
            </button>
            {user && (
              <button className="btn btn-outline btn-lg" onClick={() => { setPaymentState('idle'); router.push(`/orders/${lastOrderId}`); }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>
                Track Order
              </button>
            )}
            <button className="btn btn-primary btn-lg" onClick={() => { setPaymentState('idle'); router.push('/'); }}>
              Continue Shopping
            </button>
          </div>
        </div>

        {showReceipt && (
          <Receipt
            orderId={lastOrderId}
            businessName={shop?.name}
            businessIcon={shop?.icon}
            customerName={receiptName}
            paymentMethod={paymentMethod}
            items={receiptItems}
            products={state.products}
            subtotal={receiptSubtotal}
            discount={receiptDiscount}
            total={receiptTotal}
            autoPrint={autoPrintReceipts}
            onClose={() => setShowReceipt(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="page-anim">
      <Header showSearch={false} />
      <div className="checkout-wrap">

        {/* Shop being checked out */}
        <div className="checkout-shop-banner" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          🛍️ Checkout —
          <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-flex', width: 20, height: 20, borderRadius: 5, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
              <StoreAvatar value={shop?.icon} alt={`${shopName} logo`} />
            </span>
            {shopName}
          </strong>
        </div>

        {/* Order Summary */}
        <div className="checkout-section">
          <div className="checkout-section-title">Order Summary</div>
          <div className="order-items-list">
            {shopCart.map(item => {
              const p = products.find(x => x.id === item.id);
              if (!p) return null;
              return (
                <div key={item.id} className="checkout-item">
                  <div className="checkout-item-icon">
                    <div style={{ width:36, height:36, borderRadius:6, overflow:'hidden' }}>
                      <ProductImage imageUrl={p.imageUrl} imageUrls={p.imageUrls} name={p.name} />
                    </div>
                  </div>
                  <div className="checkout-item-info">
                    <div className="checkout-item-name">{p.name}</div>
                    <div className="checkout-item-qty">Qty: {item.qty}</div>
                  </div>
                  <div className="checkout-item-price">${(p.price * item.qty).toFixed(2)}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Fulfillment — Pickup or Delivery (Mogadishu districts).
            Online-only stores have no shopfront, so only Delivery is offered. */}
        <div className="checkout-section">
          <div className="checkout-section-title">🚚 Delivery</div>
          {onlineOnly ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
              borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--border)',
              fontSize: '.85rem', fontWeight: 600, color: 'var(--primary)',
            }}>
              🌐 Online store — delivered to your address (no pickup)
            </div>
          ) : (
            <div className="fulfill-toggle">
              <button
                type="button"
                className={`fulfill-opt ${fulfillment === 'delivery' ? 'active' : ''}`}
                onClick={() => setFulfillment('delivery')}
              >
                🛵 Delivery
              </button>
              <button
                type="button"
                className={`fulfill-opt ${fulfillment === 'pickup' ? 'active' : ''}`}
                onClick={() => setFulfillment('pickup')}
              >
                🏬 Pickup
              </button>
            </div>
          )}

          {(onlineOnly || fulfillment === 'delivery') ? (
            <>
              <div className="form-group" style={{ marginTop: 12 }}>
                <label className="form-label">District (Mogadishu)</label>
                <select className="form-input" value={district} onChange={e => setDistrict(e.target.value)}>
                  <option value="">Select your district…</option>
                  {MOGADISHU_DISTRICTS.map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Address notes (optional)</label>
                <input
                  className="form-input"
                  placeholder="e.g. Near KM4, blue gate"
                  value={deliveryNotes}
                  onChange={e => setDeliveryNotes(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="checkout-pickup-note">
              📍 Pick up your order at <strong>{shopName}</strong>.
            </div>
          )}
        </div>

        {/* Coupon */}
        <div className="checkout-section">
          <div className="checkout-section-title">🎟️ Coupon Code</div>
          {appliedCoupon ? (
            <div className="coupon-applied-row">
              <div>
                <div className="coupon-applied-code">✓ {appliedCoupon.code}</div>
                <div className="coupon-applied-savings">{couponSuccess} — saved ${discountAmt.toFixed(2)}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={removeCoupon} style={{ color: 'var(--danger)' }}>Remove</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="form-input"
                placeholder="Enter coupon code…"
                value={couponCode}
                onChange={e => { setCouponCode(e.target.value.toUpperCase()); setCouponError(''); setCouponSuccess(''); }}
                onKeyDown={e => e.key === 'Enter' && handleApplyCoupon()}
                style={{ flex: 1 }}
              />
              <button className="btn btn-secondary" onClick={handleApplyCoupon} disabled={couponLoading || !couponCode.trim()}>
                {couponLoading ? '…' : 'Apply'}
              </button>
            </div>
          )}
          {couponError   && <div className="auth-error"   style={{ marginTop: 8 }}>{couponError}</div>}
        </div>

        {/* Summary */}
        <div className="checkout-section">
          <div className="summary-box">
            <div className="summary-row"><span>Subtotal</span><span>${subtotal.toFixed(2)}</span></div>
            {vatAmount > 0 && (
              <div className="summary-row">
                <span>VAT (5%)</span>
                <span>+${vatAmount.toFixed(2)}</span>
              </div>
            )}
            {feeAmount > 0 && (
              <div className="summary-row">
                <span>{PLATFORM_FEE_LABEL}</span>
                <span>+${feeAmount.toFixed(2)}</span>
              </div>
            )}
            {feeBreakdown.storeFee > 0 && feeAmount === 0 && (
              <div className="summary-row" style={{ color: 'var(--success, #059669)' }}>
                <span>{PLATFORM_FEE_LABEL}</span>
                <span>Paid by the store</span>
              </div>
            )}
            {discountAmt > 0 && (
              <div className="summary-row discount">
                <span>Coupon ({appliedCoupon?.code})</span>
                <span>-${discountAmt.toFixed(2)}</span>
              </div>
            )}
            <div className="summary-row total"><span>Total</span><span>${total.toFixed(2)}</span></div>
          </div>
        </div>

        {/* Customer Info */}
        <div className="checkout-section">
          <div className="checkout-section-title">Customer Info</div>
          <div className="form-group">
            <label className="form-label">Full Name</label>
            <input className="form-input" placeholder="Enter your name" value={name} onChange={e => setName(e.target.value)} />
          </div>
        </div>

        {/* Payment — Sifalo Pay on our own page. Cash is not offered online. */}
        <div className="checkout-section">
          <div className="checkout-section-title">Payment</div>

          <div className="sifalo-box">
            <div className="sifalo-head">
              <span className="sifalo-logo">Sifalo<span>Pay</span></span>
              <span className="sifalo-amount">${total.toFixed(2)}</span>
            </div>
            <div className="sifalo-sub">Dooro wallet-kaaga, geli lambarka, kana ogolow codsiga taleefankaaga.</div>

            <div className="sifalo-wallets">
              {SIFALO_WALLETS.map(w => (
                <button key={w.id} type="button"
                  className={`sifalo-wallet ${sifaloGateway === w.id ? 'active' : ''}`}
                  onClick={() => setSifaloGateway(w.id)}>
                  <span className="sifalo-wallet-label">{w.label}</span>
                  <span className="sifalo-wallet-hint">{w.hint}</span>
                </button>
              ))}
            </div>

            <label className="form-label" style={{ marginTop: 4 }}>Wallet number</label>
            <div className="waafi-input-wrap">
              <span className="waafi-prefix">+252</span>
              <input
                className="waafi-phone"
                placeholder="61 XXX XXXX"
                value={sifaloAccount}
                onChange={e => setSifaloAccount(e.target.value.replace(/\D/g, ''))}
                maxLength={9}
              />
            </div>

            <button className="btn btn-primary btn-full btn-lg" style={{ marginTop: 12 }} onClick={payWithSifalo}>
              🇸🇴 Pay ${total.toFixed(2)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
