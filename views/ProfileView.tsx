'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter, Link } from '@/lib/hashRouter';
import dynamic from 'next/dynamic';
import Header from '@/components/Header';
import ProductImage from '@/components/ProductImage';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { CATEGORIES, SUBCATEGORIES } from '@/lib/data';
import { authHeaders } from '@/lib/clientAuth';
import { mapsDirectionsUrl } from '@/lib/maps';
import StoreAvatar, { isLogoUrl } from '@/components/StoreAvatar';
import { slugify, isValidSlug, RESERVED_SLUGS, storePath } from '@/lib/slug';
import { useMyProductIds } from '@/lib/useMyProductIds';
import { isRevenueOrder } from '@/lib/revenue';
import type { Product, BusinessProduct, Supplier } from '@/lib/types';
import ProductFormModal, { type ProductFormShape, emptyProductForm } from '@/components/ProductFormModal';
import { tiersToForm, formToTiers } from '@/lib/tierPricing';
import { parseCsv, csvRowToProduct, PRODUCT_CSV_TEMPLATE } from '@/lib/csvImport';

/** A store a field agent has registered (GET /api/agent/stores). */
interface AgentStoreRow {
  id:             number;
  name:           string;
  icon:           string;
  slug:           string | null;
  approvalStatus: string | null;
  submittedAt:    string | null;
  bountyAmount:   number | null;
  bountyPaidAt:   string | null;
  storePaying:    boolean;
  createdAt:      string | null;
}
interface AgentTotals {
  registered: number; approved: number; pending: number;
  paidEarnings: number; pendingEarnings: number;
}

/* ── Heavy client-only components — loaded after hydration ─── */
const SupplierDashboard  = dynamic(() => import('@/components/SupplierDashboard'),  { ssr: false });
const BarcodeScanner     = dynamic(() => import('@/components/BarcodeScanner'),     { ssr: false });
const ProductImageUpload = dynamic(() => import('@/components/ProductImageUpload'), { ssr: false });

/* ── AI Generate button (inline component) ─────────────────── */
interface AiResult { name?: string; description?: string; brand?: string; category?: string; subCategory?: string; tags?: string[]; }
function AiGenerateButton({ imageUrl, onResult }: { imageUrl: string; onResult: (r: AiResult) => void }) {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [success, setSuccess] = useState(false);

  const generate = async () => {
    setLoading(true); setError(''); setSuccess(false);
    try {
      const res  = await fetch('/api/ai/describe-product', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ imageUrl }),
      });
      const data = await res.json();
      if (data.noKey) {
        setError('Add a free OPENROUTER_API_KEY to .env.local to enable AI descriptions');
      } else if (data.error) {
        setError(data.error);
      } else {
        onResult(data);
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      }
    } catch {
      setError('AI request failed');
    }
    setLoading(false);
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        className="btn btn-secondary btn-full"
        onClick={generate}
        disabled={loading}
        style={{ gap: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {loading ? (
          <><span className="btn-spinner" /> Analysing image with AI…</>
        ) : success ? (
          <>✅ AI filled in the details!</>
        ) : (
          <>✨ AI Generate Description</>
        )}
      </button>
      {error && <div className="auth-error" style={{ marginTop: 6, fontSize: '.78rem' }}>{error}</div>}
    </div>
  );
}

