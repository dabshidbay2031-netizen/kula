'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Header from '@/components/Header';
import ProductImage from '@/components/ProductImage';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { authHeaders } from '@/lib/clientAuth';
import { useMyProductIds } from '@/lib/useMyProductIds';
import { stockedCategories } from '@/lib/data';
import { enqueueOrder, queueCount, onQueueChange } from '@/lib/offlineQueue';
import { useCashier } from '@/context/CashierContext';
import { readReceiptAutoPrintSetting, readReceiptSettings, type ReceiptSettings } from '@/lib/receiptSettings';
import type { CartItem, Customer, PaymentMethod, PosSession } from '@/lib/types';

/* Register behavior configured in Settings → Point of Sale. */
interface PosSettings {
  defaultPayment:      PaymentMethod;
  requireCustomerName: boolean;
  autoPrint:           boolean;
}
function readPosSettings(): PosSettings {
  try {
    const s = JSON.parse(localStorage.getItem('mogarenta_settings') ?? '{}');
    return {
      defaultPayment:      (['cash', 'waafi', 'card'].includes(s.defaultPayment) ? s.defaultPayment : 'cash') as PaymentMethod,
      requireCustomerName: !!s.requireCustomerName,
      autoPrint:           !!s.autoPrint,
    };
  } catch {
    return { defaultPayment: 'cash', requireCustomerName: false, autoPrint: false };
  }
}

const Receipt        = dynamic(() => import('@/components/Receipt'), { ssr: false });
const BarcodeScanner = dynamic(() => import('@/components/BarcodeScanner'), { ssr: false });

/* ── Park/hold types ─────────────────────────────────────────── */
interface ParkedCart {
  id:      string;
  label:   string;
  savedAt: string;
  items:   CartItem[];
}

/* ── Payment split ───────────────────────────────────────────── */
interface Split {
  method: PaymentMethod;
  amount: string;
}

const PARK_KEY = 'mg_parked_carts';
function readParked(): ParkedCart[] {
  try { return JSON.parse(localStorage.getItem(PARK_KEY) ?? '[]'); } catch { return []; }
}
function writeParked(carts: ParkedCart[]) {
  try { localStorage.setItem(PARK_KEY, JSON.stringify(carts)); } catch { /* storage full */ }
}

/* ── Offline sync indicator ──────────────────────────────────────
   The actual uploading now happens app-wide in <SyncManager>; this badge just
   reflects the shared queue count so the cashier sees how many sales are still
   waiting to reach the server. */
function OfflineBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refresh = () => setCount(queueCount());
    refresh();
    const off = onQueueChange(refresh);
    window.addEventListener('online', refresh);
    return () => { off(); window.removeEventListener('online', refresh); };
  }, []);

  if (!count) return null;
  return (
    <span className="offline-sync-badge" title="Sales queued offline — syncing when back online">
      ⏳ {count} pending sync
    </span>
  );
}

