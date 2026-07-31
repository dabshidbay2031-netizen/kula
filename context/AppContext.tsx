'use client';

import React, { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useLiveRefresh } from '@/lib/useLiveRefresh';
import { useRealtimePing } from '@/lib/useRealtimePing';
import type { CartItem, Notification, Order, Product, Supplier, Toast, PaymentMethod, PaymentState } from '@/lib/types';

interface InventoryItem { id: number; stock: number; }

/* Cache keys — data is stale-while-revalidated on every mount */
const CACHE = {
  products:      'mg_c_products',
  suppliers:     'mg_c_suppliers',
  notifications: 'mg_c_notifications',
};

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}
function writeCache(key: string, data: unknown) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* storage full */ }
}

/* ETag per endpoint from the last 200 response. The live poll re-fetches the
   full catalog (~500 KB) every 15 s; sending If-None-Match lets the server
   reply 304 so unchanged payloads are never re-downloaded, re-dispatched
   (full grid re-render), or re-written to localStorage. */
const etags: Record<string, string> = {};

/** Fetch that resolves to undefined when the server says the data is unchanged (304). */
async function fetchIfChanged(url: string, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (etags[url]) headers['If-None-Match'] = etags[url];
  const res = await fetch(url, { cache: 'no-store', headers, signal });
  if (res.status === 304) return undefined;
  const tag = res.headers.get('etag');
  if (tag) etags[url] = tag;
  return res.json();
}

interface AppState {
  products:      Product[];
  suppliers:     Supplier[];
  orders:        Order[];
  cart:          CartItem[];
  wishlist:      number[];
  inventory:     InventoryItem[];
  notifications: Notification[];
  paymentMethod: PaymentMethod;
  paymentState:  PaymentState;
  discount:      number;
  toasts:        Toast[];
  cartOpen:      boolean;
  loading:       boolean;
}

type Action =
  | { type: 'SET_PRODUCTS';      payload: Product[] }
  | { type: 'SET_SUPPLIERS';     payload: Supplier[] }
  | { type: 'SET_ORDERS';        payload: Order[] }
  | { type: 'SET_CART';          payload: CartItem[] }
  | { type: 'SET_WISHLIST';      payload: number[] }
  | { type: 'SET_INVENTORY';     payload: InventoryItem[] }
  | { type: 'SET_STOCK';         payload: InventoryItem }
  | { type: 'SET_NOTIFICATIONS'; payload: Notification[] }
  | { type: 'SET_PAYMENT_METHOD';payload: PaymentMethod }
  | { type: 'SET_PAYMENT_STATE'; payload: PaymentState }
  | { type: 'SET_DISCOUNT';      payload: number }
  | { type: 'ADD_TOAST';         payload: Toast }
  | { type: 'REMOVE_TOAST';      payload: string }
  | { type: 'SET_CART_OPEN';     payload: boolean }
  | { type: 'SET_LOADING';       payload: boolean };

const initial: AppState = {
  products: [], suppliers: [], orders: [],
  cart: [], wishlist: [], inventory: [],
  notifications: [],
  paymentMethod: 'waafi', paymentState: 'idle',
  discount: 0, toasts: [],
  cartOpen: false,
  loading: true,  // becomes false as soon as loadFresh() resolves or 8s timeout fires
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_PRODUCTS':      return { ...state, products:      action.payload };
    case 'SET_SUPPLIERS':     return { ...state, suppliers:     action.payload };
    case 'SET_ORDERS':        return { ...state, orders:        action.payload };
    case 'SET_CART':          return { ...state, cart:          action.payload };
    case 'SET_WISHLIST':      return { ...state, wishlist:      action.payload };
    case 'SET_INVENTORY':     return { ...state, inventory:     action.payload };
    case 'SET_STOCK':         return {
      ...state,
      inventory: state.inventory.map(i =>
        i.id === action.payload.id ? { ...i, stock: action.payload.stock } : i),
    };
    case 'SET_NOTIFICATIONS': return { ...state, notifications: action.payload };
    case 'SET_PAYMENT_METHOD':return { ...state, paymentMethod: action.payload };
    case 'SET_PAYMENT_STATE': return { ...state, paymentState:  action.payload };
    case 'SET_DISCOUNT':      return { ...state, discount:      action.payload };
    case 'ADD_TOAST':         return { ...state, toasts: [...state.toasts, action.payload] };
    case 'REMOVE_TOAST':      return { ...state, toasts: state.toasts.filter(t => t.id !== action.payload) };
    case 'SET_CART_OPEN':     return { ...state, cartOpen:      action.payload };
    case 'SET_LOADING':       return { ...state, loading:       action.payload };
    default: return state;
  }
}