/* ── Referral card (inline component) ──────────────────────── */
function ReferralCard({ userId }: { userId: string }) {
  const [code,    setCode]    = useState('');
  const [copied,  setCopied]  = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/referrals?userId=${userId}`, { headers: await authHeaders() });
        const d = await r.json();
        if (d.code) setCode(d.code);
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, [userId]);

  const link   = typeof window !== 'undefined'
    ? `${window.location.origin}/auth/signup?ref=${code}`
    : '';

  const share = () => {
    if (navigator.share) {
      navigator.share({ title: 'Hamar Mall', text: `Shop with me on Hamar Mall — use my code ${code} to get $5 off!`, url: link })
        .catch(() => {});
    } else {
      navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  if (loading || !code) return null;

  return (
    <div className="referral-card">
      <div className="referral-card-top">
        <div className="referral-icon">🎁</div>
        <div>
          <div className="referral-title">Invite Friends, Earn $5</div>
          <div className="referral-desc">Both of you get $5 credit when they sign up</div>
        </div>
      </div>
      <div className="referral-code-row">
        <div className="referral-code">{code}</div>
        <button className="btn btn-primary btn-sm" onClick={share}>
          {copied ? '✓ Copied!' : '📤 Share'}
        </button>
      </div>
      <div className="referral-link">{link}</div>
    </div>
  );
}

const BIZ_ICONS = ['🏭','🏪','🏬','🛒','🏥','💊','👗','🔧','🚗','🍎','🍕','📚','💻','🌿','💄','🏗️'];

/* The product add/edit form is the shared app-wide one (same as Inventory). */
type ProductFormData = ProductFormShape;
const emptyForm: ProductFormData = emptyProductForm;

type BizTab = 'store' | 'edit' | 'analytics' | 'coupons';

interface Coupon {
  id: number; code: string; type: string; value: number;
  minOrder: number; maxUses: number | null; usedCount: number;
  expiresAt: string | null; active: boolean;
}

interface VerifRequest { id: number; status: string; message: string | null; createdAt: string; }

export default function ProfilePage() {
  const router  = useRouter();
  const { user, currentSupplier, currentProfile, accountType, loading,
          signOut, refreshAccount, updateProfile,
          actingStore, setActingStore, agentSelf } = useAuth();
  const { state, toast, reloadProducts } = useApp();

  // Grace period: wait a little extra after auth says "loading=false, user=null"
  // to avoid flashing "Sign in required" while Supabase is still restoring the session.
  const [authGrace, setAuthGrace] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setAuthGrace(false), 1500);
    return () => clearTimeout(t);
  }, []);

  /* ── User profile state ──────────────────────────────────── */
  const [fullName,     setFullName]     = useState('');
  const [phone,        setPhone]        = useState('');
  const [avatarUrl,    setAvatarUrl]    = useState('');
  const [userBio,      setUserBio]      = useState('');
  const [savingUser,   setSavingUser]   = useState(false);
  const [savedUser,    setSavedUser]    = useState(false);

  /* ── Business core state ─────────────────────────────────── */
  const [bizTab,       setBizTab]       = useState<BizTab>('store');
  // Total Shop Revenue (Reports tab) — lazy-loaded the first time that tab
  // opens, then kept fresh whenever a review/order changes bring the user
  // back to it (see the effect below).
  const [bizOrders,       setBizOrders]       = useState<{ status?: string; total?: number; items?: { id: number; qty: number }[] }[]>([]);
  const [bizOrdersLoaded, setBizOrdersLoaded] = useState(false);
  const [bio,          setBio]          = useState('');
  const [contacts,     setContacts]     = useState<string[]>(['']);
  const [bizName,      setBizName]      = useState('');
  const [bizIcon,      setBizIcon]      = useState('🏭');
  const [bizSlug,      setBizSlug]      = useState('');
  const [slugError,    setSlugError]    = useState('');
  const [slugStatus,   setSlugStatus]   = useState<'idle' | 'checking' | 'free' | 'taken' | 'reserved'>('idle');
  const [location,     setLocation]     = useState('');
  const [lat,          setLat]          = useState<number | null>(null);
  const [lng,          setLng]          = useState<number | null>(null);
  const [locating,     setLocating]     = useState(false);
  const [hideStock,    setHideStock]    = useState(false);
  const [onlineOnly,   setOnlineOnly]   = useState(false);
  const [deliveryDays, setDeliveryDays] = useState('');
  const [savingBiz,    setSavingBiz]    = useState(false);
  const [savedBiz,     setSavedBiz]     = useState(false);

  /* ── Field-agent: stores this agent registered + earnings ─── */
  const [agentStores, setAgentStores] = useState<AgentStoreRow[]>([]);
  const [agentTotals, setAgentTotals] = useState<AgentTotals | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [linkCode,    setLinkCode]    = useState('');
  const [linking,     setLinking]     = useState(false);
  const [submittingStore, setSubmittingStore] = useState<number | null>(null);

  /* ── Business product management ────────────────────────── */
  const [bizProducts,  setBizProducts]  = useState<BusinessProduct[]>([]);
  const [bpLoading,    setBpLoading]    = useState(false);
  const [bpSearch,     setBpSearch]     = useState('');
  const [showScanner,  setShowScanner]  = useState(false);
  const [scanLoading,  setScanLoading]  = useState(false);

  // Coupons state
  const [coupons,       setCoupons]       = useState<Coupon[]>([]);
  const [couponsLoaded, setCouponsLoaded] = useState(false);
  const [newCoupon,     setNewCoupon]     = useState({ code:'', type:'percent', value:'', minOrder:'0', maxUses:'', expiresAt:'' });
  const [savingCoupon,  setSavingCoupon]  = useState(false);
  const [showCouponForm,setShowCouponForm]= useState(false);

  // Verification request state
  const [verifRequest,  setVerifRequest]  = useState<VerifRequest | null | 'none'>('none');
  const [requestingVerif,setRequestingVerif]= useState(false);

  // CSV bulk import state
  const [csvFile,      setCsvFile]      = useState<File | null>(null);
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvResult,    setCsvResult]    = useState('');
  const [editBP,       setEditBP]       = useState<BusinessProduct | null>(null);
  const [editPrice,    setEditPrice]    = useState('');
  const [editStock,    setEditStock]    = useState('');
  const [editMoq,      setEditMoq]      = useState('1');
  const [savingBP,     setSavingBP]     = useState(false);
  const [deletingBP,   setDeletingBP]   = useState<number | null>(null);

  /* ── Claim modal (scan result) ───────────────────────────── */
  const [claimProduct, setClaimProduct] = useState<Product | null>(null);
  const [claimPrice,   setClaimPrice]   = useState('');
  const [claimStock,   setClaimStock]   = useState('10');
  const [claimMoq,     setClaimMoq]     = useState('1');
  const [savingClaim,  setSavingClaim]  = useState(false);

  /* ── New product form (profile page) ────────────────────── */
  const [showForm,     setShowForm]     = useState(false);
  const [editingProd,  setEditingProd]  = useState<Product | null>(null);
  const [form,         setForm]         = useState<ProductFormData>(emptyForm);
  const [savingProd,   setSavingProd]   = useState(false);
  const [deletingId,   setDeletingId]   = useState<number | null>(null);

  /* ── Load profile & business data ────────────────────────── */
  useEffect(() => {
    if (currentProfile) {
      setFullName(currentProfile.fullName ?? '');
      setPhone(currentProfile.phone ?? '');
      setAvatarUrl(currentProfile.avatarUrl ?? '');
      setUserBio(currentProfile.bio ?? '');
    }
  }, [currentProfile]);

  useEffect(() => {
    if (currentSupplier) {
      setBio(currentSupplier.bio ?? '');
      setBizName(currentSupplier.name ?? '');
      setBizIcon(currentSupplier.icon ?? '🏭');
      setLocation(currentSupplier.location ?? '');
      setLat(currentSupplier.latitude  ?? null);
      setLng(currentSupplier.longitude ?? null);
      setHideStock(currentSupplier.hideStock ?? false);
      setOnlineOnly(currentSupplier.onlineOnly ?? false);
      setDeliveryDays(currentSupplier.deliveryDays ?? '');
      setBizSlug(currentSupplier.slug ?? '');
      const nums = currentSupplier.contactNumbers ?? [];
      setContacts(nums.length > 0 ? nums : ['']);
    }
  }, [currentSupplier]);

  /* Live availability check for the store link — debounced, skips the
     store's own current slug. */
  useEffect(() => {
    const s = bizSlug.trim();
    if (!s || s === (currentSupplier?.slug ?? '')) { setSlugStatus('idle'); return; }
    if (RESERVED_SLUGS.has(s))                     { setSlugStatus('reserved'); return; }
    if (s.length < 3 || !isValidSlug(s))           { setSlugStatus('idle'); return; }
    setSlugStatus('checking');
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/suppliers?slug=${encodeURIComponent(s)}`, { signal: ctrl.signal });
        if (res.status === 404) { setSlugStatus('free'); return; }
        const d = await res.json().catch(() => null);
        setSlugStatus(d?.id === currentSupplier?.id ? 'free' : 'taken');
      } catch { setSlugStatus('idle'); }
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [bizSlug, currentSupplier]);

  /* Load business products + coupons + verification status */
  useEffect(() => {
    if (!currentSupplier) return;
    loadBizProducts();
    // Load coupons
    fetch(`/api/coupons?supplierId=${currentSupplier.id}`)
      .then(r => r.json())
      .then(d => { setCoupons(Array.isArray(d) ? d : []); setCouponsLoaded(true); })
      .catch(() => setCouponsLoaded(true));
    // Load verification request status
    fetch(`/api/verification-requests?supplierId=${currentSupplier.id}`)
      .then(r => r.json())
      .then(d => setVerifRequest(Array.isArray(d) && d[0] ? d[0] : null))
      .catch(() => setVerifRequest(null));
    // Load orders for the Total Shop Revenue stat (Reports tab + hero stat).
    // The endpoint carries customer PII → needs the caller's JWT.
    (async () => {
      try {
        const r = await fetch(`/api/orders?supplierId=${currentSupplier.id}`, { cache: 'no-store', headers: await authHeaders() });
        const d = await r.json();
        setBizOrders(Array.isArray(d) ? d : []);
      } catch { /* keep empty */ }
      setBizOrdersLoaded(true);
    })();
  }, [currentSupplier]); // eslint-disable-line react-hooks/exhaustive-deps

  // This business's own line-item share of an order (owned + claimed
  // products only — an order split across several sellers must only
  // contribute the piece THIS store actually sold).
  const { ids: myRevenueProductIds, claimed: myRevenueClaims } = useMyProductIds();
  const priceForRevenue = useCallback((id: number) =>
    myRevenueClaims.get(id)?.customPrice ?? state.products.find(p => p.id === id)?.price ?? 0,
  [myRevenueClaims, state.products]);

  const totalShopRevenue = useMemo(() => {
    if (!bizOrdersLoaded) return 0;
    return bizOrders.reduce((sum, o) => {
      if (!isRevenueOrder(o)) return sum;
      const items = Array.isArray(o.items) ? o.items : [];
      const mine = items.reduce((s, it) =>
        myRevenueProductIds.has(it.id) ? s + priceForRevenue(it.id) * (Number(it.qty) || 0) : s, 0);
      return sum + mine;
    }, 0);
  }, [bizOrders, bizOrdersLoaded, myRevenueProductIds, priceForRevenue]);

  async function loadBizProducts() {
    if (!currentSupplier) return;
    setBpLoading(true);
    try {
      const res  = await fetch(`/api/business-products?supplierId=${currentSupplier.id}`);
      const data = await res.json();
      setBizProducts(Array.isArray(data) ? data : []);
    } catch {
      setBizProducts([]);
    }
    setBpLoading(false);
  }

  /* ── Computed ──────────────────────────────────────────────── */
  const wishlistCount   = state.wishlist.length;
  const cartItemCount   = state.cart.reduce((n, i) => n + i.qty, 0);
  const supplierProducts = useMemo(
    () => currentSupplier ? state.products.filter(p => p.supplierId === currentSupplier.id) : [],
    [state.products, currentSupplier]
  );

  /* Agent: load the stores this agent has registered (status + bounty). The
     agent's OWN store id is `agentSelf` (currentSupplier is overridden to the
     store being set up while acting). */
  const loadAgentStores = useCallback(async () => {
    const agentId = agentSelf?.id;
    if (accountType !== 'agent' || !agentId) return;
    setAgentLoading(true);
    try {
      const r = await fetch(`/api/agent/stores?agentId=${agentId}`, { cache: 'no-store', headers: await authHeaders() });
      const d = await r.json();
      if (!d.error) { setAgentStores(d.stores ?? []); setAgentTotals(d.totals ?? null); }
    } catch { /* keep last good */ }
    finally { setAgentLoading(false); }
  }, [accountType, agentSelf?.id]);

  useEffect(() => {
    if (accountType === 'agent' && !actingStore) loadAgentStores();
  }, [accountType, actingStore, loadAgentStores]);

  /* Agent links a store the owner created, using the store's link code. */
  async function handleLinkStore() {
    const code = linkCode.trim().toUpperCase();
    if (!code) { toast('Enter the store’s link code', 'warning'); return; }
    setLinking(true);
    try {
      const r = await fetch('/api/agent/link', {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (!r.ok) { toast(d.error ?? 'Could not register that store', 'error'); return; }
      toast(d.alreadyLinked ? `Already yours: ${d.name}` : `Registered ${d.name} 🎉`, 'success');
      setLinkCode('');
      await loadAgentStores();
    } catch { toast('Network error', 'error'); }
    finally { setLinking(false); }
  }

  /* Agent submits a store they've finished setting up for admin review. */
  async function handleSubmitStore(storeId: number) {
    setSubmittingStore(storeId);
    try {
      const r = await fetch('/api/agent/submit', {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ storeId }),
      });
      const d = await r.json();
      if (!r.ok) { toast(d.error ?? 'Could not submit', 'error'); return; }
      toast('Submitted for review ✅', 'success');
      if (actingStore?.id === storeId) setActingStore(null);
      await loadAgentStores();
    } catch { toast('Network error', 'error'); }
    finally { setSubmittingStore(null); }
  }

  /* Enter "acting as" mode: fetch the fresh store row and set it up in the full
     business UI (the server authorizes every write via agentManagesStore). */
  async function handleSetUpStore(storeId: number) {
    try {
      const r = await fetch(`/api/suppliers/${storeId}`, { cache: 'no-store', headers: await authHeaders() });
      const store = await r.json();
      if (!r.ok || !store?.id) { toast('Could not open that store', 'error'); return; }
      setActingStore(store as Supplier);
      setBizTab('store');
      window.scrollTo({ top: 0 });
    } catch { toast('Network error', 'error'); }
  }
  const filteredBP = useMemo(() => {
    if (!bpSearch.trim()) return bizProducts;
    const q = bpSearch.toLowerCase();
    return bizProducts.filter(bp =>
      bp.product?.name.toLowerCase().includes(q) ||
      bp.product?.brand?.toLowerCase().includes(q) ||
      bp.product?.category.toLowerCase().includes(q)
    );
  }, [bizProducts, bpSearch]);

  /* ── Sign out ──────────────────────────────────────────────── */
  const handleSignOut = async () => { await signOut(); router.push('/'); };

  /* ── Save user profile ─────────────────────────────────────── */
  const handleSaveUser = async () => {
    setSavingUser(true);
    try {
      await updateProfile({
        fullName: fullName.trim(), phone: phone.trim(),
        avatarUrl: avatarUrl.trim() || null, bio: userBio.trim(),
      });
      setSavedUser(true);
      setTimeout(() => setSavedUser(false), 3000);
    } catch {
      toast('Could not save profile. Please try again.', 'error');
    }
    setSavingUser(false);
  };

  /* ── Save business profile ─────────────────────────────────── */
  const handleSaveBiz = async () => {
    if (!currentSupplier) return;
    // Validate slug
    const slug = bizSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (bizSlug.trim() && (slug.length < 3 || slug.length > 30)) {
      setSlugError('Link must be 3–30 characters (letters, numbers, hyphens)');
      return;
    }
    if (slug && !isValidSlug(slug)) {
      setSlugError('That link is reserved — pick a different one');
      return;
    }
    if (slugStatus === 'taken') {
      setSlugError('That link is already taken by another store');
      return;
    }
    setSlugError('');
    setSavingBiz(true);
    const cleanContacts = contacts.map(c => c.trim()).filter(Boolean);
    try {
      const res = await fetch(`/api/suppliers/${currentSupplier.id}`, {
        method:  'PATCH',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({
          bio:            bio.trim(),
          contactNumbers: cleanContacts,
          name:           bizName.trim(),
          icon:           bizIcon,
          location:       location.trim(),
          latitude:       lat,
          longitude:      lng,
          slug:           slug || null,
          hideStock,
          onlineOnly,
          deliveryDays:   deliveryDays.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        // Slug conflicts get inline feedback next to the field, not just a toast
        if (res.status === 409 || (res.status === 400 && /link|slug/i.test(err?.error ?? ''))) {
          setSlugError(err?.error ?? 'That store link is not available');
        }
        toast(err?.error ?? 'Could not save profile', 'error');
        setSavingBiz(false);
        return;
      }
      const saved = await res.json().catch(() => null);
      if (saved?.skippedColumns?.includes('slug')) {
        toast('Saved — but the storefront link (slug) needs the v3.1 DB migration', 'warning');
      } else {
        setSavedBiz(true);
        setTimeout(() => setSavedBiz(false), 3000);
      }
      await refreshAccount();
    } catch {
      toast('Network error — profile not saved', 'error');
    }
    setSavingBiz(false);
  };

  /* ── One-tap GPS: detect the store's exact coordinates AND save them
        immediately, so there's no separate "save" step to forget. ──── */
  const saveCoords = async (la: number | null, ln: number | null) => {
    if (!currentSupplier) return;
    try {
      const res = await fetch(`/api/suppliers/${currentSupplier.id}`, {
        method:  'PATCH',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({ latitude: la, longitude: ln }),
      });
      if (!res.ok) { toast('Got your location but could not save it — try again', 'error'); return; }
      const saved = await res.json().catch(() => null);
      if (saved?.skippedColumns?.length) {
        toast('Got location, but the map needs the DB migration (lat/lng columns)', 'warning');
      } else {
        toast(la == null ? 'Map pin removed' : '📍 Location saved', la == null ? 'default' : 'success');
        await refreshAccount();
      }
    } catch {
      toast('Network error — location not saved', 'error');
    }
  };

  const detectLocation = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      toast('Location is not available on this device', 'error');
      return;
    }
    if (!currentSupplier) { toast('No business profile found', 'error'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const la = pos.coords.latitude;
        const ln = pos.coords.longitude;
        setLat(la);
        setLng(ln);
        await saveCoords(la, ln);
        setLocating(false);
      },
      () => {
        setLocating(false);
        toast('Could not get location. Allow permission and try again.', 'error');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const addContact    = () => { if (contacts.length < 4) setContacts(c => [...c, '']); };
  const updateContact = (i: number, v: string) => setContacts(c => c.map((x, j) => j === i ? v : x));
  const removeContact = (i: number) => setContacts(c => c.length > 1 ? c.filter((_, j) => j !== i) : ['']);

  /* ── Barcode scan ──────────────────────────────────────────── */
  async function handleBarcodeDetected(code: string) {
    setScanLoading(true);
    try {
      const res = await fetch(`/api/products?barcode=${encodeURIComponent(code)}`);
      if (res.ok) {
        const product = await res.json() as Product;
        setClaimProduct(product);
        setClaimPrice(String(product.price));
        setClaimStock('10');
      } else {
        toast(`Barcode ${code} not found in database`, 'error');
      }
    } catch {
      toast('Network error', 'error');
    }
    setScanLoading(false);
  }

  /* ── Claim product ─────────────────────────────────────────── */
  async function handleClaim() {
    if (!claimProduct || !currentSupplier) return;
    const p = parseFloat(claimPrice);
    if (!p || p <= 0) { toast('Enter a valid price', 'error'); return; }
    setSavingClaim(true);
    try {
      const res = await fetch('/api/business-products', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          supplierId:  currentSupplier.id,
          productId:   claimProduct.id,
          customPrice: p,
          stockQty:    parseInt(claimStock) || 0,
          moq:         Math.max(1, parseInt(claimMoq) || 1),
        }),
      });
      if (res.ok) {
        toast(`✅ "${claimProduct.name}" added to your store!`, 'success');
        setClaimProduct(null);
        await loadBizProducts();
      } else {
        const err = await res.json();
        toast(err.error ?? 'Failed to add product', 'error');
      }
    } catch { toast('Network error', 'error'); }
    setSavingClaim(false);
  }

  /* ── Edit BP price/stock inline ────────────────────────────── */
  function openEditBP(bp: BusinessProduct) {
    setEditBP(bp);
    setEditPrice(String(bp.customPrice));
    setEditStock(String(bp.stockQty));
    setEditMoq(String(bp.moq ?? 1));
  }

  async function saveEditBP() {
    if (!editBP) return;
    setSavingBP(true);
    try {
      const res = await fetch(`/api/business-products/${editBP.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          customPrice: parseFloat(editPrice),
          stockQty:    parseInt(editStock) || 0,
          moq:         Math.max(1, parseInt(editMoq) || 1),
        }),
      });
      if (res.ok) {
        toast('Updated ✓', 'success');
        setEditBP(null);
        await loadBizProducts();
      }
    } catch { toast('Failed to update', 'error'); }
    setSavingBP(false);
  }

  async function toggleBPActive(bp: BusinessProduct) {
    await fetch(`/api/business-products/${bp.id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ isActive: !bp.isActive }),
    });
    await loadBizProducts();
  }

  async function deleteBP(id: number) {
    if (!confirm('Remove this product from your store?')) return;
    setDeletingBP(id);
    await fetch(`/api/business-products/${id}`, { method: 'DELETE' });
    setBizProducts(prev => prev.filter(bp => bp.id !== id));
    setDeletingBP(null);
    toast('Product removed', 'default');
  }

  /* ── New/Edit product form ─────────────────────────────────── */
  function openAddProduct() { setEditingProd(null); setForm(emptyForm); setShowForm(true); }
  function openEditProduct(p: Product) {
    setEditingProd(p);
    const pc = p as Product & { cost?: number; taxMode?: 'none' | 'included' | 'excluded'; feeAbsorbedByStore?: boolean };
    setForm({
      name:         p.name,
      price:        String(p.price),
      originalPrice:String(p.originalPrice),
      cost:         pc.cost ? String(pc.cost) : '',
      category:     p.category,
      subCategory:  p.subCategory ?? '',
      stock:        String(p.stock),
      sku:          p.sku,
      description:  p.description,
      barcode:      p.barcode    ?? '',
      brand:        p.brand      ?? '',
      tags:         (p.tags ?? []).join(', '),
      imageUrls:    p.imageUrls  ?? [],
      supplierId:   p.supplierId ? String(p.supplierId) : '',
      taxMode:      pc.taxMode ?? 'none',
      feeAbsorbedByStore: Boolean(pc.feeAbsorbedByStore),
      priceTiers:   tiersToForm(p.priceTiers),
    });
    setShowForm(true);
  }
  const pf = (k: keyof ProductFormData, v: string | string[]) => setForm(f => ({ ...f, [k]: v }));

  /* ── Save coupon ─────────────────────────────────── */
  const handleSaveCoupon = async () => {
    if (!newCoupon.code.trim() || !newCoupon.value || !currentSupplier) return;
    setSavingCoupon(true);
    const res = await fetch('/api/coupons', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        code:       newCoupon.code.toUpperCase().trim(),
        type:       newCoupon.type,
        value:      parseFloat(newCoupon.value),
        minOrder:   parseFloat(newCoupon.minOrder || '0'),
        maxUses:    newCoupon.maxUses ? parseInt(newCoupon.maxUses) : null,
        expiresAt:  newCoupon.expiresAt || null,
        supplierId: currentSupplier.id,
      }),
    });
    if (res.ok) {
      const saved = await res.json();
      setCoupons(prev => [saved, ...prev]);
      setNewCoupon({ code:'', type:'percent', value:'', minOrder:'0', maxUses:'', expiresAt:'' });
      setShowCouponForm(false);
      toast('Coupon created ✓', 'success');
    } else {
      toast('Failed to create coupon', 'error');
    }
    setSavingCoupon(false);
  };

  const toggleCouponActive = async (c: Coupon) => {
    const res = await fetch(`/api/coupons/${c.id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ active: !c.active }),
    });
    if (res.ok) setCoupons(prev => prev.map(x => x.id === c.id ? { ...x, active: !x.active } : x));
  };

  const deleteCoupon = async (id: number) => {
    if (!confirm('Delete this coupon?')) return;
    const res = await fetch(`/api/coupons/${id}`, { method: 'DELETE' });
    if (res.ok) { setCoupons(prev => prev.filter(c => c.id !== id)); toast('Coupon deleted', 'default'); }
  };

  /* ── CSV bulk import ──────────────────────────────── */
  const handleCsvImport = async () => {
    if (!csvFile || !currentSupplier) return;
    setCsvImporting(true); setCsvResult('');

    const rows = parseCsv(await csvFile.text());
    if (rows.length === 0) {
      setCsvResult('❌ No data rows found — the file needs a header row plus at least one product.');
      setCsvImporting(false);
      return;
    }

    let created = 0;
    const skipped: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const payload = csvRowToProduct(rows[i], i);
      if (!payload) { skipped.push(`row ${i + 2}: missing name or price`); continue; }
      const res = await fetch('/api/products', {
        method:  'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({ ...payload, supplierId: currentSupplier.id }),
      });
      if (res.ok) created++;
      else {
        const err = await res.json().catch(() => null);
        skipped.push(`row ${i + 2}: ${err?.error ?? 'rejected'}`);
      }
    }

    setCsvResult(
      `✅ ${created} product${created !== 1 ? 's' : ''} imported` +
      (skipped.length ? ` · ❌ ${skipped.length} skipped — ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '…' : ''}` : '')
    );
    if (created > 0) await reloadProducts();
    setCsvImporting(false);
    setCsvFile(null);
  };

  /* ── Verification request ─────────────────────────── */
  const handleRequestVerification = async () => {
    if (!currentSupplier) return;
    setRequestingVerif(true);
    const res = await fetch('/api/verification-requests', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ supplierId: currentSupplier.id }),
    });
    if (res.ok) {
      const data = await res.json();
      setVerifRequest(data);
      toast('Verification request sent ✓', 'success');
    } else {
      toast('Failed to send request', 'error');
    }
    setRequestingVerif(false);
  };

  const handleSaveProduct = async () => {
    if (!form.name.trim() || !form.price) { toast('Name and price required', 'error'); return; }
    setSavingProd(true);
    const body = {
      name:          form.name.trim(),
      price:         form.price,
      originalPrice: form.originalPrice || form.price,
      cost:          form.cost || '0',
      category:      form.category,
      subCategory:   form.subCategory   || null,
      stock:         form.stock,
      sku:           form.sku.trim(),
      description:   form.description.trim(),
      barcode:       form.barcode.trim() || null,
      brand:         form.brand.trim()   || null,
      tags:          form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      taxMode:       form.taxMode,
      feeAbsorbedByStore: form.feeAbsorbedByStore,
      priceTiers:    formToTiers(form.priceTiers),
      imageUrls:     form.imageUrls,
      // Keep legacy imageUrl in sync with first photo
      imageUrl:      form.imageUrls[0] ?? null,
      // Default to the signed-in store so the product isn't an un-editable orphan.
      supplierId:    form.supplierId ? parseInt(form.supplierId, 10) : (currentSupplier?.id ?? null),
    };
    if (editingProd) {
      const res = await fetch(`/api/products/${editingProd.id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      if (res.ok) toast('Product updated ✓', 'success'); else toast('Failed to update', 'error');
    } else {
      const res = await fetch('/api/products', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      if (res.ok) toast('Product added ✓', 'success'); else toast('Failed to add product', 'error');
    }
    setSavingProd(false);
    setShowForm(false);
    await reloadProducts();
  };

  const handleDeleteProduct = async (productId: number) => {
    if (!confirm('Delete this product?')) return;
    setDeletingId(productId);
    const res = await fetch(`/api/products/${productId}`, { method:'DELETE' });
    setDeletingId(null);
    if (res.ok) { toast('Product deleted', 'default'); await reloadProducts(); }
    else toast('Failed to delete', 'error');
  };

  /* ── Loading / grace period ───────────────────────────────── */
  if (loading || authGrace) {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div style={{ padding: 20 }}>
          <div className="skeleton" style={{ height: 140, borderRadius: 20, marginBottom: 16 }} />
          <div className="skeleton" style={{ height: 44, borderRadius: 8, marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 80, borderRadius: 8 }} />
        </div>
      </div>
    );
  }

  /* ── Not logged in ─────────────────────────────────────────── */
  if (!user) {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div className="empty-state" style={{ marginTop: 60 }}>
          <div className="empty-icon">🔐</div>
          <div className="empty-title">Sign in required</div>
          <div className="empty-sub">Log in to access your profile</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => router.push('/auth/login')}>Sign In</button>
          <button className="btn btn-outline" style={{ marginTop: 10 }} onClick={() => router.push('/auth/signup')}>Create Account</button>
        </div>
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════════
     SUPPLIER PROFILE
  ══════════════════════════════════════════════════════════════ */
  if (accountType === 'supplier' && currentSupplier) {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div className="page-title-bar">
          <span className="page-title">🏭 Supplier Dashboard</span>
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <Link href="/billing" className="btn btn-ghost btn-sm">💳 Billing</Link>
            <button className="btn btn-ghost btn-sm signout-btn" onClick={handleSignOut}>Sign Out</button>
          </div>
        </div>
        <SupplierDashboard supplier={currentSupplier} />
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════════
     AGENT (FIELD AGENT / PRODUCT REGISTRAR) PROFILE
  ══════════════════════════════════════════════════════════════ */
  if (accountType === 'agent' && agentSelf) {
    const badge = (s: AgentStoreRow) => {
      if (s.approvalStatus === 'approved') return { t: 'Approved · handed over', c: 'var(--success)' };
      if (s.approvalStatus === 'pending')  return { t: 'Under review', c: 'var(--warning)' };
      return { t: 'Setting up', c: 'var(--primary)' };
    };
    return (
      <div className="page-anim">
        <Header showSearch={false} />

        {/* ── Agent hero ─────────────────────────────────────────── */}
        <div className="biz-hero-card">
          <div className="biz-hero-top">
            <div className="biz-hero-icon">📋</div>
            <div className="biz-hero-info">
              <div className="biz-hero-name">{agentSelf.name}</div>
              <div className="biz-hero-sub">{user.email ?? user.phoneNumber ?? ''}</div>
              <div className="biz-hero-location" style={{ color:'var(--primary)', fontSize:'.8rem', fontWeight:600 }}>Field Agent · Store Acquisition</div>
            </div>
            <button className="btn btn-ghost btn-sm signout-btn" style={{ alignSelf:'flex-start', flexShrink:0 }} onClick={handleSignOut}>Sign Out</button>
          </div>

          <div className="biz-stats-row">
            <div className="biz-stat"><div className="biz-stat-val">{agentTotals?.registered ?? agentStores.length}</div><div className="biz-stat-lbl">Registered</div></div>
            <div className="biz-stat"><div className="biz-stat-val">{agentTotals?.approved ?? 0}</div><div className="biz-stat-lbl">Approved</div></div>
            <div className="biz-stat"><div className="biz-stat-val">${(agentTotals?.paidEarnings ?? 0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div className="biz-stat-lbl">Paid</div></div>
            <div className="biz-stat"><div className="biz-stat-val">${(agentTotals?.pendingEarnings ?? 0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div className="biz-stat-lbl">Owed</div></div>
          </div>
        </div>

        {/* ── Register a store by link code ──────────────────────── */}
        <div style={{ padding:'0 16px' }}>
          <div className="card" style={{ padding:16, borderRadius:14 }}>
            <div style={{ fontWeight:700, fontSize:'.95rem', marginBottom:6 }}>➕ Register a store</div>
            <div style={{ fontSize:'.82rem', color:'var(--text-muted)', marginBottom:12, lineHeight:1.5 }}>
              Have the store owner create their own account, then share their <strong>link code</strong> (shown in their profile). Enter it here to register the store — you can then set up its profile and products until it&apos;s approved.
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <input className="form-input" placeholder="e.g. 3F9A2C7B" value={linkCode}
                onChange={e => setLinkCode(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && handleLinkStore()}
                style={{ textTransform:'uppercase', letterSpacing:'.06em', fontFamily:'monospace' }} maxLength={12} />
              <button className="btn btn-primary" onClick={handleLinkStore} disabled={linking || !linkCode.trim()}>
                {linking ? '…' : 'Register'}
              </button>
            </div>
          </div>
        </div>

        {/* ── My registered stores ───────────────────────────────── */}
        <div style={{ padding:'16px 16px 120px' }}>
          <div style={{ fontWeight:700, fontSize:'.95rem', padding:'4px 0 10px' }}>🏪 My stores ({agentStores.length})</div>

          {agentStores.length === 0 && !agentLoading ? (
            <div className="empty-state" style={{ marginTop:20 }}>
              <div className="empty-icon">🏪</div>
              <div className="empty-title">No stores yet</div>
              <div className="empty-sub">Register your first store with its link code above.</div>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {agentStores.map(s => {
                const b = badge(s);
                const approved = s.approvalStatus === 'approved';
                return (
                  <div key={s.id} className="card" style={{ padding:14, borderRadius:12 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <div style={{ width:40, height:40, borderRadius:8, overflow:'hidden', flexShrink:0 }}><StoreAvatar value={s.icon} /></div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontWeight:700, fontSize:'.9rem', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{s.name}</div>
                        <div style={{ fontSize:'.76rem', color:b.c, fontWeight:600 }}>{b.t}</div>
                      </div>
                      <div style={{ textAlign:'right', flexShrink:0 }}>
                        {s.bountyPaidAt
                          ? <div style={{ fontSize:'.78rem', color:'var(--success)', fontWeight:700 }}>Paid ${(s.bountyAmount ?? 0).toFixed(2)}</div>
                          : s.bountyAmount != null
                            ? <div style={{ fontSize:'.78rem', color:'var(--warning)', fontWeight:700 }}>Owed ${s.bountyAmount.toFixed(2)}</div>
                            : <div style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>Bounty TBD</div>}
                        <div style={{ fontSize:'.68rem', color: s.storePaying ? 'var(--success)' : 'var(--text-muted)', marginTop:2 }}>
                          {s.storePaying ? '● Paying' : '○ Not paying'}
                        </div>
                      </div>
                    </div>

                    {!approved ? (
                      <div style={{ display:'flex', gap:8, marginTop:12 }}>
                        <button className="btn btn-outline btn-sm" style={{ flex:1 }} onClick={() => handleSetUpStore(s.id)}>✏️ Set up</button>
                        <button className="btn btn-primary btn-sm" style={{ flex:1 }} onClick={() => handleSubmitStore(s.id)} disabled={submittingStore === s.id}>
                          {submittingStore === s.id ? '…' : s.approvalStatus === 'pending' ? '↻ Re-submit' : '📤 Submit for review'}
                        </button>
                      </div>
                    ) : (
                      <div style={{ marginTop:10, fontSize:'.76rem', color:'var(--text-muted)' }}>
                        ✅ Approved — the owner now runs this store. Your setup access has ended.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════════
     CUSTOMER PROFILE
  ══════════════════════════════════════════════════════════════ */
  if (accountType === 'user') {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div className="page-title-bar">
          <span className="page-title">👤 My Profile</span>
          <button className="btn btn-ghost btn-sm signout-btn" onClick={handleSignOut}>Sign Out</button>
        </div>

        <div className="my-profile-wrap">
          <div className="profile-photo-row">
            <div className="profile-photo-big" style={{ background:'var(--surface)', overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center' }}>
              {avatarUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={avatarUrl} alt="avatar" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                : <svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".3"><circle cx="24" cy="18" r="8"/><path d="M6 42c0-9.94 8.06-18 18-18s18 8.06 18 18"/></svg>}
            </div>
            <div className="profile-photo-name">
              {currentProfile?.fullName || 'Your Name'}
              {currentProfile?.verified && (
                <span className="verified-badge-inline">✓ Verified</span>
              )}
            </div>
            <div className="profile-photo-sub">{user.phoneNumber ?? user.email ?? ''}</div>
          </div>

          <div className="user-stats-row">
            <div className="user-stat-chip" style={{ cursor:'pointer' }} onClick={() => router.push('/wishlist')}><span className="user-stat-val">{wishlistCount}</span><span className="user-stat-lbl">Wishlist</span></div>
            <div className="user-stat-chip"><span className="user-stat-val">{cartItemCount}</span><span className="user-stat-lbl">In Cart</span></div>
            <div className="user-stat-chip" style={{ cursor:'pointer' }} onClick={() => router.push('/orders')}>
              <span className="user-stat-val">📋</span><span className="user-stat-lbl">Orders</span>
            </div>
            <div className="user-stat-chip" style={{ cursor:'pointer' }} onClick={() => router.push('/')}>
              <span className="user-stat-val">🛍️</span><span className="user-stat-lbl">Shop</span>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Profile Photo</label>
            <ProductImageUpload
              urls={avatarUrl ? [avatarUrl] : []}
              onChange={urls => setAvatarUrl(urls[0] ?? '')}
              maxPhotos={1}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Full Name</label>
            <input className="form-input" placeholder="Your full name" value={fullName} onChange={e => setFullName(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Phone Number</label>
            <input className="form-input" placeholder="+252 XX XXX XXXX" value={phone} onChange={e => setPhone(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Bio / Description</label>
            <textarea className="form-input" rows={3} style={{ resize:'vertical', fontFamily:'inherit' }}
              placeholder="Tell us a bit about yourself…"
              value={userBio} onChange={e => setUserBio(e.target.value)} maxLength={300} />
            <div style={{ fontSize:'.75rem', color:'var(--text-muted)', textAlign:'right', marginTop:4 }}>{userBio.length}/300</div>
          </div>

          {savedUser && <div className="auth-success" style={{ marginBottom: 12 }}>✓ Profile saved</div>}
          <button className="btn btn-primary btn-full btn-lg" onClick={handleSaveUser} disabled={savingUser}>
            {savingUser ? 'Saving…' : 'Save Profile'}
          </button>

          <button className="user-wishlist-card" style={{ marginTop: 16 }} onClick={() => router.push('/orders')}>
            <div style={{ display:'flex', alignItems:'center', gap: 10 }}>
              <span style={{ fontSize:'1.5rem' }}>📋</span>
              <div><div style={{ fontWeight: 700, fontSize:'.92rem' }}>Order History</div>
                <div style={{ fontSize:'.8rem', color:'var(--text-muted)' }}>View all your past orders</div></div>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
          </button>

          {/* Referral section */}
          <ReferralCard userId={user.id} />
        </div>
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════════
     BUSINESS PROFILE
  ══════════════════════════════════════════════════════════════ */
  return (
    <div className="page-anim">
      <Header showSearch={false} />

      {/* ── Field-agent "acting as" banner ─────────────────────── */}
      {actingStore && (
        <div style={{
          margin: '10px 16px 0', padding: '10px 14px', borderRadius: 12,
          background: 'color-mix(in srgb, var(--primary) 12%, transparent)',
          border: '1px solid var(--primary)', display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: '1.1rem' }}>🧑‍💼</span>
          <div style={{ flex: 1, minWidth: 0, fontSize: '.82rem', lineHeight: 1.4 }}>
            Setting up <strong>{actingStore.name}</strong> as its field agent. Add its profile &amp; products, then submit for review.
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => handleSubmitStore(actingStore.id)} disabled={submittingStore === actingStore.id}>
            {submittingStore === actingStore.id ? '…' : 'Submit'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setActingStore(null)}>Exit</button>
        </div>
      )}

      {/* ── Business Hero Card ─────────────────────────────────── */}
      <div className="biz-hero-card">
        <div className="biz-hero-top">
          <div className="biz-hero-icon"><StoreAvatar value={currentSupplier?.icon} fallback="🏭" /></div>
          <div className="biz-hero-info">
            <div className="biz-hero-name">
              {currentSupplier?.name ?? 'Your Business'}
              {currentSupplier?.verified && <span className="biz-verified-badge">✓ Verified</span>}
            </div>
            <div className="biz-hero-sub">{user.phoneNumber ?? user.email ?? ''}</div>
            {currentSupplier?.location && (
              <div className="biz-hero-location">📍 {currentSupplier.location}</div>
            )}
          </div>
          <button className="btn btn-ghost btn-sm signout-btn" style={{ alignSelf:'flex-start', flexShrink:0 }} onClick={handleSignOut}>
            Sign Out
          </button>
        </div>

        {/* Stats row */}
        <div className="biz-stats-row">
          <div className="biz-stat">
            <div className="biz-stat-val">{bizProducts.length + supplierProducts.length}</div>
            <div className="biz-stat-lbl">Products</div>
          </div>
          <div className="biz-stat">
            <div className="biz-stat-val">{currentSupplier?.rating?.toFixed(1) ?? '–'}</div>
            <div className="biz-stat-lbl">⭐ Rating</div>
          </div>
          <div className="biz-stat">
            <div className="biz-stat-val">{currentSupplier?.reviews ?? 0}</div>
            <div className="biz-stat-lbl">Reviews</div>
          </div>
          <div className="biz-stat" style={{ cursor:'pointer' }} onClick={() => currentSupplier && router.push(storePath(currentSupplier))}>
            <div className="biz-stat-val">👁️</div>
            <div className="biz-stat-lbl">View Store</div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="biz-tabs">
          <button className={`biz-tab${bizTab === 'store'     ? ' active' : ''}`} onClick={() => setBizTab('store')}>📦 Store</button>
          <button className={`biz-tab${bizTab === 'coupons'   ? ' active' : ''}`} onClick={() => setBizTab('coupons')}>🎟️ Coupons</button>
          <button className={`biz-tab${bizTab === 'analytics' ? ' active' : ''}`} onClick={() => setBizTab('analytics')}>📊 Reports</button>
          <button className={`biz-tab${bizTab === 'edit'      ? ' active' : ''}`} onClick={() => setBizTab('edit')}>⚙️ Settings</button>
        </div>
      </div>

      {/* ══════════ TAB: MY STORE ══════════ */}
      {bizTab === 'store' && (
        <div className="biz-store-wrap">
          {/* Store action bar */}
          <div className="biz-store-actions">
            <input
              className="form-input"
              placeholder="Search your products…"
              value={bpSearch}
              onChange={e => setBpSearch(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn btn-secondary btn-sm" style={{ flexShrink:0, gap:6, display:'flex', alignItems:'center' }}
              onClick={() => setShowScanner(true)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="3" width="4" height="4" rx=".5"/><rect x="17" y="3" width="4" height="4" rx=".5"/>
                <rect x="3" y="17" width="4" height="4" rx=".5"/>
                <line x1="7" y1="5" x2="17" y2="5"/><line x1="7" y1="19" x2="13" y2="19"/>
                <line x1="19" y1="7" x2="19" y2="13"/><line x1="5" y1="7" x2="5" y2="17"/>
              </svg>
              Scan
            </button>
            <button className="btn btn-primary btn-sm" style={{ flexShrink:0 }} onClick={openAddProduct}>
              + New
            </button>
          </div>

          {/* CSV Bulk Import */}
          <div className="csv-import-bar">
            <span className="csv-import-label">📥 Bulk Import</span>
            <input
              type="file" accept=".csv,.txt"
              style={{ display:'none' }} id="csv-upload"
              onChange={e => { setCsvFile(e.target.files?.[0] ?? null); setCsvResult(''); }}
            />
            <label htmlFor="csv-upload" className="btn btn-ghost btn-sm" style={{ cursor:'pointer' }}>
              {csvFile ? `📄 ${csvFile.name}` : 'Choose CSV'}
            </label>
            {csvFile && (
              <button className="btn btn-secondary btn-sm" onClick={handleCsvImport} disabled={csvImporting}>
                {csvImporting ? 'Importing…' : 'Import'}
              </button>
            )}
            {csvResult && <span className="csv-result">{csvResult}</span>}
            <a href="#" style={{ fontSize:'.72rem', color:'var(--text-muted)', textDecoration:'underline' }}
              onClick={e => { e.preventDefault();
                // BOM so Excel opens the UTF-8 file with accents/emoji intact.
                const blob = new Blob(['﻿' + PRODUCT_CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'products_template.csv';
                a.click();
                URL.revokeObjectURL(a.href);
              }}>
              Download template
            </a>
            <span style={{ fontSize:'.7rem', color:'var(--text-muted)', flexBasis:'100%' }}>
              Required: <strong>name</strong> and <strong>price</strong>. Separate tags/extra photos with <code>|</code>,
              and wrap any text containing a comma in quotes.
            </span>
          </div>

          {/* Scan loading indicator */}
          {scanLoading && (
            <div style={{ padding:'10px 16px', display:'flex', alignItems:'center', gap:10, color:'var(--text-muted)', fontSize:'.85rem' }}>
              <span className="btn-spinner" /> Looking up barcode…
            </div>
          )}

          {/* Business Products (from business_products table) */}
          {bpLoading ? (
            <div style={{ padding: '16px' }}>
              {[1,2,3].map(i => <div key={i} className="skeleton" style={{ height: 76, borderRadius: 12, marginBottom: 10 }} />)}
            </div>
          ) : filteredBP.length > 0 && (
            <div className="biz-products-section">
              <div className="biz-section-label">Catalog Products</div>
              <div className="biz-product-list">
                {filteredBP.map(bp => {
                  const p = bp.product;
                  if (!p) return null;
                  const cat = CATEGORIES.find(c => c.id === p.category);
                  return (
                    <div key={bp.id} className={`biz-product-item${bp.isActive ? '' : ' paused'}`}>
                      <div className="biz-product-icon" style={{ width:40, height:40, borderRadius:6, overflow:'hidden' }}>
                        <ProductImage imageUrl={p.imageUrl} imageUrls={p.imageUrls} name={p.name} />
                      </div>
                      <div className="biz-product-info">
                        <div className="biz-product-name">{p.name}</div>
                        {p.brand && <div className="biz-product-brand">{p.brand}</div>}
                        <div className="biz-product-meta">
                          {cat?.icon} {cat?.name}
                          {p.barcode && <span className="biz-product-barcode"> · 🔢 {p.barcode}</span>}
                        </div>
                        {p.tags && p.tags.length > 0 && (
                          <div className="claim-tags-row" style={{ marginTop: 4 }}>
                            {p.tags.slice(0, 3).map(t => <span key={t} className="claim-tag">{t}</span>)}
                          </div>
                        )}
                      </div>
                      <div className="biz-product-pricing">
                        {editBP?.id === bp.id ? (
                          <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                            <input className="form-input" type="number" value={editPrice} onChange={e => setEditPrice(e.target.value)}
                              style={{ width:80, padding:'4px 8px', fontSize:'.82rem' }} placeholder="Price $" />
                            <input className="form-input" type="number" value={editStock} onChange={e => setEditStock(e.target.value)}
                              style={{ width:80, padding:'4px 8px', fontSize:'.82rem' }} placeholder="Stock" />
                            <input className="form-input" type="number" min="1" value={editMoq} onChange={e => setEditMoq(e.target.value)}
                              style={{ width:80, padding:'4px 8px', fontSize:'.82rem' }} placeholder="MOQ" title="Minimum Order Quantity" />
                            <div style={{ display:'flex', gap:4 }}>
                              <button className="btn btn-primary" style={{ fontSize:'.75rem', padding:'4px 8px' }} onClick={saveEditBP} disabled={savingBP}>
                                {savingBP ? '…' : '✓'}
                              </button>
                              <button className="btn btn-ghost" style={{ fontSize:'.75rem', padding:'4px 8px' }} onClick={() => setEditBP(null)}>✕</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="biz-price-mine">${bp.customPrice.toFixed(2)}</div>
                            <div className="biz-price-global">Catalog: ${p.price.toFixed(2)}</div>
                            <div className={`biz-stock-badge${bp.stockQty < 5 ? ' low' : ''}`}>
                              {bp.stockQty} in stock
                            </div>
                            {(bp.moq ?? 1) > 1 && (
                              <div style={{ fontSize:'.72rem', color:'var(--primary)', fontWeight:600, marginTop:2 }}>
                                MOQ: {bp.moq}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      <div className="biz-product-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => openEditBP(bp)} title="Edit price & stock">✏️</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => toggleBPActive(bp)} title={bp.isActive ? 'Pause' : 'Activate'}>
                          {bp.isActive ? '⏸️' : '▶️'}
                        </button>
                        <button className="btn btn-ghost btn-sm" style={{ color:'var(--danger)' }}
                          onClick={() => deleteBP(bp.id)}
                          disabled={deletingBP === bp.id}
                          title="Remove from store"
                        >
                          {deletingBP === bp.id ? '…' : '🗑️'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* My own created products */}
          {supplierProducts.length > 0 && (
            <div className="biz-products-section">
              <div className="biz-section-label">My Created Products</div>
              <div className="biz-product-list">
                {supplierProducts.map(p => {
                  const cat = CATEGORIES.find(c => c.id === p.category);
                  return (
                    <div key={p.id} className="biz-product-item">
                      <div className="biz-product-icon" style={{ width:40, height:40, borderRadius:6, overflow:'hidden' }}>
                        <ProductImage imageUrl={p.imageUrl} imageUrls={p.imageUrls} name={p.name} />
                      </div>
                      <div className="biz-product-info">
                        <div className="biz-product-name">{p.name}</div>
                        {p.brand && <div className="biz-product-brand">{p.brand}</div>}
                        <div className="biz-product-meta">{cat?.icon} {cat?.name}</div>
                        {p.tags && p.tags.length > 0 && (
                          <div className="claim-tags-row" style={{ marginTop: 4 }}>
                            {p.tags.slice(0, 3).map(t => <span key={t} className="claim-tag">{t}</span>)}
                          </div>
                        )}
                      </div>
                      <div className="biz-product-pricing">
                        <div className="biz-price-mine">${p.price.toFixed(2)}</div>
                        <div className={`biz-stock-badge${p.stock < 5 ? ' low' : ''}`}>{p.stock} in stock</div>
                      </div>
                      <div className="biz-product-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => openEditProduct(p)}>✏️</button>
                        <button className="btn btn-ghost btn-sm" style={{ color:'var(--danger)' }}
                          onClick={() => handleDeleteProduct(p.id)} disabled={deletingId === p.id}>
                          {deletingId === p.id ? '…' : '🗑️'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Empty state */}
          {bizProducts.length === 0 && supplierProducts.length === 0 && !bpLoading && (
            <div className="empty-state" style={{ marginTop: 40 }}>
              <div className="empty-icon">📦</div>
              <div className="empty-title">No products yet</div>
              <div className="empty-sub">Scan a barcode to add a product from the catalog, or create one manually.</div>
              <div style={{ display:'flex', gap:10, marginTop:16 }}>
                <button className="btn btn-primary" onClick={() => setShowScanner(true)}>
                  📷 Scan Barcode
                </button>
                <button className="btn btn-ghost" onClick={openAddProduct}>+ Create New</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════ TAB: EDIT PROFILE ══════════ */}
      {bizTab === 'edit' && (
        <div style={{ padding: '0 16px 100px' }}>
          {!currentSupplier && (
            <div className="auth-error" style={{ marginBottom: 16 }}>No business profile found. Please re-register.</div>
          )}
          {currentSupplier && (
            <>
              {/* Logo / icon */}
              <div className="form-group" style={{ marginTop: 16 }}>
                <label className="form-label">Business Logo</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <div style={{
                    width: 64, height: 64, borderRadius: 14, overflow: 'hidden', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 34,
                  }}>
                    <StoreAvatar value={bizIcon} fallback="🏪" />
                  </div>
                  <div style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>
                    Upload your logo — it shows on your store, profile, and every receipt. Or pick an emoji below.
                  </div>
                </div>
                <ProductImageUpload
                  urls={isLogoUrl(bizIcon) ? [bizIcon] : []}
                  onChange={(urls) => setBizIcon(urls[0] ?? '🏪')}
                  maxPhotos={1}
                />
                <div className="emoji-picker-row" style={{ marginTop: 10 }}>
                  {BIZ_ICONS.map(em => (
                    <button key={em} type="button" className={`avatar-opt ${bizIcon === em ? 'selected' : ''}`} onClick={() => setBizIcon(em)}>{em}</button>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Business Name</label>
                <input className="form-input" value={bizName} onChange={e => setBizName(e.target.value)} placeholder="Your business name" />
              </div>

              <div className="form-group">
                <label className="form-label">Delivery time</label>
                <input className="form-input" value={deliveryDays} onChange={e => setDeliveryDays(e.target.value)} placeholder="e.g. 2-4 days, same day" />
                <div style={{ fontSize: '.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  Shown to customers on your storefront and products.
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Location</label>
                <input className="form-input" value={location} onChange={e => setLocation(e.target.value)} placeholder="City, Country" />

                {/* One-tap GPS — auto-detects exact coordinates and shows them */}
                <button
                  type="button"
                  className="btn btn-outline btn-full"
                  style={{ marginTop: 8, gap: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={detectLocation}
                  disabled={locating}
                >
                  {locating ? <><span className="btn-spinner" /> Detecting…</> : <>📍 Detect my location</>}
                </button>

                {lat != null && lng != null ? (
                  <div style={{
                    marginTop: 8, padding: '10px 12px', borderRadius: 10,
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    display: 'flex', flexDirection: 'column', gap: 8, fontSize: '.82rem',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontWeight: 600 }}>
                      <span style={{ color: 'var(--success, #059669)' }}>
                        ✓ Saved: {lat.toFixed(5)}, {lng.toFixed(5)}
                      </span>
                      <button
                        type="button"
                        onClick={() => { setLat(null); setLng(null); saveCoords(null, null); }}
                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '.8rem' }}
                      >
                        clear
                      </button>
                    </div>
                    {/* Shareable Google Maps directions link to the store */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <a
                        href={mapsDirectionsUrl(lat, lng)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-outline btn-sm"
                        style={{ gap: 6 }}
                      >
                        🧭 Open in Google Maps
                      </a>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          navigator.clipboard?.writeText(mapsDirectionsUrl(lat, lng))
                            .then(() => toast('Directions link copied ✓', 'success'))
                            .catch(() => toast('Could not copy', 'error'));
                        }}
                      >
                        📋 Copy link
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '.74rem', color: 'var(--text-muted)', marginTop: 6 }}>
                    Tap once while at your store — it asks for permission, then auto-saves your exact lat/long.
                  </div>
                )}
              </div>

              {/* Store link — the store's own web address on our domain */}
              <div className="form-group">
                <label className="form-label">
                  🔗 Your Store Link
                  <span style={{ fontWeight:400, color:'var(--text-muted)', marginLeft:6, fontSize:'.78rem' }}>
                    your store&apos;s own web address
                  </span>
                </label>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ color:'var(--text-muted)', fontSize:'.85rem', flexShrink:0 }}>
                    {typeof window !== 'undefined' ? window.location.host : 'hamarmall.com'}/
                  </span>
                  <input
                    className="form-input"
                    placeholder="your-store-name"
                    value={bizSlug}
                    onChange={e => { setBizSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); setSlugError(''); }}
                    maxLength={30}
                  />
                  {/* One-tap suggestion from the business name */}
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{ flexShrink:0 }}
                    title="Suggest from business name"
                    onClick={() => { const s = slugify(bizName); if (s) { setBizSlug(s); setSlugError(''); } }}
                  >
                    ✨ Suggest
                  </button>
                </div>

                {/* Live availability feedback */}
                {slugError
                  ? <div className="auth-error" style={{ marginTop:6, fontSize:'.78rem' }}>{slugError}</div>
                  : slugStatus === 'checking' ? (
                    <div style={{ fontSize:'.76rem', color:'var(--text-muted)', marginTop:4 }}>Checking availability…</div>
                  ) : slugStatus === 'taken' ? (
                    <div className="auth-error" style={{ marginTop:6, fontSize:'.78rem' }}>✗ Already taken by another store</div>
                  ) : slugStatus === 'reserved' ? (
                    <div className="auth-error" style={{ marginTop:6, fontSize:'.78rem' }}>✗ That name is reserved — pick another</div>
                  ) : slugStatus === 'free' ? (
                    <div style={{ fontSize:'.76rem', color:'var(--success, #059669)', fontWeight:600, marginTop:4 }}>
                      ✓ Available — save to claim it
                    </div>
                  ) : null}

                {/* The live link, ready to share */}
                {currentSupplier?.slug && (
                  <div style={{
                    marginTop:8, padding:'10px 12px', borderRadius:10,
                    background:'var(--surface)', border:'1px solid var(--border)',
                    display:'flex', alignItems:'center', gap:8, flexWrap:'wrap',
                  }}>
                    <span style={{ fontSize:'.82rem', fontWeight:700, wordBreak:'break-all', flex:1, minWidth:140 }}>
                      {typeof window !== 'undefined' ? `${window.location.origin}/${currentSupplier.slug}` : `/${currentSupplier.slug}`}
                    </span>
                    <button
                      type="button" className="btn btn-outline btn-sm"
                      onClick={() => {
                        navigator.clipboard?.writeText(`${window.location.origin}/${currentSupplier.slug}`)
                          .then(() => toast('Store link copied — share it anywhere', 'success'))
                          .catch(() => toast('Could not copy link', 'error'));
                      }}
                    >
                      📋 Copy
                    </button>
                    <a
                      className="btn btn-outline btn-sm"
                      href={`/${currentSupplier.slug}`}
                      target="_blank" rel="noopener noreferrer"
                    >
                      ↗ Open
                    </a>
                  </div>
                )}
              </div>

              {/* Field-agent link code — the real owner hands this to a field
                  agent so they can register + set up the store. Hidden while an
                  agent is already acting on the store. */}
              {!actingStore && currentSupplier && (
                <div className="form-group">
                  <label className="form-label">
                    🧑‍💼 Field-agent code
                    <span style={{ fontWeight:400, color:'var(--text-muted)', marginLeft:6, fontSize:'.78rem' }}>
                      let an agent set up your store
                    </span>
                  </label>
                  {currentSupplier.registeredByAgentId ? (
                    <div style={{ padding:'10px 12px', borderRadius:10, background:'var(--surface)', border:'1px solid var(--border)', fontSize:'.82rem', lineHeight:1.5 }}>
                      ✅ A field agent is registered on your store
                      {currentSupplier.approvalStatus === 'approved'
                        ? ' and it has been approved — you now run it yourself.'
                        : currentSupplier.approvalStatus === 'pending'
                          ? ' and submitted it for review.'
                          : ' and is setting it up.'}
                    </div>
                  ) : currentSupplier.agentLinkCode ? (
                    <>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <span style={{ flex:1, fontFamily:'monospace', fontSize:'1.05rem', fontWeight:700, letterSpacing:'.12em', padding:'9px 12px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10 }}>
                          {currentSupplier.agentLinkCode}
                        </span>
                        <button type="button" className="btn btn-outline btn-sm" style={{ flexShrink:0 }}
                          onClick={() => {
                            navigator.clipboard?.writeText(currentSupplier.agentLinkCode ?? '')
                              .then(() => toast('Code copied — share it with your field agent', 'success'))
                              .catch(() => toast('Could not copy', 'error'));
                          }}>
                          📋 Copy
                        </button>
                      </div>
                      <div style={{ fontSize:'.76rem', color:'var(--text-muted)', marginTop:6, lineHeight:1.5 }}>
                        Optional. Give this code to a Hamar Mall field agent and they can register your store and build your profile + products for you. You stay the owner.
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize:'.78rem', color:'var(--text-muted)' }}>
                      Available after the next update.
                    </div>
                  )}
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Bio / Description</label>
                <textarea className="form-input" rows={4} style={{ resize:'vertical', fontFamily:'inherit' }}
                  placeholder="Tell customers about your business…"
                  value={bio} onChange={e => setBio(e.target.value)} maxLength={400} />
                <div style={{ fontSize:'.75rem', color:'var(--text-muted)', textAlign:'right', marginTop:4 }}>{bio.length}/400</div>
              </div>

              <div className="contacts-section">
                <div className="contacts-section-header">
                  <div className="contacts-section-title">Contact Numbers <span style={{ color:'var(--text-muted)', fontWeight:400 }}>({contacts.length}/4)</span></div>
                </div>
                {contacts.map((num, i) => (
                  <div key={i} className="contact-input-row">
                    <input className="form-input" placeholder="+252 XX XXX XXXX" value={num} onChange={e => updateContact(i, e.target.value)} />
                    <button className="contact-remove-btn" onClick={() => removeContact(i)}>✕</button>
                  </div>
                ))}
                {contacts.length < 4 && (
                  <button className="add-contact-btn" onClick={addContact}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Add contact number
                  </button>
                )}
              </div>

              {/* Hide stock toggle */}
              <div className="form-group">
                <label className="form-label">Visibility Settings</label>
                <button
                  type="button"
                  onClick={() => setHideStock(h => !h)}
                  style={{
                    display:'flex', alignItems:'center', gap:12, width:'100%',
                    background: hideStock ? 'var(--primary-light, #EEF2FF)' : 'var(--surface)',
                    border:`1px solid ${hideStock ? 'var(--primary)' : 'var(--border)'}`,
                    borderRadius:10, padding:'12px 14px', cursor:'pointer', textAlign:'left',
                  }}
                >
                  <span style={{ fontSize:20 }}>{hideStock ? '🔒' : '👁️'}</span>
                  <div>
                    <div style={{ fontWeight:600, fontSize:'.88rem', color:'var(--text)' }}>
                      {hideStock ? 'Stock count hidden from customers' : 'Stock count visible to customers'}
                    </div>
                    <div style={{ fontSize:'.76rem', color:'var(--text-muted)', marginTop:2 }}>
                      {hideStock
                        ? 'Customers see "In stock" instead of exact quantity'
                        : 'Customers can see exact stock numbers on your products'}
                    </div>
                  </div>
                  <div style={{ marginLeft:'auto', flexShrink:0 }}>
                    <div style={{
                      width:38, height:22, borderRadius:11,
                      background: hideStock ? 'var(--primary)' : '#d1d5db',
                      position:'relative', transition:'background .2s',
                    }}>
                      <div style={{
                        position:'absolute', top:3, left: hideStock ? 19 : 3,
                        width:16, height:16, borderRadius:'50%', background:'#fff',
                        transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.2)',
                      }} />
                    </div>
                  </div>
                </button>

                {/* Online-only store toggle */}
                <button
                  type="button"
                  onClick={() => setOnlineOnly(o => !o)}
                  style={{
                    display:'flex', alignItems:'center', gap:12, width:'100%', marginTop:10,
                    background: onlineOnly ? 'var(--primary-light, #EEF2FF)' : 'var(--surface)',
                    border:`1px solid ${onlineOnly ? 'var(--primary)' : 'var(--border)'}`,
                    borderRadius:10, padding:'12px 14px', cursor:'pointer', textAlign:'left',
                  }}
                >
                  <span style={{ fontSize:20 }}>{onlineOnly ? '🌐' : '🏬'}</span>
                  <div>
                    <div style={{ fontWeight:600, fontSize:'.88rem', color:'var(--text)' }}>
                      {onlineOnly ? 'Online-only store' : 'Physical store'}
                    </div>
                    <div style={{ fontSize:'.76rem', color:'var(--text-muted)', marginTop:2 }}>
                      {onlineOnly
                        ? 'Shown as “🌐 Online store”; customers get delivery only (no pickup or map)'
                        : 'Has a shopfront — customers can pick up and see it on the map'}
                    </div>
                  </div>
                  <div style={{ marginLeft:'auto', flexShrink:0 }}>
                    <div style={{
                      width:38, height:22, borderRadius:11,
                      background: onlineOnly ? 'var(--primary)' : '#d1d5db',
                      position:'relative', transition:'background .2s',
                    }}>
                      <div style={{
                        position:'absolute', top:3, left: onlineOnly ? 19 : 3,
                        width:16, height:16, borderRadius:'50%', background:'#fff',
                        transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.2)',
                      }} />
                    </div>
                  </div>
                </button>
              </div>

              {savedBiz && <div className="auth-success" style={{ marginBottom: 12 }}>✓ Profile saved successfully</div>}
              <button className="btn btn-primary btn-full btn-lg" onClick={handleSaveBiz} disabled={savingBiz}>
                {savingBiz ? 'Saving…' : 'Save Profile'}
              </button>

              {/* Verification request */}
              <div className="verif-section">
                <div className="verif-section-title">🛡️ Business Verification</div>
                {currentSupplier?.verified ? (
                  <div className="verif-status verified">✓ Your business is verified</div>
                ) : verifRequest && verifRequest !== 'none' && (verifRequest as VerifRequest).status === 'pending' ? (
                  <div className="verif-status pending">⏳ Verification request pending review</div>
                ) : verifRequest && verifRequest !== 'none' && (verifRequest as VerifRequest).status === 'rejected' ? (
                  <div>
                    <div className="verif-status rejected">❌ Request rejected{(verifRequest as VerifRequest).message ? `: ${(verifRequest as VerifRequest).message}` : ''}</div>
                    <button className="btn btn-ghost btn-sm" style={{ marginTop:8 }} onClick={handleRequestVerification} disabled={requestingVerif}>
                      Re-apply for Verification
                    </button>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize:'.83rem', color:'var(--text-muted)', marginBottom:10 }}>
                      Get a ✓ verified badge on your store. An admin will review your business.
                    </div>
                    <button className="btn btn-secondary btn-full" onClick={handleRequestVerification} disabled={requestingVerif}>
                      {requestingVerif ? 'Sending…' : '🛡️ Request Verification'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════ TAB: COUPONS ══════════ */}
      {bizTab === 'coupons' && (
        <div style={{ padding:'0 16px 100px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'16px 0 12px' }}>
            <div style={{ fontWeight:700, fontSize:'.95rem' }}>🎟️ Promo Codes ({coupons.length})</div>
            <button className="btn btn-primary btn-sm" onClick={() => setShowCouponForm(v => !v)}>
              {showCouponForm ? 'Cancel' : '+ New Coupon'}
            </button>
          </div>

          {/* New coupon form */}
          {showCouponForm && (
            <div className="coupon-form-card">
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <div className="form-group">
                  <label className="form-label">Code *</label>
                  <input className="form-input" placeholder="SAVE20" value={newCoupon.code}
                    onChange={e => setNewCoupon(p => ({ ...p, code: e.target.value.toUpperCase() }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Type</label>
                  <select className="form-input" value={newCoupon.type}
                    onChange={e => setNewCoupon(p => ({ ...p, type: e.target.value }))}>
                    <option value="percent">% Percentage</option>
                    <option value="fixed">$ Fixed Amount</option>
                  </select>
                </div>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10 }}>
                <div className="form-group">
                  <label className="form-label">Value *</label>
                  <input className="form-input" type="number" min="0" placeholder={newCoupon.type === 'percent' ? '20' : '5.00'}
                    value={newCoupon.value} onChange={e => setNewCoupon(p => ({ ...p, value: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Min Order ($)</label>
                  <input className="form-input" type="number" min="0" placeholder="0"
                    value={newCoupon.minOrder} onChange={e => setNewCoupon(p => ({ ...p, minOrder: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Max Uses</label>
                  <input className="form-input" type="number" min="1" placeholder="∞"
                    value={newCoupon.maxUses} onChange={e => setNewCoupon(p => ({ ...p, maxUses: e.target.value }))} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Expires At</label>
                <input className="form-input" type="datetime-local"
                  value={newCoupon.expiresAt} onChange={e => setNewCoupon(p => ({ ...p, expiresAt: e.target.value }))} />
              </div>
              <button className="btn btn-primary btn-full" onClick={handleSaveCoupon}
                disabled={savingCoupon || !newCoupon.code || !newCoupon.value}>
                {savingCoupon ? 'Saving…' : 'Create Coupon'}
              </button>
            </div>
          )}

          {/* Coupons list */}
          {!couponsLoaded ? (
            <div style={{ padding:20, textAlign:'center', color:'var(--text-muted)' }}>Loading…</div>
          ) : coupons.length === 0 ? (
            <div className="empty-state" style={{ marginTop:30 }}>
              <div className="empty-icon">🎟️</div>
              <div className="empty-title">No coupons yet</div>
              <div className="empty-sub">Create promo codes to drive sales</div>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {coupons.map(c => (
                <div key={c.id} className={`coupon-card${c.active ? '' : ' inactive'}`}>
                  <div className="coupon-card-left">
                    <div className="coupon-code">{c.code}</div>
                    <div className="coupon-details">
                      {c.type === 'percent' ? `${c.value}% off` : `$${c.value} off`}
                      {c.minOrder > 0 && ` · min $${c.minOrder}`}
                      {c.maxUses && ` · ${c.usedCount}/${c.maxUses} used`}
                      {c.expiresAt && ` · expires ${new Date(c.expiresAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => toggleCouponActive(c)}>
                      {c.active ? '⏸️' : '▶️'}
                    </button>
                    <button className="btn btn-ghost btn-sm" style={{ color:'var(--danger)' }}
                      onClick={() => deleteCoupon(c.id)}>🗑️</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══════════ TAB: ANALYTICS ══════════ */}
      {bizTab === 'analytics' && (
        <div style={{ padding: '16px 16px 100px' }}>
          <div className="dash-kpi-grid dash-kpi-grid-5" style={{ marginBottom: 20 }}>
            <div className="dash-kpi-card dash-kpi-wide">
              <div className="dash-kpi-icon">💰</div>
              <div className="dash-kpi-value">
                {!bizOrdersLoaded ? '…' : totalShopRevenue >= 1000 ? `$${(totalShopRevenue / 1000).toFixed(1)}k` : `$${totalShopRevenue.toFixed(0)}`}
              </div>
              <div className="dash-kpi-label">Total Shop Revenue</div>
            </div>
            <div className="dash-kpi-card">
              <div className="dash-kpi-icon">📦</div>
              <div className="dash-kpi-value">{bizProducts.length + supplierProducts.length}</div>
              <div className="dash-kpi-label">Total Products</div>
            </div>
            <div className="dash-kpi-card">
              <div className="dash-kpi-icon">✅</div>
              <div className="dash-kpi-value">{bizProducts.filter(b => b.isActive).length}</div>
              <div className="dash-kpi-label">Active Listings</div>
            </div>
            <div className="dash-kpi-card">
              <div className="dash-kpi-icon">⭐</div>
              <div className="dash-kpi-value">{currentSupplier?.rating?.toFixed(1) ?? '–'}</div>
              <div className="dash-kpi-label">Avg Rating</div>
            </div>
            <div className="dash-kpi-card">
              <div className="dash-kpi-icon">💬</div>
              <div className="dash-kpi-value">{currentSupplier?.reviews ?? 0}</div>
              <div className="dash-kpi-label">Reviews</div>
            </div>
          </div>
          <div style={{ textAlign:'center', color:'var(--text-muted)', padding:'40px 0', fontSize:'.88rem' }}>
            <div style={{ fontSize:'2rem', marginBottom:8 }}>📊</div>
            Full sales analytics available on the Dashboard
            <br /><br />
            <button className="btn btn-primary" onClick={() => router.push('/dashboard')}>Open Dashboard →</button>
          </div>
        </div>
      )}

      {/* ── Scanner Modal ─────────────────────────────── */}
      {showScanner && (
        <BarcodeScanner
          onDetected={code => { setShowScanner(false); handleBarcodeDetected(code); }}
          onClose={() => setShowScanner(false)}
        />
      )}

      {/* ── Claim Modal ───────────────────────────────── */}
      {claimProduct && (
        <div className="modal-overlay" onClick={() => setClaimProduct(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>🛒 Add to Your Store</span>
              <button className="modal-close" onClick={() => setClaimProduct(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="claim-product-card">
                <div className="claim-product-icon" style={{ width:48, height:48, borderRadius:8, overflow:'hidden' }}>
                  <ProductImage imageUrl={claimProduct.imageUrl} imageUrls={claimProduct.imageUrls} name={claimProduct.name} />
                </div>
                <div className="claim-product-info">
                  <div className="claim-product-name">{claimProduct.name}</div>
                  {claimProduct.brand && <div className="claim-product-brand">{claimProduct.brand}</div>}
                  <div className="claim-product-meta">
                    {CATEGORIES.find(c => c.id === claimProduct.category)?.icon}{' '}
                    {CATEGORIES.find(c => c.id === claimProduct.category)?.name}
                  </div>
                  {claimProduct.barcode && <div className="claim-product-barcode">🔢 {claimProduct.barcode}</div>}
                  {claimProduct.tags && claimProduct.tags.length > 0 && (
                    <div className="claim-tags-row">
                      {claimProduct.tags.slice(0, 4).map(t => <span key={t} className="claim-tag">{t}</span>)}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ fontSize:'.8rem', color:'var(--text-muted)', margin:'8px 0' }}>
                Catalog price: <strong>${claimProduct.price.toFixed(2)}</strong>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10 }}>
                <div className="form-group">
                  <label className="form-label">Your Price ($) *</label>
                  <input className="form-input" type="number" min="0" step="0.01" value={claimPrice}
                    onChange={e => setClaimPrice(e.target.value)} autoFocus />
                </div>
                <div className="form-group">
                  <label className="form-label">Stock Qty</label>
                  <input className="form-input" type="number" min="0" value={claimStock}
                    onChange={e => setClaimStock(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label" title="Minimum Order Quantity">MOQ</label>
                  <input className="form-input" type="number" min="1" value={claimMoq}
                    onChange={e => setClaimMoq(e.target.value)} placeholder="1" />
                </div>
              </div>
              <button className="btn btn-primary btn-full btn-lg" onClick={handleClaim} disabled={savingClaim} style={{ marginTop:8 }}>
                {savingClaim ? <><span className="btn-spinner" /> Adding…</> : '✓ Add to My Store'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Product Form Modal — the shared app-wide product form ─── */}
      {showForm && (
        <ProductFormModal
          form={form}
          setForm={setForm}
          saving={savingProd}
          onSave={handleSaveProduct}
          onClose={() => setShowForm(false)}
          editingId={editingProd?.id ?? null}
          suppliers={state.suppliers}
          aiSlot={form.imageUrls.length > 0 ? (
            <AiGenerateButton
              imageUrl={form.imageUrls[0]}
              onResult={result => {
                if (result.name)        pf('name',        result.name);
                if (result.description) pf('description', result.description);
                if (result.brand)       pf('brand',       result.brand);
                if (result.category)    pf('category',    result.category);
                if (result.subCategory) pf('subCategory', result.subCategory);
                if (result.tags?.length) pf('tags', result.tags.join(', '));
              }}
            />
          ) : null}
        />
      )}
    </div>
  );
}