export default function POSPage() {
  const { state, toast, reloadProducts, getStock } = useApp();
  const { user } = useAuth();
  const { cashier } = useCashier();
  const { products, suppliers, loading } = state;

  /* ── Session ─────────────────────────────────────────────────── */
  const [session, setSession] = useState<PosSession | null | 'loading'>('loading');
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [cashierName, setCashierName] = useState('');
  const [openingFloat, setOpeningFloat] = useState('0');
  const [openingSession, setOpeningSession] = useState(false);

  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closingCounted, setClosingCounted] = useState('');
  const [closeNotes, setCloseNotes] = useState('');
  const [closingSession, setClosingSession] = useState(false);
  const [sessionReport, setSessionReport] = useState<{
    totalOrders: number; totalRevenue: number; cashRevenue: number; expectedCash: number;
  } | null>(null);

  /* ── POS-local cart ──────────────────────────────────────────── */
  const [posCart, setPosCart] = useState<CartItem[]>([]);

  /* ── Park / hold ─────────────────────────────────────────────── */
  const [parkedCarts, setParkedCarts] = useState<ParkedCart[]>([]);
  const [showParked, setShowParked] = useState(false);

  /* ── Checkout modal ──────────────────────────────────────────── */
  const [showCheckout, setShowCheckout] = useState(false);
  const [checkoutName, setCheckoutName] = useState('Walk-in Customer');
  const [checkoutPhone, setCheckoutPhone] = useState('');
  const [posDiscount, setPosDiscount] = useState('');  // manual discount ($), staff-applied
  const [splits, setSplits] = useState<Split[]>([{ method: 'cash', amount: '' }]);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [lastOrderId, setLastOrderId] = useState('');
  const [showReceipt, setShowReceipt] = useState(false);
  /** True when the receipt on screen is a plain counter print, not a sale. */
  const [printOnly, setPrintOnly] = useState(false);

  /* The sale panel. Desktop opens with it showing — there is room, and a
     cashier needs the running total in view. A phone starts closed so the
     product grid gets the whole screen; the total button in the title bar
     opens it. */
  const [saleOpen, setSaleOpen] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(min-width: 900px)').matches) {
      setSaleOpen(true);
    }
  }, []);
  const [receiptData, setReceiptData] = useState<{
    items: CartItem[]; name: string; subtotal: number; discount: number; total: number; method: string;
  } | null>(null);

  /* ── Settings (Settings → Point of Sale) ─────────────────────── */
  const [posSettings, setPosSettings] = useState<PosSettings>({ defaultPayment: 'cash', requireCustomerName: false, autoPrint: false });
  /* POS-ONLY receipt customisation (QR toggle, merchant number, header lines).
     Online-sale receipts deliberately don't read these. */
  const [receiptCfg, setReceiptCfg] = useState<ReceiptSettings>(() => ({
    receiptQr: true, merchantNumber: '', receiptHeader1: '', receiptHeader2: '', receiptHeader3: '',
  }));
  useEffect(() => {
    const settings = readPosSettings();
    setPosSettings(settings);
    if (settings.autoPrint !== readReceiptAutoPrintSetting()) {
      setPosSettings(current => ({ ...current, autoPrint: readReceiptAutoPrintSetting() }));
    }
    setReceiptCfg(readReceiptSettings());
  }, []);

  // Settings live in localStorage and are edited on another screen; re-read
  // when the register regains focus so a change lands without a reload.
  useEffect(() => {
    const refresh = () => setReceiptCfg(readReceiptSettings());
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  /* ── Invoice a credit customer (pay later) ───────────────────── */
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoiceCustomerId, setInvoiceCustomerId] = useState('');
  const [invoicing, setInvoicing] = useState(false);

  /* ── Product filter ──────────────────────────────────────────── */
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');

  /* ── Barcode scan-to-add ─────────────────────────────────────── */
  const [scanOpen, setScanOpen] = useState(false);

  /* ── Session timer ───────────────────────────────────────────── */
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /* ── Load session + parked carts on mount ────────────────────── */
  useEffect(() => {
    fetch('/api/pos-sessions?current=1')
      .then(r => r.json())
      .then(d => setSession(d || null))
      .catch(() => setSession(null));
    setParkedCarts(readParked());
  }, []);

  useEffect(() => {
    // Prefer cashier session name, then Supabase display name
    if (cashier?.name) setCashierName(cashier.name);
    else if (user?.displayName) setCashierName(user.displayName);
  }, [cashier, user]);

  /* ── Derived values ──────────────────────────────────────────── */
  // The store this register belongs to — the signed-in owner's supplier, or
  // the business a cashier logged into (cashier.businessId === owner auth id).
  const currentSupplier = useMemo(
    () => suppliers.find(s =>
      s.authUserId === user?.id ||
      (cashier ? s.authUserId === cashier.businessId : false)
    ) ?? null,
    [suppliers, user, cashier]
  );

  // This store's products (owned + claimed); the whole catalog for admins.
  const { ids: myIds, scoped: myScoped } = useMyProductIds();

  // A register only ever shows its OWN store's products — never the whole
  // catalog (only an admin/non-store account, myScoped === false, sees all).
  const myProducts = useMemo(
    () => (myScoped ? products.filter(p => myIds.has(p.id)) : products),
    [products, myIds, myScoped],
  );

  /**
   * Only the categories this register actually stocks. Derived from the
   * store's products BEFORE the search filter is applied — otherwise chips
   * would appear and vanish as the cashier types.
   */
  const availableCategories = useMemo(() => stockedCategories(myProducts), [myProducts]);

  /**
   * A selected category can empty out mid-shift — last unit sold, product
   * deleted from Inventory. Its chip disappears but `activeCategory` still
   * points at it, leaving an empty grid and no lit chip to explain why, so
   * fall back to All.
   *
   * Skipped while the catalog is empty: that's the initial load, not a store
   * that stocks nothing, and resetting there would drop the cashier's choice
   * every time products refresh.
   */
  useEffect(() => {
    if (myProducts.length === 0 || activeCategory === 'all') return;
    if (!availableCategories.some(c => c.id === activeCategory)) setActiveCategory('all');
  }, [myProducts, availableCategories, activeCategory]);

  const filtered = useMemo(() => {
    let list = myProducts;
    if (activeCategory !== 'all')
      list = list.filter(p => p.category === activeCategory);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q)  ||
        ((p as typeof p & { barcode?: string }).barcode ?? '').includes(q)
      );
    }
    return list;
  }, [myProducts, search, activeCategory]);

  const posTotal = useMemo(
    () => posCart.reduce((s, i) => s + (products.find(x => x.id === i.id)?.price ?? 0) * i.qty, 0),
    [posCart, products]
  );
  const posItemCount = posCart.reduce((s, i) => s + i.qty, 0);

  // Manual discount, clamped to the subtotal — `posNet` is the amount to charge.
  const posDiscountNum = useMemo(() => {
    const d = Math.round((parseFloat(posDiscount) || 0) * 100) / 100;
    return Math.min(Math.max(d, 0), posTotal);
  }, [posDiscount, posTotal]);
  const posNet = useMemo(() => Math.round((posTotal - posDiscountNum) * 100) / 100, [posTotal, posDiscountNum]);

  const sessionAge = useMemo(() => {
    if (!session || session === 'loading') return '';
    const ms = now - new Date(session.openedAt).getTime();
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }, [session, now]);

  const splitTotal = useMemo(
    () => splits.reduce((s, sp) => s + (parseFloat(sp.amount) || 0), 0),
    [splits]
  );
  const changeDue = Math.max(0, splitTotal - posNet);

  /* ── Session handlers ────────────────────────────────────────── */
  // Build a device-local register so the POS is fully usable OFFLINE. Its sales
  // still attribute to the store (supplier + cashier); they carry no DB session
  // link, which is fine — the server drops the missing session_id on sync.
  function makeLocalSession(): PosSession {
    return {
      id:            `LOCAL-SESSION-${Date.now().toString(36).toUpperCase()}`,
      openedBy:      user?.id ?? cashier?.id ?? 'offline',
      cashierName:   cashierName.trim(),
      openedAt:      new Date().toISOString(),
      closedAt:      null,
      openingFloat:  parseFloat(openingFloat) || 0,
      closingCounted: null, expectedCash: null, discrepancy: null,
      status:        'open', notes: null, local: true,
    };
  }

  async function handleOpenSession() {
    if (!cashierName.trim()) { toast('Enter cashier name', 'error'); return; }
    setOpeningSession(true);
    // Offline up front → open a local register immediately, no network attempt.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setSession(makeLocalSession());
      setShowOpenModal(false);
      toast('Register opened offline — sales sync when you reconnect', 'warning');
      setOpeningSession(false);
      return;
    }
    try {
      const res = await fetch('/api/pos-sessions', {
        method: 'POST', headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          openedBy:     user?.id ?? 'anonymous',
          cashierName:  cashierName.trim(),
          openingFloat: parseFloat(openingFloat) || 0,
        }),
      });
      if (res.ok) {
        setSession(await res.json());
        setShowOpenModal(false);
        toast('Register opened', 'success');
      } else {
        toast('Failed to open session', 'error');
      }
    } catch {
      // Network dropped mid-request → fall back to a local register so the
      // cashier is never blocked from selling.
      setSession(makeLocalSession());
      setShowOpenModal(false);
      toast('Register opened offline — sales sync when you reconnect', 'warning');
    }
    setOpeningSession(false);
  }

  async function openCloseModal() {
    if (!session || session === 'loading') return;
    setClosingCounted('');
    setCloseNotes('');
    setSessionReport(null);
    setShowCloseModal(true);
    if (session.local) return; // no server report for an offline register
    try {
      const res = await fetch(`/api/pos-sessions/${session.id}`);
      if (res.ok) {
        const d = await res.json();
        setSessionReport({
          totalOrders:  d.totalOrders,
          totalRevenue: d.totalRevenue,
          cashRevenue:  d.cashRevenue,
          expectedCash: d.expectedCash,
        });
      }
    } catch { /* show modal anyway */ }
  }

  async function handleCloseSession() {
    if (!session || session === 'loading') return;
    setClosingSession(true);
    // A LOCAL (offline) register has no DB row to close — just clear it here.
    if (session.local) {
      setSession(null);
      setShowCloseModal(false);
      setPosCart([]);
      toast('Register closed', 'success');
      setClosingSession(false);
      return;
    }
    try {
      const res = await fetch(`/api/pos-sessions/${session.id}`, {
        method: 'PATCH', headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ closingCounted: parseFloat(closingCounted) || 0, notes: closeNotes }),
      });
      if (res.ok) {
        setSession(null);
        setShowCloseModal(false);
        setPosCart([]);
        toast('Register closed', 'success');
      } else {
        toast('Failed to close session', 'error');
      }
    } catch {
      toast('Network error', 'error');
    }
    setClosingSession(false);
  }

  /* ── Cart handlers ───────────────────────────────────────────── */
  function addToPos(productId: number) {
    const stock = getStock(productId);
    setPosCart(prev => {
      const existing = prev.find(i => i.id === productId);
      if (existing) {
        if (existing.qty >= stock) { toast(`Only ${stock} in stock`, 'warning'); return prev; }
        return prev.map(i => i.id === productId ? { ...i, qty: i.qty + 1 } : i);
      }
      if (stock <= 0) { toast('Out of stock', 'warning'); return prev; }
      return [...prev, { id: productId, qty: 1 }];
    });
  }

  function changeQty(productId: number, delta: number) {
    setPosCart(prev =>
      prev.map(i => i.id === productId ? { ...i, qty: Math.max(0, i.qty + delta) } : i)
          .filter(i => i.qty > 0)
    );
  }

  // Scan a barcode → if the product is registered to THIS store, drop it
  // straight into the cart. Matches barcode first, then SKU as a fallback.
  function handleScan(code: string) {
    const bc = code.trim();
    if (!bc) return;
    const storeProducts = myScoped ? products.filter(p => myIds.has(p.id)) : products;
    const match = storeProducts.find(p =>
      ((p as typeof p & { barcode?: string }).barcode ?? '') === bc || p.sku === bc
    );
    if (match) {
      addToPos(match.id);
      toast(`Added ${match.name}`, 'success');
      return;
    }
    // Known product, but not one this store sells.
    const elsewhere = products.find(p => ((p as typeof p & { barcode?: string }).barcode ?? '') === bc);
    if (elsewhere) {
      toast(`${elsewhere.name} isn’t in your store yet`, 'warning');
      return;
    }
    toast('No product matches that barcode', 'error');
  }

  /* ── Park / hold handlers ────────────────────────────────────── */
  function parkCart() {
    if (!posCart.length) return;
    const id    = Date.now().toString(36);
    const label = `Sale #${parkedCarts.length + 1} (${posItemCount} item${posItemCount !== 1 ? 's' : ''})`;
    const next  = [...parkedCarts, { id, label, savedAt: new Date().toISOString(), items: posCart }];
    setParkedCarts(next);
    writeParked(next);
    setPosCart([]);
    toast(`Cart parked — "${label}"`, 'default');
  }

  /**
   * Print the current list WITHOUT selling anything.
   *
   * For the quote a customer asks for before deciding, or a picking slip for
   * the back room. Deliberately not a sale: no order is created, so no order
   * number and no QR are printed — a number that resolves to nothing on the
   * order page is worse than no number at all. Nothing is deducted from stock
   * and the cart is left exactly as it was, so the cashier can carry straight
   * on to Pay.
   */
  function printCart() {
    if (!posCart.length) return;
    setLastOrderId('');
    setPrintOnly(true);
    setReceiptData({
      items:    [...posCart],
      name:     checkoutName.trim(),
      subtotal: posTotal,
      discount: 0,
      total:    posTotal,
      method:   '—',
    });
    setShowReceipt(true);
  }

  function recallCart(parkedId: string) {
    const parked = parkedCarts.find(c => c.id === parkedId);
    if (!parked) return;
    setPosCart(parked.items);
    const next = parkedCarts.filter(c => c.id !== parkedId);
    setParkedCarts(next);
    writeParked(next);
    setShowParked(false);
    toast('Cart recalled', 'success');
  }

  function deleteParked(parkedId: string) {
    const next = parkedCarts.filter(c => c.id !== parkedId);
    setParkedCarts(next);
    writeParked(next);
  }

  /* ── Checkout handlers ───────────────────────────────────────── */
  function openCheckout() {
    if (!posCart.length) return;
    setPosDiscount('');
    setSplits([{ method: posSettings.defaultPayment, amount: posTotal.toFixed(2) }]);
    // When Settings require a customer name, don't pre-fill the placeholder —
    // the cashier must type a real one.
    setCheckoutName(posSettings.requireCustomerName ? '' : 'Walk-in Customer');
    setCheckoutPhone('');
    setInvoiceCustomerId('');
    setShowCheckout(true);
    // Credit customers this store can invoice (owner session only)
    if (currentSupplier && customers.length === 0) {
      (async () => {
        try {
          const res = await fetch(`/api/customers?supplierId=${currentSupplier.id}`, { headers: await authHeaders() });
          const d = await res.json();
          if (Array.isArray(d)) setCustomers(d);
        } catch { /* invoicing simply stays hidden */ }
      })();
    }
  }

  async function handlePlaceOrder() {
    if (placingOrder) return;
    if (posSettings.requireCustomerName && !checkoutName.trim()) {
      toast('Customer name is required (Settings → Point of Sale)', 'error');
      return;
    }
    if (splitTotal < posNet - 0.01) {
      toast(`Still owed $${(posNet - splitTotal).toFixed(2)} — add more payment`, 'error');
      return;
    }

    const payMethod = splits.length === 1
      ? splits[0].method
      : splits.map(s => s.method).join('+');

    const notesParts: string[] = [];
    if (posDiscountNum > 0)
      notesParts.push(`Discount: $${posDiscountNum.toFixed(2)}`);
    if (splits.length > 1)
      notesParts.push(`Split: ${splits.map(s => `${s.method} $${s.amount}`).join(', ')}`);
    if (changeDue > 0.01)
      notesParts.push(`Change: $${changeDue.toFixed(2)}`);

    const orderPayload: Record<string, unknown> = {
      customerName:  checkoutName.trim() || 'Walk-in Customer',
      customerPhone: checkoutPhone.trim() || '',
      userId:        user?.id ?? null,
      items:         posCart.map(i => ({ id: i.id, qty: i.qty })),
      paymentMethod: payMethod,
      discount:      posDiscountNum,               // manual staff discount (server clamps + verifies staff)
      // A LOCAL (offline) register has no DB session row, so send no session_id
      // — the sale still counts as in-store via the cashier name.
      sessionId:     session && session !== 'loading' && !session.local ? session.id   : null,
      cashierName:   session && session !== 'loading' ? session.cashierName : null,
      supplierId:    currentSupplier?.id ?? null,   // this register's store (dashboard attribution)
      notes:         notesParts.length ? notesParts.join(' | ') : null,
      // An over-the-counter sale is DONE the moment it's paid — the goods have
      // already been handed over, so there is nothing to fulfil later. Leaving
      // it 'pending' made every POS sale look like outstanding work.
      status:        'completed',
      // ...and nobody needs alerting about a sale the cashier just rang up in
      // front of them. Silences the in-app notification and the push.
      silent:        true,
    };

    setPlacingOrder(true);
    let order: { id: string; total: number } | null = null;
    try {
      // Auth header so the server can verify a staff discount (a public/guest
      // order can never send a manual discount — it would zero out the total).
      const res = await fetch('/api/orders', {
        method: 'POST', headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(orderPayload),
      });
      if (res.ok) {
        order = await res.json();
      } else {
        const err = await res.json().catch(() => null);
        toast(err?.error ?? 'Order failed', 'error');
      }
    } catch {
      // Offline — queue for later sync
      const localId = enqueueOrder(orderPayload);
      toast(`Offline — sale queued (${localId.slice(0, 12)})`, 'warning');
      order = { id: localId, total: posNet };
    }
    setPlacingOrder(false);

    if (order) {
      const snapshot = [...posCart];
      setLastOrderId(order.id);
      setReceiptData({
        items:    snapshot,
        name:     checkoutName.trim() || 'Walk-in Customer',
        subtotal: posTotal,
        discount: posDiscountNum,
        total:    order.total,
        method:   payMethod,
      });
      setPosCart([]);
      setShowCheckout(false);
      setShowReceipt(true);
      reloadProducts();
    }
  }

  /* ── Invoice the sale to a credit customer (pay later) ─────────
     Places the order (stock moves, sale is recorded) with payment method
     'invoice', then opens a receivable on the customer's ledger — the
     balance shows on the Customers page until they pay it off. */
  async function handleInvoiceSale() {
    if (invoicing || !posCart.length) return;
    const customer = customers.find(c => c.id === invoiceCustomerId);
    if (!customer) { toast('Choose a customer to invoice', 'error'); return; }
    if (!currentSupplier) { toast('Invoicing needs the store owner account', 'error'); return; }

    setInvoicing(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName:  customer.name,
          customerPhone: customer.phone,
          userId:        user?.id ?? null,
          items:         posCart.map(i => ({ id: i.id, qty: i.qty })),
          paymentMethod: 'invoice',
          status:        'completed',
          sessionId:     session && session !== 'loading' && !session.local ? session.id : null,
          cashierName:   session && session !== 'loading' ? session.cashierName : null,
          supplierId:    currentSupplier.id,
          notes:         `Invoiced to ${customer.name} — pay later`,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast(err?.error ?? 'Could not place the order', 'error');
        setInvoicing(false);
        return;
      }
      const order = await res.json() as { id: string; total: number };

      const invRes = await fetch('/api/invoices', {
        method: 'POST', headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          supplierId:   currentSupplier.id,
          customerId:   customer.id,
          customerName: customer.name,
          items: posCart.map(i => {
            const p = products.find(x => x.id === i.id);
            return { id: i.id, name: p?.name ?? `#${i.id}`, price: p?.price ?? 0, qty: i.qty };
          }),
          discount: 0,
          orderId:  order.id,
          notes:    'POS credit sale',
        }),
      });
      if (!invRes.ok) {
        const err = await invRes.json().catch(() => null);
        toast(err?.error ?? 'Order placed but the invoice was not recorded', 'warning');
      } else {
        toast(`Invoiced to ${customer.name} ✓`, 'success');
      }

      const snapshot = [...posCart];
      setLastOrderId(order.id);
      setReceiptData({
        items:    snapshot,
        name:     customer.name,
        subtotal: posTotal,
        discount: 0,
        total:    order.total,
        method:   'invoice',
      });
      setPosCart([]);
      setShowCheckout(false);
      setShowReceipt(true);
      reloadProducts();
    } catch {
      toast('Network error — nothing was recorded', 'error');
    }
    setInvoicing(false);
  }

  /* ── Render: loading ─────────────────────────────────────────── */
  if (session === 'loading') {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-light)' }}>Loading…</div>
      </div>
    );
  }

  /** Leaving the receipt always clears the print-only flag, so the next
   *  receipt can't inherit it and silently drop a real order's number. */
  function closeReceipt() {
    setShowReceipt(false);
    setReceiptData(null);
    setPrintOnly(false);
  }

  /* ── Render: receipt ─────────────────────────────────────────── */
  if (showReceipt && receiptData) {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <Receipt
          /* No id on a plain print — that is what suppresses the order line
             and the QR inside Receipt. */
          orderId={printOnly ? undefined : lastOrderId}
          businessName={currentSupplier?.name}
          businessIcon={currentSupplier?.icon}
          customerName={receiptData.name}
          paymentMethod={receiptData.method}
          items={receiptData.items}
          products={products}
          subtotal={receiptData.subtotal}
          discount={receiptData.discount}
          total={receiptData.total}
          /* A print the cashier asked for goes straight to the dialog. */
          autoPrint={printOnly ? true : posSettings.autoPrint}
          showQr={receiptCfg.receiptQr}
          merchantNumber={receiptCfg.merchantNumber}
          headerLines={[receiptCfg.receiptHeader1, receiptCfg.receiptHeader2, receiptCfg.receiptHeader3]
            .map(l => l.trim()).filter(Boolean)}
          onClose={closeReceipt}
        />
        <div style={{ padding: '0 16px 80px' }}>
          <button
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 8 }}
            onClick={closeReceipt}
          >
            {/* A plain print left the sale untouched, so the cashier is going
                back to it — not starting a new one. */}
            {printOnly ? '← Back to the sale' : '✚ New Sale'}
          </button>
        </div>
      </div>
    );
  }

  /* ── Render: no session → gate ───────────────────────────────── */
  if (session === null) {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div className="empty-state" style={{ marginTop: 80 }}>
          <div className="empty-icon">🖥️</div>
          <div className="empty-title">Register is closed</div>
          <div className="empty-sub">Open the register to start selling</div>
          <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => setShowOpenModal(true)}>
            Open Register
          </button>
          <div style={{ marginTop: 12 }}><OfflineBadge /></div>
        </div>

        {showOpenModal && (
          <div className="modal-overlay" onClick={() => setShowOpenModal(false)}>
            <div className="modal-box" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                🖥️ Open Register
                <button className="modal-close" onClick={() => setShowOpenModal(false)}>✕</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Cashier name</label>
                  <input className="form-input" value={cashierName} onChange={e => setCashierName(e.target.value)} placeholder="Your name" />
                </div>
                <div className="form-group">
                  <label className="form-label">Opening cash float ($)</label>
                  <input className="form-input" type="number" min="0" step="0.01" value={openingFloat} onChange={e => setOpeningFloat(e.target.value)} placeholder="0.00" />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowOpenModal(false)}>Cancel</button>
                  <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleOpenSession} disabled={openingSession}>
                    {openingSession ? 'Opening…' : 'Open Register'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ── Render: main POS ────────────────────────────────────────── */
  return (
    <div className="page-anim" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 68px)' }}>
      <Header showSearch={false} />

      {/* Session banner */}
      <div className="pos-session-banner">
        <span>🖥️ <strong>{session.cashierName}</strong> · {sessionAge} open</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <OfflineBadge />
          {parkedCarts.length > 0 && (
            <button className="btn btn-sm" style={{ background: 'rgba(255,255,255,.2)', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}
              onClick={() => setShowParked(true)}>
              ⏸ Held ({parkedCarts.length})
            </button>
          )}
          <button className="btn btn-sm" style={{ background: 'rgba(255,255,255,.15)', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}
            onClick={openCloseModal}>
            Close Register
          </button>
        </div>
      </div>

      <div className="page-title-bar">
        <span className="page-title">🖥️ Point of Sale</span>
        {currentSupplier && (
          <span className="pos-store-tag">🏪 {currentSupplier.name}</span>
        )}
        {/* The one control that opens the sale panel. It doubles as the running
            total, so a cashier can see the sale even with the panel closed. */}
        <button
          className={`pos-sale-toggle${saleOpen ? ' is-open' : ''}`}
          onClick={() => setSaleOpen(o => !o)}
          aria-expanded={saleOpen}
          aria-controls="pos-sale-panel"
        >
          🧾 Sale
          {posCart.length > 0 && <span className="pos-sale-toggle-count">{posItemCount}</span>}
          <span className="pos-sale-toggle-total">${posTotal.toFixed(2)}</span>
        </button>
      </div>

      {/* Two columns: products on the left, the sale on the right. */}
      <div className="pos-body">
        <div className="pos-main">
          <div className="pos-search-bar" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="pos-search-input" style={{ flex: 1 }} placeholder="Search by name, SKU or barcode…"
              value={search} onChange={e => setSearch(e.target.value)} />
            <button className="btn btn-secondary btn-sm" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
              onClick={() => setScanOpen(true)} title="Scan a barcode to add to the sale">
              📷 Scan
            </button>
          </div>

          {/* Nothing to filter with a single category — "All" and that one chip
              select the same products — so the row only earns its space at two. */}
          {availableCategories.length > 1 && (
            <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
              <div className="chips-row">
                <button className={`chip ${activeCategory === 'all' ? 'active' : ''}`} onClick={() => setActiveCategory('all')}>All</button>
                {availableCategories.map(cat => (
                  <button key={cat.id} className={`chip ${activeCategory === cat.id ? 'active' : ''}`}
                    onClick={() => setActiveCategory(cat.id)}>
                    {cat.icon} {cat.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Product grid */}
          <div className="pos-products">
            {loading ? (
              <div className="pos-grid">
                {Array.from({ length: 9 }).map((_, i) => (
                  <div key={i} className="pos-item">
                    <div className="skeleton" style={{ width: 48, height: 48, borderRadius: 8 }} />
                    <div className="skeleton" style={{ height: 12, width: '80%', borderRadius: 6 }} />
                    <div className="skeleton" style={{ height: 12, width: '50%', borderRadius: 6 }} />
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">{search.trim() ? '🔍' : '🏪'}</div>
                <div className="empty-title">{search.trim() ? 'No products found' : 'No products in your store yet'}</div>
              </div>
            ) : (
              <div className="pos-grid">
                {filtered.map(p => {
                  const stock  = getStock(p.id);
                  const inCart = posCart.find(i => i.id === p.id)?.qty ?? 0;
                  return (
                    <div key={p.id} className={`pos-item${inCart > 0 ? ' pos-in-cart' : ''}`}
                      onClick={() => stock > 0 && addToPos(p.id)}
                      style={stock === 0 ? { opacity: 0.5, pointerEvents: 'none' } : {}}>
                      {inCart > 0 && <span className="pos-item-badge">{inCart}</span>}
                      <div className="pos-item-icon">
                        <ProductImage imageUrl={p.imageUrl} imageUrls={p.imageUrls} name={p.name} style={{ borderRadius: 8 }} />
                      </div>
                      <span className="pos-item-name">{p.name}</span>
                      <span className="pos-item-price">${p.price.toFixed(2)}</span>
                      <span className="pos-item-stock">{stock === 0 ? 'Out of stock' : `${stock} in stock`}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── The sale ─────────────────────────────────────────────────
            On a phone this is an overlay over the grid; from 900px up it is a
            real column beside it. Either way the same markup, so there is only
            one implementation of the running sale to keep correct. */}
        <aside id="pos-sale-panel" className={`pos-side${saleOpen ? ' open' : ''}`} aria-label="Current sale">
          <div className="pos-side-head">
            <span className="pos-side-title">🧾 Current sale</span>
            <button className="pos-side-close" onClick={() => setSaleOpen(false)} aria-label="Close the sale panel">
              ✕
            </button>
          </div>

          {posCart.length === 0 ? (
            <div className="pos-side-empty">
              <div style={{ fontSize: 30, marginBottom: 8 }}>🛒</div>
              Tap a product to start a sale.
            </div>
          ) : (
            <div className="pos-side-items">
              {posCart.map(i => {
                const p = products.find(x => x.id === i.id);
                return (
                  <div key={i.id} className="pos-side-item">
                    <div className="pos-side-item-top">
                      <span className="pos-cart-item-name">{p?.name ?? `#${i.id}`}</span>
                      <span className="pos-cart-item-total">${((p?.price ?? 0) * i.qty).toFixed(2)}</span>
                    </div>
                    <div className="pos-side-item-bottom">
                      <span className="pos-side-unit">${(p?.price ?? 0).toFixed(2)} each</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button className="pos-qty-btn" onClick={() => changeQty(i.id, -1)} aria-label={`One fewer ${p?.name ?? 'item'}`}>−</button>
                        <span style={{ minWidth: 20, textAlign: 'center', fontWeight: 700 }}>{i.qty}</span>
                        <button className="pos-qty-btn" onClick={() => changeQty(i.id, 1)} aria-label={`One more ${p?.name ?? 'item'}`}>+</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="pos-side-foot">
            <div className="pos-side-total-row">
              <span>Total</span>
              <span className="pos-cart-total">${posTotal.toFixed(2)}</span>
            </div>
            <div className="pos-side-actions">
              <button className="btn btn-sm btn-secondary" disabled={posCart.length === 0} onClick={parkCart}>⏸ Park</button>
              <button className="btn btn-sm btn-secondary" disabled={posCart.length === 0} onClick={printCart}
                title="Print this list — no sale is recorded">
                🖨️ Print
              </button>
            </div>
            <button className="btn btn-primary btn-full" disabled={posCart.length === 0} onClick={openCheckout}>
              Pay ${posTotal.toFixed(2)} →
            </button>
          </div>
        </aside>

        {/* Phone-only scrim; the panel is a column on desktop so it needs none. */}
        {saleOpen && <div className="pos-side-scrim" onClick={() => setSaleOpen(false)} />}
      </div>

      {/* ── Parked carts modal ── */}
      {showParked && (
        <div className="modal-overlay" onClick={() => setShowParked(false)}>
          <div className="modal-box" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              ⏸ Held Sales
              <button className="modal-close" onClick={() => setShowParked(false)}>✕</button>
            </div>
            <div className="modal-body">
              {parkedCarts.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-light)', padding: '20px 0' }}>No held sales</div>
              ) : parkedCarts.map(c => (
                <div key={c.id} className="pos-parked-row">
                  <div>
                    <div style={{ fontWeight: 600 }}>{c.label}</div>
                    <div style={{ fontSize: '.8rem', color: 'var(--text-light)' }}>{new Date(c.savedAt).toLocaleTimeString()}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-sm btn-primary" onClick={() => recallCart(c.id)}>Recall</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => deleteParked(c.id)}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Checkout modal ── */}
      {showCheckout && (
        <div className="modal-overlay" onClick={() => setShowCheckout(false)}>
          <div className="modal-box pos-checkout-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              💳 Payment — ${posTotal.toFixed(2)}
              <button className="modal-close" onClick={() => setShowCheckout(false)}>✕</button>
            </div>
            <div className="modal-body">
              {/* Cart summary */}
              <div className="pos-checkout-items">
                {posCart.map(i => {
                  const p = products.find(x => x.id === i.id);
                  return (
                    <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.88rem', marginBottom: 4 }}>
                      <span>{p?.name ?? `#${i.id}`} × {i.qty}</span>
                      <span>${((p?.price ?? 0) * i.qty).toFixed(2)}</span>
                    </div>
                  );
                })}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8, display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '.88rem' }}>
                  <span>Subtotal</span><span>${posTotal.toFixed(2)}</span>
                </div>
                {posDiscountNum > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '.88rem', marginTop: 2 }}>
                    <span>Discount</span><span>−${posDiscountNum.toFixed(2)}</span>
                  </div>
                )}
                <div style={{ paddingTop: 6, marginTop: 4, fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Total</span><span>${posNet.toFixed(2)}</span>
                </div>
              </div>

              {/* Customer */}
              <div className="form-group">
                <label className="form-label">Customer name</label>
                <input className="form-input" value={checkoutName} onChange={e => setCheckoutName(e.target.value)} placeholder="Walk-in Customer" />
              </div>

              {/* Manual discount ($ off the subtotal) */}
              <div className="form-group">
                <label className="form-label">Discount ($)</label>
                <input className="form-input" type="number" min="0" step="0.01" max={posTotal}
                  value={posDiscount}
                  onChange={e => setPosDiscount(e.target.value)}
                  placeholder="0.00" />
              </div>

              {/* Payment splits */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, fontSize: '.9rem' }}>Payment</div>
                {splits.map((sp, idx) => (
                  <div key={idx} className="pos-split-row">
                    <select className="form-input" style={{ flex: '0 0 120px' }}
                      value={sp.method}
                      onChange={e => setSplits(prev => prev.map((s, i) => i === idx ? { ...s, method: e.target.value as PaymentMethod } : s))}>
                      <option value="cash">💵 Cash</option>
                      <option value="waafi">📱 Waafi</option>
                      <option value="card">💳 Card</option>
                    </select>
                    <input className="form-input" type="number" min="0" step="0.01"
                      value={sp.amount} placeholder="Amount" style={{ flex: 1 }}
                      onChange={e => setSplits(prev => prev.map((s, i) => i === idx ? { ...s, amount: e.target.value } : s))} />
                    {splits.length > 1 && (
                      <button className="btn btn-sm btn-secondary"
                        onClick={() => setSplits(prev => prev.filter((_, i) => i !== idx))}>✕</button>
                    )}
                  </div>
                ))}

                {splits.length < 3 && (
                  <button className="btn btn-sm btn-secondary" style={{ marginTop: 4 }}
                    onClick={() => setSplits(prev => [...prev, {
                      method: 'cash',
                      amount: Math.max(0, posNet - splitTotal).toFixed(2),
                    }])}>
                    + Split payment
                  </button>
                )}

                {changeDue > 0.01 && (
                  <div className="pos-change-display">
                    💵 Change due: <strong>${changeDue.toFixed(2)}</strong>
                  </div>
                )}
                {splitTotal > 0 && splitTotal < posNet - 0.01 && (
                  <div className="pos-short-display">
                    Still owed: <strong>${(posNet - splitTotal).toFixed(2)}</strong>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCheckout(false)}>Back</button>
                <button className="btn btn-primary" style={{ flex: 1 }}
                  onClick={handlePlaceOrder}
                  disabled={placingOrder || invoicing || splitTotal < posNet - 0.01}>
                  {placingOrder ? 'Processing…' : `Charge $${posNet.toFixed(2)}`}
                </button>
              </div>

              {/* Invoice to a credit customer — no payment now, balance
                  lands on their ledger in the Customers page */}
              {currentSupplier && customers.length > 0 && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 8, fontSize: '.9rem' }}>📋 Or invoice a customer (pay later)</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select className="form-input" style={{ flex: 1 }}
                      value={invoiceCustomerId}
                      onChange={e => setInvoiceCustomerId(e.target.value)}>
                      <option value="">Select customer…</option>
                      {customers.map(c => (
                        <option key={c.id} value={c.id}>{c.name}{c.phone ? ` — ${c.phone}` : ''}</option>
                      ))}
                    </select>
                    <button className="btn btn-secondary"
                      onClick={handleInvoiceSale}
                      disabled={invoicing || placingOrder || !invoiceCustomerId}>
                      {invoicing ? '…' : `Invoice $${posTotal.toFixed(2)}`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Close session modal ── */}
      {showCloseModal && (
        <div className="modal-overlay" onClick={() => setShowCloseModal(false)}>
          <div className="modal-box" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              🏦 Close Register
              <button className="modal-close" onClick={() => setShowCloseModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              {sessionReport ? (
                <div className="pos-zreport">
                  <div className="pos-zreport-row">
                    <span>Orders this session</span>
                    <strong>{sessionReport.totalOrders}</strong>
                  </div>
                  <div className="pos-zreport-row">
                    <span>Total revenue</span>
                    <strong>${sessionReport.totalRevenue.toFixed(2)}</strong>
                  </div>
                  <div className="pos-zreport-row">
                    <span>Cash sales</span>
                    <strong>${sessionReport.cashRevenue.toFixed(2)}</strong>
                  </div>
                  <div className="pos-zreport-row">
                    <span>Opening float</span>
                    <strong>${session.openingFloat.toFixed(2)}</strong>
                  </div>
                  <div className="pos-zreport-row pos-zreport-total">
                    <span>Expected in drawer</span>
                    <strong>${sessionReport.expectedCash.toFixed(2)}</strong>
                  </div>
                </div>
              ) : (
                <div className="skeleton" style={{ height: 130, borderRadius: 10, marginBottom: 16 }} />
              )}

              <div className="form-group">
                <label className="form-label">Count your cash drawer ($)</label>
                <input className="form-input" type="number" min="0" step="0.01"
                  value={closingCounted} onChange={e => setClosingCounted(e.target.value)} placeholder="0.00" />
              </div>

              {sessionReport && closingCounted !== '' && (() => {
                const counted  = parseFloat(closingCounted) || 0;
                const diff     = counted - sessionReport.expectedCash;
                const isOver   = diff >= 0;
                const diffAbs  = Math.abs(diff);
                return diffAbs > 0.01 ? (
                  <div className={`pos-discrepancy ${isOver ? 'pos-discrepancy-ok' : 'pos-discrepancy-warn'}`}>
                    {isOver ? `+$${diffAbs.toFixed(2)} over` : `-$${diffAbs.toFixed(2)} short`}
                  </div>
                ) : (
                  <div className="pos-discrepancy pos-discrepancy-ok">✓ Cash matches exactly</div>
                );
              })()}

              <div className="form-group">
                <label className="form-label">Notes (optional)</label>
                <input className="form-input" value={closeNotes} onChange={e => setCloseNotes(e.target.value)} placeholder="e.g. Smooth shift" />
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCloseModal(false)}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCloseSession} disabled={closingSession}>
                  {closingSession ? 'Closing…' : 'Close Register'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Scan-to-add barcode scanner ── */}
      {scanOpen && (
        <BarcodeScanner
          title="Scan to add to sale"
          onDetected={code => handleScan(code)}
          onClose={() => setScanOpen(false)}
        />
      )}
    </div>
  );
}