interface AppContextValue {
  state: AppState;
  addToCart:         (productId: number, qty?: number) => void;
  removeFromCart:    (productId: number) => void;
  changeQty:         (productId: number, delta: number) => void;
  clearCart:         () => void;
  cartCount:         () => number;
  cartTotal:         () => number;
  setCartOpen:       (open: boolean) => void;
  toggleWishlist:    (productId: number) => void;
  getStock:          (productId: number) => number;
  adjustStock:       (productId: number, delta: number) => void;
  markAllRead:       () => void;
  clearNotifications:() => void;
  unreadCount:       () => number;
  setPaymentMethod:  (m: PaymentMethod) => void;
  setPaymentState:   (s: PaymentState) => void;
  setDiscount:       (d: number) => void;
  toast:             (message: string, type?: Toast['type']) => void;
  reloadProducts:      () => Promise<void>;
  reloadSuppliers:     () => Promise<void>;
  loadWishlistFromDB:  (userId: string) => Promise<void>;
  /** True once the DB wishlist has been merged after login — gate for pushing sync writes */
  wishlistLoaded:      boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Mirrors state.toasts for the toast() callback below (kept stable with []
  // deps) so repeated triggers can find/refresh an existing toast instead of
  // reading a stale closure.
  const toastsRef = useRef(state.toasts);
  useEffect(() => { toastsRef.current = state.toasts; }, [state.toasts]);
  const [wishlistLoaded, setWishlistLoaded] = React.useState(false);

  // The signed-in seller's own store id, if any. A business/supplier must not
  // be able to buy products their own store sells (self-purchase). Held in a
  // ref so addToCart can read it without widening its dependency list.
  const { currentSupplier, user } = useAuth();
  const ownStoreIdRef = useRef<number | null>(null);
  ownStoreIdRef.current = currentSupplier?.id ?? null;

  // Notifications are user-scoped (order updates addressed to this user) plus
  // global announcements. Held in a ref so the [] deps loaders read the current
  // id without re-subscribing.
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = user?.id ?? null;
  const notifUrl = () => userIdRef.current
    ? `/api/notifications?userId=${encodeURIComponent(userIdRef.current)}`
    : '/api/notifications';

  /* ── Load data: serve cache instantly, fetch fresh in background ── */
  useEffect(() => {
    // 1. Immediately serve from cache (makes reload feel instant)
    const cachedProducts      = readCache<Product[]>     (CACHE.products);
    const cachedSuppliers     = readCache<Supplier[]>    (CACHE.suppliers);
    const cachedNotifications = readCache<Notification[]>(CACHE.notifications);

    if (cachedProducts) {
      dispatch({ type: 'SET_PRODUCTS',   payload: cachedProducts });
      dispatch({ type: 'SET_INVENTORY',  payload: cachedProducts.map(p => ({ id: p.id, stock: p.stock })) });
      dispatch({ type: 'SET_LOADING',    payload: false });  // show content immediately
    }
    if (cachedSuppliers)     dispatch({ type: 'SET_SUPPLIERS',     payload: cachedSuppliers });
    if (cachedNotifications) dispatch({ type: 'SET_NOTIFICATIONS', payload: cachedNotifications });

    // Safety timeout — never let loading spin forever
    const safetyTimer = setTimeout(() => {
      dispatch({ type: 'SET_LOADING', payload: false });
    }, 22000);

    // 2. Fetch fresh data in background (stale-while-revalidate)
    //
    // The controller and the "did we give up on purpose" flag live out here so
    // the effect's cleanup can cancel an in-flight refresh when the provider
    // unmounts. Without that, leaving the page mid-fetch left the request
    // running and its abort surfaced as a scary console error on every reload.
    const ctrl = new AbortController();
    let timedOut  = false;   // our own 20s budget fired
    let cancelled = false;   // the component went away
    // 20s budget: dev cold-compiles and slow mobile connections were
    // regularly blowing through the old 7s limit, leaving an empty
    // catalog until a manual reload.
    const timeout = setTimeout(() => { timedOut = true; ctrl.abort(); }, 20000);

    async function loadFresh() {
      try {
        const [products, suppliers, notifications] = await Promise.all([
          fetchIfChanged('/api/products',      ctrl.signal),
          fetchIfChanged('/api/suppliers',     ctrl.signal),
          fetchIfChanged(notifUrl(),           ctrl.signal),
        ]);
        clearTimeout(timeout);

        // Always update products from DB — even empty array clears stale cache
        if (Array.isArray(products)) {
          dispatch({ type: 'SET_PRODUCTS',  payload: products });
          dispatch({ type: 'SET_INVENTORY', payload: products.map((p: Product) => ({ id: p.id, stock: p.stock })) });
          if (products.length) writeCache(CACHE.products, products);
          else { try { localStorage.removeItem(CACHE.products); } catch { /* ignore */ } }
        }
        if (Array.isArray(suppliers)) {
          dispatch({ type: 'SET_SUPPLIERS', payload: suppliers });
          if (suppliers.length) writeCache(CACHE.suppliers, suppliers);
          else { try { localStorage.removeItem(CACHE.suppliers); } catch { /* ignore */ } }
        }
        if (Array.isArray(notifications)) {
          dispatch({ type: 'SET_NOTIFICATIONS', payload: notifications });
          writeCache(CACHE.notifications, notifications);
        }
      } catch (err) {
        // An abort is something WE caused, not a fault to shout about:
        //   • cancelled → the user navigated away mid-refresh. Nothing to say.
        //   • timedOut  → the 20s budget elapsed. The cached catalog is still on
        //     screen, so this is a degraded refresh, not a failure — warn, don't
        //     error, and say what actually happened.
        // Anything else is a real fetch failure and still logs as an error.
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (aborted && cancelled) return;
        if (aborted && timedOut) {
          console.warn('[AppContext] refresh timed out after 20s — showing cached data');
        } else if (!aborted) {
          console.error('[AppContext] data fetch failed:', err);
        }
      } finally {
        clearTimeout(timeout);
        clearTimeout(safetyTimer);
        // Don't touch state after unmount — the spinner is gone with the tree.
        if (!cancelled) dispatch({ type: 'SET_LOADING', payload: false });
      }
    }
    loadFresh();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      clearTimeout(safetyTimer);
      ctrl.abort();
    };
  }, []);

  /* ── Persist cart + wishlist ─────────────────────────────── */
  useEffect(() => {
    const cart     = readCache<CartItem[]>('mg_cart');
    const wishlist = readCache<number[]>  ('mg_wishlist');
    if (cart)     dispatch({ type: 'SET_CART',     payload: cart });
    if (wishlist) dispatch({ type: 'SET_WISHLIST', payload: wishlist });
  }, []);
  useEffect(() => { writeCache('mg_cart',     state.cart);     }, [state.cart]);
  useEffect(() => { writeCache('mg_wishlist', state.wishlist); }, [state.wishlist]);

  /* ── Toast ───────────────────────────────────────────────── */
  // Triggering the SAME message+type repeatedly (rapid "Add to Cart" clicks, a
  // retried failing action, etc.) must not pile up a stack of duplicate
  // bubbles — refresh the existing one's timer instead of adding another.
  const toast = useCallback((message: string, type: Toast['type'] = 'default') => {
    const dup = toastsRef.current.find(t => t.message === message && t.type === type);
    const id  = dup?.id ?? `${Date.now()}-${Math.random()}`;

    const oldTimer = toastTimers.current.get(id);
    if (oldTimer) clearTimeout(oldTimer);

    if (!dup) dispatch({ type: 'ADD_TOAST', payload: { id, message, type } });

    const timer = setTimeout(() => {
      dispatch({ type: 'REMOVE_TOAST', payload: id });
      toastTimers.current.delete(id);
    }, 3000);
    toastTimers.current.set(id, timer);
  }, []);

  /* ── Helpers ─────────────────────────────────────────────── */
  const getStock  = useCallback((id: number) => state.inventory.find(i => i.id === id)?.stock ?? 0, [state.inventory]);
  const cartCount = useCallback(() => state.cart.reduce((n, i) => n + i.qty, 0), [state.cart]);
  const cartTotal = useCallback(() =>
    state.cart.reduce((n, item) => {
      const p = state.products.find(x => x.id === item.id);
      return n + (p ? p.price * item.qty : 0);
    }, 0),
  [state.cart, state.products]);

  /* ── Cart ────────────────────────────────────────────────── */
  const addToCart = useCallback((productId: number, qty = 1) => {
    // Block self-purchase: a seller can't buy products their own store sells.
    const prod = state.products.find(x => x.id === productId);
    if (prod && ownStoreIdRef.current != null && prod.supplierId === ownStoreIdRef.current) {
      toast("You can't buy products from your own store", 'error');
      return;
    }
    const stock    = state.inventory.find(i => i.id === productId)?.stock ?? 0;
    const inCart   = state.cart.find(i => i.id === productId);
    const inCartQty= inCart?.qty ?? 0;
    if (inCartQty + qty > stock) { toast('Not enough stock available', 'error'); return; }
    const updated  = inCart
      ? state.cart.map(i => i.id === productId ? { ...i, qty: i.qty + qty } : i)
      : [...state.cart, { id: productId, qty }];
    dispatch({ type: 'SET_CART', payload: updated });
    const p = state.products.find(x => x.id === productId);
    toast(p ? `${p.name} added to cart ✓` : 'Added to cart ✓', 'success');
  }, [state.cart, state.inventory, state.products, toast]);

  const removeFromCart = useCallback((id: number) =>
    dispatch({ type: 'SET_CART', payload: state.cart.filter(i => i.id !== id) }),
  [state.cart]);

  const changeQty = useCallback((productId: number, delta: number) => {
    const updated = state.cart.reduce<CartItem[]>((acc, item) => {
      if (item.id !== productId) return [...acc, item];
      const newQty = item.qty + delta;
      if (newQty <= 0) return acc;
      const stock  = state.inventory.find(i => i.id === productId)?.stock ?? 0;
      return [...acc, { ...item, qty: Math.min(newQty, stock) }];
    }, []);
    dispatch({ type: 'SET_CART', payload: updated });
  }, [state.cart, state.inventory]);

  const clearCart    = useCallback(() => dispatch({ type: 'SET_CART', payload: [] }), []);
  const setCartOpen  = useCallback((open: boolean) => dispatch({ type: 'SET_CART_OPEN', payload: open }), []);

  /* ── Wishlist (localStorage + optional DB sync) ─────────────── */
  const toggleWishlist = useCallback((id: number) => {
    const updated = state.wishlist.includes(id)
      ? state.wishlist.filter(x => x !== id)
      : [...state.wishlist, id];
    dispatch({ type: 'SET_WISHLIST', payload: updated });
  }, [state.wishlist]);

  /** Load wishlist from DB (call after user logs in) */
  const loadWishlistFromDB = useCallback(async (userId: string) => {
    try {
      const res = await fetch(`/api/wishlist?userId=${encodeURIComponent(userId)}`);
      if (res.ok) {
        const ids = await res.json();
        if (Array.isArray(ids)) {
          // One-time merge of DB + local on login
          const merged = Array.from(new Set([...state.wishlist, ...ids]));
          dispatch({ type: 'SET_WISHLIST', payload: merged });
          writeCache('mg_wishlist', merged);
        }
        // Only after a successful load may WishlistSync push writes —
        // otherwise an early empty sync would wipe the DB wishlist.
        setWishlistLoaded(true);
      }
    } catch { /* ignore — local wishlist is fine; sync stays gated */ }
  }, [state.wishlist]);

  /* ── Inventory ───────────────────────────────────────────── */
  const adjustStock = useCallback((productId: number, delta: number) => {
    // Optimistic local update
    const updated = state.inventory.map(i =>
      i.id === productId ? { ...i, stock: Math.max(0, i.stock + delta) } : i
    );
    dispatch({ type: 'SET_INVENTORY', payload: updated });
    // Send the RELATIVE change — the server applies it atomically and
    // returns the authoritative value, so concurrent sessions can't
    // overwrite each other with stale absolute numbers.
    fetch(`/api/inventory/${productId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d && typeof d.stock === 'number') {
          dispatch({ type: 'SET_STOCK', payload: { id: productId, stock: d.stock } });
        }
      })
      .catch(() => {});
  }, [state.inventory]);

  /* ── Notifications ───────────────────────────────────────── */
  const unreadCount       = useCallback(() => state.notifications.filter(n => !n.read).length, [state.notifications]);
  const clearNotifications= useCallback(() => dispatch({ type: 'SET_NOTIFICATIONS', payload: [] }), []);
  const markAllRead       = useCallback(() => {
    const updated = state.notifications.map(n => ({ ...n, read: true }));
    dispatch({ type: 'SET_NOTIFICATIONS', payload: updated });
    const ids = state.notifications.filter(n => !n.read).map(n => n.id);
    if (ids.length > 0) {
      fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, read: true }),
      }).catch(() => {});
    }
  }, [state.notifications]);

  /* ── Data reload ─────────────────────────────────────────── */
  const reloadProducts = useCallback(async () => {
    try {
      // fetchIfChanged is no-store: this also runs right after a create/edit/
      // delete, so we must bypass the catalog's s-maxage cache or we'd
      // re-read stale data. 304 (undefined) → nothing changed, skip.
      const products = await fetchIfChanged('/api/products');
      if (Array.isArray(products) && products.length) {
        dispatch({ type: 'SET_PRODUCTS',  payload: products });
        dispatch({ type: 'SET_INVENTORY', payload: products.map((p: Product) => ({ id: p.id, stock: p.stock })) });
        writeCache(CACHE.products, products);
      }
    } catch { /* ignore */ }
  }, []);

  const reloadSuppliers = useCallback(async () => {
    try {
      const suppliers = await fetchIfChanged('/api/suppliers');
      if (Array.isArray(suppliers) && suppliers.length) {
        dispatch({ type: 'SET_SUPPLIERS', payload: suppliers });
        writeCache(CACHE.suppliers, suppliers);
      }
    } catch { /* ignore */ }
  }, []);

  const reloadNotifications = useCallback(async () => {
    try {
      const data = await fetchIfChanged(notifUrl());
      if (Array.isArray(data)) {
        dispatch({ type: 'SET_NOTIFICATIONS', payload: data });
        writeCache(CACHE.notifications, data);
      }
    } catch { /* ignore */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-scope notifications whenever the signed-in user changes (login/logout).
  useEffect(() => { reloadNotifications(); }, [user?.id, reloadNotifications]);

  /* ── Live updates ──────────────────────────────────────────
     Fast path: server-broadcast realtime pings (lib/realtimeServer.ts) land
     the instant a mutation commits — no waiting on a poll cycle.
     Fallback:  a relaxed 45s poll + refetch-on-focus (useLiveRefresh) covers
     websocket drops, so the app can never go stale even if realtime dies. */
  useRealtimePing(['catalog'], () => { reloadProducts(); reloadSuppliers(); });
  useRealtimePing(['notifications'], reloadNotifications);
  useLiveRefresh(() => {
    reloadProducts();
    reloadSuppliers();
    reloadNotifications();
  }, { intervalMs: 45000 });

  /* ── Payment ─────────────────────────────────────────────── */
  const setPaymentMethod = useCallback((m: PaymentMethod) => dispatch({ type: 'SET_PAYMENT_METHOD', payload: m }), []);
  const setPaymentState  = useCallback((s: PaymentState)  => dispatch({ type: 'SET_PAYMENT_STATE',  payload: s }), []);
  const setDiscount      = useCallback((d: number)        => dispatch({ type: 'SET_DISCOUNT',        payload: d }), []);

  return (
    <AppContext.Provider value={{
      state,
      addToCart, removeFromCart, changeQty, clearCart, cartCount, cartTotal, setCartOpen,
      toggleWishlist,
      getStock, adjustStock,
      markAllRead, clearNotifications, unreadCount,
      setPaymentMethod, setPaymentState, setDiscount,
      toast,
      reloadProducts, reloadSuppliers, loadWishlistFromDB, wishlistLoaded,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
