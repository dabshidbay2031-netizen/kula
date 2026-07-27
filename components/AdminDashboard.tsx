'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useApp }  from '@/context/AppContext';
import type { Supplier, Product, Order } from '@/lib/types';
import { Link } from '@/lib/hashRouter';
import { authHeaders } from '@/lib/clientAuth';
import { getSupabase } from '@/lib/supabase';
import ProductImage from '@/components/ProductImage';
import StoreAvatar from '@/components/StoreAvatar';
import Pagination from '@/components/Pagination';
import { usePagination } from '@/lib/usePagination';
import { COMMISSION_PER_STORE, COMMISSION_INSTALMENTS } from '@/lib/agentCommission';
import type { HeroBanner } from '@/app/api/settings/hero/route';

/* ── Types ──────────────────────────────────────────────────────────── */
type AdminRole = 'admin' | 'semi_admin' | null;
type Tab = 'overview' | 'businesses' | 'review' | 'agents' | 'products' | 'orders' | 'users' | 'team' | 'storefront' | 'payouts';

/** A shop's payout request, as served by /api/admin/payouts. */
interface AdminPayout {
  id: number; supplierId: number; storeName: string; storeIcon: string;
  amount: number; phone: string; status: string;
  note: string | null; createdAt: string; decidedAt: string | null;
}

interface AdminStats {
  totalBusinesses: number; totalSuppliers: number; totalProducts: number;
  totalOrders: number; totalRevenue: number; totalUsers: number;
  pendingVerifications: number; recentOrders: Order[];
  /** False until the is_seed flag is deployed — the numbers still include seed volume. */
  seedExcluded?: boolean;
}
interface AdminUser  { id: string; fullName: string; phone: string; avatar: string; verified: boolean; createdAt: string; }
interface AdminEntry { id: number; userId: string; role: string; name: string; email: string; createdAt: string; }
interface AdminAgent {
  id: number; name: string; icon: string; status: 'pending' | 'approved' | 'rejected';
  createdAt: string; stores: number; instalmentsDue: number; amountDue: number; amountPaid: number;
}
interface CommissionEntry {
  supplierId: number; agentId: number; instalment: number; amount: number;
  status: 'due' | 'paid'; earnedAt: string; paidAt: string | null;
  agentName?: string; storeName?: string;
}

/* ── Shared helpers ─────────────────────────────────────────────────── */
const fmtDate = (s: string) => s ? new Date(s).toLocaleDateString() : '—';
const fmtAmt  = (n: number) => `$${Number(n ?? 0).toFixed(2)}`;

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed:'#10B981', pending:'#F59E0B', cancelled:'#EF4444',
    processing:'#3B82F6', refunded:'#8B5CF6',
  };
  const c = map[status?.toLowerCase()] ?? '#64748B';
  return <span style={{ background:c+'22', color:c, border:`1px solid ${c}44`, borderRadius:99, padding:'2px 10px', fontSize:'.72rem', fontWeight:700, whiteSpace:'nowrap' }}>{status||'unknown'}</span>;
}

function RoleBadge({ role }: { role: string }) {
  const isAdmin = role === 'admin';
  return (
    <span style={{
      background: isAdmin ? '#4F46E522' : '#F59E0B22',
      color:      isAdmin ? '#4F46E5'   : '#B45309',
      border:     isAdmin ? '1px solid #4F46E544' : '1px solid #F59E0B44',
      borderRadius: 99, padding: '2px 10px', fontSize: '.72rem', fontWeight: 700,
    }}>
      {isAdmin ? '👑 Admin' : '👁️ Viewer'}
    </span>
  );
}

const tbl: React.CSSProperties = { width:'100%', borderCollapse:'collapse' };
const th:  React.CSSProperties = { textAlign:'left', padding:'10px 12px', fontSize:'.75rem', fontWeight:700, color:'var(--text-muted)', borderBottom:'1px solid var(--border)', textTransform:'uppercase', letterSpacing:.5, background:'var(--bg)' };
const td:  React.CSSProperties = { padding:'10px 12px', fontSize:'.85rem', borderBottom:'1px solid var(--border)', verticalAlign:'middle' };

/* ══════════════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════════════ */
export default function AdminDashboard() {
  const { user }  = useAuth();
  const { toast } = useApp();

  const [role,    setRole]    = useState<AdminRole>(null);
  const [checking,setChecking]= useState(true);

  // Tab state
  const [tab, setTab] = useState<Tab>('overview');

  // Data
  const [stats,     setStats]     = useState<AdminStats | null>(null);
  const [businesses,setBusinesses]= useState<Supplier[]>([]);
  const [products,  setProducts]  = useState<Product[]>([]);
  const [orders,    setOrders]    = useState<Order[]>([]);
  const [users,     setUsers]     = useState<AdminUser[]>([]);
  // Filter inputs — kept separate from the data so filtering is a VIEW, never
  // a mutation of the loaded rows.
  const [orderStatusFilter, setOrderStatusFilter] = useState('');
  /* Field-agent desk: stores waiting for review, and the agents themselves. */
  const [agents,      setAgents]      = useState<AdminAgent[]>([]);
  const [commissions, setCommissions] = useState<CommissionEntry[]>([]);
  const [trialDays,   setTrialDays]   = useState<Record<number, string>>({});
  const [busyId,      setBusyId]      = useState<number | null>(null);
  const [userQuery,         setUserQuery]         = useState('');
  const [admins,    setAdmins]    = useState<AdminEntry[]>([]);
  const [loading,   setLoading]   = useState(false);

  // Edit states
  const [editBiz,    setEditBiz]    = useState<Supplier | null>(null);
  const [editProd,   setEditProd]   = useState<Product  | null>(null);
  // window.confirm is blocked in the Next 16 / Turbopack runtime, so product
  // deletion is gated by the in-app confirm modal below (setConfirmDeleteProd).
  const [confirmDeleteProd, setConfirmDeleteProd] = useState<{ id: number; name: string } | null>(null);
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

  /* ── Search / filter state ────────────────────────────────────────────────
     These only ever narrow a *derived view*. The fetched `businesses` and
     `products` arrays stay whole, so filters compose with each other and
     clearing a box restores the full list without a refetch. */
  const [bizQuery,  setBizQuery]  = useState('');
  const [prodQuery, setProdQuery] = useState('');
  const [prodCat,   setProdCat]   = useState('');
  const [prodBiz,   setProdBiz]   = useState(0);

  const filteredBusinesses = useMemo(() => {
    const q = bizQuery.trim().toLowerCase();
    if (!q) return businesses;
    return businesses.filter(b =>
      b.name.toLowerCase().includes(q)             ||
      (b.location ?? '').toLowerCase().includes(q) ||
      (b.slug ?? '').toLowerCase().includes(q)     ||
      (b.bio ?? '').toLowerCase().includes(q)      ||
      String(b.id) === q
    );
  }, [businesses, bizQuery]);

  /* Products a store CLAIMED live in business_products, not products.supplier_id.
     Without pulling those in, picking a claim-model store here shows an almost
     empty list even though its storefront is full. Only fetched when one
     specific business is selected. */
  const [claimedForBiz, setClaimedForBiz] = useState<Product[]>([]);
  useEffect(() => {
    if (!prodBiz) { setClaimedForBiz([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/business-products?supplierId=${prodBiz}`, {
          headers: await authHeaders(),
        });
        const bp = await r.json();
        if (cancelled || !Array.isArray(bp)) return;
        setClaimedForBiz(
          bp.filter((x: { product?: Product | null }) => x.product)
            .map((x: { customPrice?: number; stockQty?: number; product: Product }) => ({
              ...x.product,
              price: Number(x.customPrice ?? x.product.price),
              stock: Number(x.stockQty ?? 0),
            }) as Product),
        );
      } catch {
        setClaimedForBiz([]);
      }
    })();
    return () => { cancelled = true; };
  }, [prodBiz]);

  /** Ids shown because the store claimed them (vs. uploaded them) — badged in the table. */
  const claimedIds = useMemo(() => {
    if (!prodBiz) return new Set<number>();
    const owned = new Set(products.filter(p => p.supplierId === prodBiz).map(p => p.id));
    return new Set(claimedForBiz.filter(p => !owned.has(p.id)).map(p => p.id));
  }, [prodBiz, products, claimedForBiz]);

  /** Alphabetical for the Business picker — 84 stores in fetch order is unusable. */
  const sortedBusinesses = useMemo(
    () => [...businesses].sort((a, b) => a.name.localeCompare(b.name)),
    [businesses],
  );

  const filteredProducts = useMemo(() => {
    let list = products;
    if (prodBiz) {
      const owned    = products.filter(p => p.supplierId === prodBiz);
      const ownedIds = new Set(owned.map(p => p.id));
      list = [...owned, ...claimedForBiz.filter(p => !ownedIds.has(p.id))];
    }
    if (prodCat) list = list.filter(p => p.category === prodCat);
    const q = prodQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(q)              ||
        p.sku.toLowerCase().includes(q)               ||
        (p.brand   ?? '').toLowerCase().includes(q)   ||
        (p.barcode ?? '').toLowerCase().includes(q)   ||
        String(p.id) === q                            ||
        (p.tags ?? []).some(t => t.toLowerCase().includes(q))
      );
    }
    return list;
  }, [products, claimedForBiz, prodQuery, prodCat, prodBiz]);

  // Storefront (hero banner) management
  const [hero,         setHero]         = useState<HeroBanner | null>(null);
  const [savingHero,   setSavingHero]   = useState(false);
  const [uploadingHero,setUploadingHero]= useState(false);

  // Team management
  const [showAddAdmin,  setShowAddAdmin]  = useState(false);
  const [newAdminUid,   setNewAdminUid]   = useState('');
  const [newAdminName,  setNewAdminName]  = useState('');
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [newAdminRole,  setNewAdminRole]  = useState<'admin'|'semi_admin'>('semi_admin');
  const [savingAdmin,   setSavingAdmin]   = useState(false);

  const isAdmin = role === 'admin';

  /* ── Auth check ────────────────────────────────────────────────── */
  useEffect(() => {
    if (!user?.id) { setChecking(false); return; }
    fetch(`/api/admin/check?uid=${user.id}`)
      .then(r => r.json())
      .then(d => setRole(d.role ?? null))
      .catch(() => setRole(null))
      .finally(() => setChecking(false));
  }, [user?.id]);

  /* ── Load data ─────────────────────────────────────────────────── */
  const load = useCallback(async (t: Tab) => {
    setLoading(true);
    try {
      if (t === 'overview') {
        const r = await fetch('/api/admin/stats', { headers: await authHeaders() }); setStats(await r.json());
      } else if (t === 'businesses') {
        const r = await fetch('/api/suppliers');   setBusinesses(await r.json());
      } else if (t === 'products') {
        // Suppliers come too: the products list needs them for the "Business"
        // filter dropdown and the Supplier column. Without this the dropdown
        // is empty unless the Businesses tab happened to be opened first.
        const [pr, sr] = await Promise.all([fetch('/api/products'), fetch('/api/suppliers')]);
        setProducts(await pr.json());
        setBusinesses(await sr.json());
      } else if (t === 'orders') {
        const r = await fetch('/api/orders', { headers: await authHeaders() }); setOrders(await r.json());
      } else if (t === 'users') {
        const r = await fetch('/api/admin/users', { headers: await authHeaders() }); setUsers(await r.json());
      } else if (t === 'team') {
        const r = await fetch('/api/admin/admins', { headers: await authHeaders() }); setAdmins(await r.json());
      } else if (t === 'storefront') {
        const r = await fetch('/api/settings/hero'); setHero(await r.json());
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { if (role) load(tab); }, [tab, role, load]);

  // Per-store bounty input buffer. Must live here with the other hooks —
  // above the guard early-returns below — so it runs on every render (React
  // requires a stable, unconditional hook order).
  const [bountyDraft, setBountyDraft] = useState<Record<number, string>>({});

  /* ── Pagination ────────────────────────────────────────────────
     These tables rendered every row at once; Products was capped at a
     hard-coded 200 with the rest simply unreachable. Each pager resets to
     page 1 when its filters change. */
  /* Orders + users are filtered as DERIVED views, the same way products
     already were. The previous handlers filtered the state arrays in place,
     so every non-matching row was destroyed until the next refetch. */
  const filteredOrders = useMemo(() => {
    if (!orderStatusFilter) return orders;
    return orders.filter((o: Order & { status?: string }) =>
      (o.status ?? '').toLowerCase() === orderStatusFilter);
  }, [orders, orderStatusFilter]);

  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u =>
      u.fullName?.toLowerCase().includes(q) || u.phone?.includes(q));
  }, [users, userQuery]);

  /* Stores a field agent has finished and submitted — the review queue. */
  const reviewQueue = useMemo(
    () => businesses.filter(b => b.approvalStatus === 'pending' && b.agentSubmittedAt),
    [businesses],
  );
  const pendingAgents = useMemo(() => agents.filter(a => a.status === 'pending').length, [agents]);

  const bizPager   = usePagination(filteredBusinesses, 25, bizQuery);
  const prodPager  = usePagination(filteredProducts, 25, `${prodQuery}|${prodCat}|${prodBiz}`);
  const orderPager = usePagination(filteredOrders, 25, orderStatusFilter);
  const userPager  = usePagination(filteredUsers, 25, userQuery);

  /* ── Payout requests (admin desk) ──────────────────────────────── */
  const [payouts, setPayouts] = useState<AdminPayout[]>([]);
  const [payoutTotals, setPayoutTotals] = useState({ pending: 0, approved: 0, pendingCount: 0 });
  const [payoutFilter, setPayoutFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [payoutNote, setPayoutNote] = useState<Record<number, string>>({});
  const [decidingId, setDecidingId] = useState<number | null>(null);

  const loadPayouts = useCallback(async (filter: string) => {
    try {
      const qs  = filter === 'all' ? '' : `?status=${filter}`;
      const res = await fetch(`/api/admin/payouts${qs}`, { headers: await authHeaders(), cache: 'no-store' });
      const d   = await res.json();
      if (Array.isArray(d?.payouts)) setPayouts(d.payouts);
      if (d?.totals) setPayoutTotals(d.totals);
    } catch { /* keep what's on screen */ }
  }, []);

  // Keep the tab's pending badge honest even while another tab is open.
  useEffect(() => { if (role) loadPayouts(payoutFilter); }, [role, payoutFilter, loadPayouts]);

  /* ── Field-agent desk ─────────────────────────────────────────── */
  const loadAgents = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/agents', { headers: await authHeaders() });
      if (r.ok) { const d = await r.json(); setAgents(Array.isArray(d.agents) ? d.agents : []); }
    } catch { /* desk simply stays empty */ }
  }, []);

  const loadCommissions = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/commissions?status=all', { headers: await authHeaders() });
      if (r.ok) { const d = await r.json(); setCommissions(Array.isArray(d.rows) ? d.rows : []); }
    } catch { /* ledger not deployed yet */ }
  }, []);

  useEffect(() => {
    if (!role) return;
    // The review queue reads the businesses list; the agent desk has its own.
    if (tab === 'agents') { loadAgents(); loadCommissions(); }
    if (tab === 'review') load('businesses');
  }, [tab, role, loadAgents, loadCommissions, load]);


  const decidePayout = async (id: number, status: 'approved' | 'rejected') => {
    setDecidingId(id);
    try {
      const res = await fetch('/api/admin/payouts', {
        method: 'PATCH', headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id, status, note: payoutNote[id]?.trim() || null }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok) {
        toast(status === 'approved' ? 'Payout approved ✓' : 'Payout rejected', status === 'approved' ? 'success' : 'default');
        setPayoutNote(n => ({ ...n, [id]: '' }));
        await loadPayouts(payoutFilter);
      } else {
        toast(d?.error ?? 'Could not update the request', 'error');
      }
    } catch { toast('Network error', 'error'); }
    finally { setDecidingId(null); }
  };

  /* ── Guards ────────────────────────────────────────────────────── */
  if (checking) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'80vh', flexDirection:'column', gap:12 }}>
      <div className="spinner" style={{ width:36, height:36 }} />
      <span style={{ color:'var(--text-muted)' }}>Checking access…</span>
    </div>
  );

  if (!user) return (
    <div style={{ maxWidth:420, margin:'80px auto', textAlign:'center', padding:24 }}>
      <div style={{ fontSize:48, marginBottom:16 }}>🔒</div>
      <h2 style={{ marginBottom:8 }}>Admin Access</h2>
      <p style={{ color:'var(--text-muted)', marginBottom:20 }}>You need to be logged in to access this page.</p>
      <Link href="/auth/login" className="btn btn-primary">Sign In</Link>
    </div>
  );

  if (role === null) return (
    <div style={{ maxWidth:480, margin:'80px auto', padding:24 }}>
      <div style={{ background:'var(--surface)', borderRadius:16, padding:32, textAlign:'center', border:'1px solid var(--border)' }}>
        <div style={{ fontSize:48, marginBottom:12 }}>⛔</div>
        <h2 style={{ marginBottom:8 }}>Access Denied</h2>
        <p style={{ color:'var(--text-muted)', marginBottom:20, lineHeight:1.6 }}>
          Your account is not authorised to access the admin panel.<br/>
          Ask an existing admin to add you.
        </p>
        <div style={{ background:'var(--bg)', borderRadius:8, padding:'10px 14px', border:'1px solid var(--border)', textAlign:'left', marginBottom:16 }}>
          <div style={{ fontSize:'.75rem', color:'var(--text-muted)', marginBottom:4 }}>Your User ID (give this to the admin):</div>
          <code style={{ fontSize:'.8rem', wordBreak:'break-all', color:'var(--primary)' }}>{user.id}</code>
        </div>
        <Link href="/" className="btn btn-ghost btn-sm">← Back to Store</Link>
      </div>
    </div>
  );

  /* ── Business edit ─────────────────────────────────────────────── */
  const saveBiz = async () => {
    if (!editBiz) return;
    const res = await fetch(`/api/suppliers/${editBiz.id}`, {
      method:'PATCH', headers: await authHeaders({ 'Content-Type':'application/json' }),
      body: JSON.stringify({
        name: editBiz.name, bio: editBiz.bio ?? '', location: editBiz.location,
        verified: editBiz.verified, accountType: editBiz.accountType,
      }),
    });
    if (res.ok) { toast('Saved ✓', 'success'); setEditBiz(null); load('businesses'); }
    else        { toast('Save failed', 'error'); }
  };

  const deleteBiz = async (id: number, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/suppliers/${id}`, { method:'DELETE', headers: await authHeaders() });
    if (res.ok) { toast('Deleted', 'default'); load('businesses'); }
    else        { toast('Delete failed', 'error'); }
  };

  const toggleVerify = async (b: Supplier) => {
    const res = await fetch(`/api/suppliers/${b.id}`, {
      method:'PATCH', headers: await authHeaders({ 'Content-Type':'application/json' }),
      body: JSON.stringify({ verified: !b.verified }),
    });
    if (res.ok) { toast(b.verified ? 'Unverified' : 'Verified ✓', 'success'); load('businesses'); }
    else        { toast('Failed', 'error'); }
  };

  /* ── Trial approval decision ───────────────────────────────────── */

  const decideAgent = async (agentId: number, action: 'approve' | 'reject') => {
    setBusyId(agentId);
    try {
      const r = await fetch('/api/admin/agents', {
        method: 'PATCH',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ agentId, action }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { toast(action === 'approve' ? 'Agent approved ✓' : 'Agent rejected', 'success'); loadAgents(); }
      else toast(d.error || 'Could not update the agent', 'error');
    } finally { setBusyId(null); }
  };

  const payCommission = async (c: CommissionEntry, action: 'pay' | 'unpay') => {
    setBusyId(c.supplierId * 10 + c.instalment);
    try {
      const r = await fetch('/api/admin/commissions', {
        method: 'PATCH',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ supplierId: c.supplierId, instalment: c.instalment, action }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { toast(action === 'pay' ? 'Marked paid ✓' : 'Marked unpaid', 'success'); loadCommissions(); loadAgents(); }
      else toast(d.error || 'Could not update the commission', 'error');
    } finally { setBusyId(null); }
  };

  /** Give a store N free days. A trial unlocks the dashboard but is NOT a
   *  payment — it never earns an agent a commission. */
  const grantTrial = async (b: Supplier, days: number) => {
    setBusyId(b.id);
    try {
      const r = await fetch('/api/admin/trial', {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ supplierId: b.id, days }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { toast(`${days}-day free trial granted ✓`, 'success'); load('businesses'); }
      else toast(d.error || 'Could not grant the trial', 'error');
    } finally { setBusyId(null); }
  };

  const revokeTrial = async (b: Supplier) => {
    setBusyId(b.id);
    try {
      const r = await fetch(`/api/admin/trial?supplierId=${b.id}`, {
        method: 'DELETE', headers: await authHeaders(),
      });
      if (r.ok) { toast('Trial revoked', 'success'); load('businesses'); }
      else toast('Could not revoke the trial', 'error');
    } finally { setBusyId(null); }
  };

  const setApproval = async (b: Supplier, approvalStatus: 'approved' | 'rejected') => {
    const res = await fetch(`/api/suppliers/${b.id}`, {
      method:'PATCH', headers: await authHeaders({ 'Content-Type':'application/json' }),
      body: JSON.stringify({ approvalStatus }),
    });
    if (res.ok) { toast(approvalStatus === 'approved' ? 'Account approved ✓' : 'Request rejected', 'success'); load('businesses'); }
    else        { toast('Failed', 'error'); }
  };

  const APPROVAL_BADGE: Record<string, { label: string; color: string }> = {
    approved: { label: '✅ Approved',     color: '#10B981' },
    pending:  { label: '🕐 Wants approval', color: '#F59E0B' },
    trial:    { label: '⏳ On trial',      color: '#6366F1' },
    rejected: { label: '🚫 Rejected',     color: '#EF4444' },
  };

  /* ── Field-agent bounty (fixed amount, paid manually) ──────────── */
  const setBounty = async (storeId: number, patch: { amount?: number; paid?: boolean }) => {
    const res = await fetch('/api/agent/bounty', {
      method:'PATCH', headers: await authHeaders({ 'Content-Type':'application/json' }),
      body: JSON.stringify({ storeId, ...patch }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { toast(patch.paid === true ? 'Marked paid ✓' : patch.paid === false ? 'Marked unpaid' : 'Bounty saved ✓', 'success'); load('businesses'); }
    else        { toast(d.error ?? 'Failed', 'error'); }
  };

  /* ── Product edit ──────────────────────────────────────────────── */
  const saveProd = async () => {
    if (!editProd) return;
    const res = await fetch(`/api/products/${editProd.id}`, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        name: editProd.name, price: editProd.price, originalPrice: editProd.originalPrice,
        category: editProd.category, stock: editProd.stock,
        description: editProd.description, moq: (editProd as Product & { moq?: number }).moq ?? 1,
      }),
    });
    if (res.ok) { toast('Saved ✓', 'success'); setEditProd(null); load('products'); }
    else        { toast('Save failed', 'error'); }
  };

  const doDeleteProd = async () => {
    if (!confirmDeleteProd) return;
    const { id } = confirmDeleteProd;
    setConfirmDeleteProd(null);
    const res = await fetch(`/api/products/${id}`, { method:'DELETE' });
    if (res.ok) { toast('Deleted', 'default'); load('products'); }
    else        { const e = await res.json().catch(() => ({})); toast(e.error ?? 'Delete failed', 'error'); }
  };

  /* ── Storefront (hero banner) actions ──────────────────────────── */
  const uploadHeroImage = async (file: File) => {
    if (!file.type.startsWith('image/')) { toast('Please choose an image file', 'error'); return; }
    if (file.size > 20 * 1024 * 1024)    { toast('Image must be under 20 MB', 'error'); return; }
    setUploadingHero(true);
    try {
      const sb   = getSupabase();
      const ext  = file.name.split('.').pop() ?? 'jpg';
      const path = `hero/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: upErr } = await sb.storage.from('product-images').upload(path, file, { upsert: false });
      if (upErr) { toast(`Upload failed: ${upErr.message}`, 'error'); return; }
      const { data } = sb.storage.from('product-images').getPublicUrl(path);
      setHero(h => h ? { ...h, imageUrl: data.publicUrl } : h);
      toast('Image uploaded ✓', 'success');
    } finally {
      setUploadingHero(false);
    }
  };

  const saveHero = async () => {
    if (!hero) return;
    setSavingHero(true);
    const res = await fetch('/api/settings/hero', {
      method: 'PUT', headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(hero),
    });
    setSavingHero(false);
    if (res.ok) { toast('Banner saved ✓', 'success'); setHero(await res.json()); }
    else        { const e = await res.json().catch(() => ({})); toast(e.error ?? 'Save failed', 'error'); }
  };

  /* ── Team actions ──────────────────────────────────────────────── */
  const addAdmin = async () => {
    if (!newAdminUid.trim()) { toast('Enter a user UID', 'error'); return; }
    setSavingAdmin(true);
    const res = await fetch('/api/admin/admins', {
      method:'POST', headers: await authHeaders({ 'Content-Type':'application/json' }),
      body: JSON.stringify({ userId: newAdminUid.trim(), role: newAdminRole, name: newAdminName.trim(), email: newAdminEmail.trim() }),
    });
    setSavingAdmin(false);
    if (res.ok) {
      toast(`${newAdminRole === 'admin' ? 'Admin' : 'Viewer'} added ✓`, 'success');
      setShowAddAdmin(false); setNewAdminUid(''); setNewAdminName(''); setNewAdminEmail(''); setNewAdminRole('semi_admin');
      load('team');
    } else {
      const e = await res.json();
      toast(e.error ?? 'Failed to add', 'error');
    }
  };

  const changeRole = async (a: AdminEntry, newRole: 'admin' | 'semi_admin') => {
    const res = await fetch(`/api/admin/admins/${a.id}`, {
      method:'PATCH', headers: await authHeaders({ 'Content-Type':'application/json' }),
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) { toast('Role updated ✓', 'success'); load('team'); }
    else        { toast('Failed', 'error'); }
  };

  const removeAdmin = async (a: AdminEntry) => {
    if (a.userId === user.id) { toast("You can't remove yourself", 'error'); return; }
    if (!confirm(`Remove "${a.name || a.userId}" from admin team?`)) return;
    const res = await fetch(`/api/admin/admins/${a.id}`, { method:'DELETE', headers: await authHeaders() });
    if (res.ok) { toast('Removed', 'default'); load('team'); }
    else        { toast('Failed', 'error'); }
  };

  /* ── TABS ──────────────────────────────────────────────────────── */
  const TABS: { key: Tab; label: string }[] = [
    { key:'overview',    label:'📊 Overview'    },
    { key:'businesses',  label:'🏪 Businesses'  },
    { key:'products',    label:'📦 Products'    },
    { key:'orders',      label:'🧾 Orders'      },
    { key:'users',       label:'👥 Users'       },
    { key:'review' as Tab, label: reviewQueue.length > 0 ? `📝 Review (${reviewQueue.length})` : '📝 Review' },
    ...(isAdmin ? [
      { key:'agents'     as Tab, label: pendingAgents > 0 ? `🧑‍💼 Agents (${pendingAgents})` : '🧑‍💼 Agents' },
      { key:'payouts'    as Tab, label: payoutTotals.pendingCount > 0 ? `💸 Payouts (${payoutTotals.pendingCount})` : '💸 Payouts' },
      { key:'storefront' as Tab, label:'🎨 Storefront' },
      { key:'team'       as Tab, label:'👑 Team' },
    ] : []),
  ];

  /* ── RENDER ────────────────────────────────────────────────────── */
  return (
    <div style={{ minHeight:'100vh', background:'var(--bg)' }}>

      {/* Header */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', padding:'12px 20px', display:'flex', alignItems:'center', justifyContent:'space-between', position:'sticky', top:0, zIndex:100 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:22 }}>⚙️</span>
          <div>
            <div style={{ fontWeight:800, fontSize:'1rem' }}>Hamar Mall Admin</div>
            <div style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>
              {isAdmin ? '👑 Full Admin' : '👁️ View Only'} — {user.displayName || user.id.slice(0,8)}
            </div>
          </div>
        </div>
        <Link href="/" className="btn btn-ghost btn-sm">← Store</Link>
      </div>

      {/* Tab Bar */}
      <div style={{ background:'var(--surface)', borderBottom:'1px solid var(--border)', padding:'0 16px', display:'flex', gap:4, overflowX:'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding:'12px 16px', background:'none', border:'none', cursor:'pointer',
            fontWeight: tab === t.key ? 700 : 400,
            color:      tab === t.key ? 'var(--primary)' : 'var(--text-muted)',
            borderBottom: tab === t.key ? '2px solid var(--primary)' : '2px solid transparent',
            whiteSpace:'nowrap', fontSize:'.85rem',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* View-only banner */}
      {!isAdmin && (
        <div style={{ background:'#FEF3C722', border:'1px solid #F59E0B44', borderRadius:8, margin:'16px 16px 0', padding:'8px 14px', fontSize:'.82rem', color:'#92400E', display:'flex', alignItems:'center', gap:8 }}>
          👁️ <strong>View-only mode.</strong>&nbsp;You can see all data but cannot make changes. Contact an Admin to get full access.
        </div>
      )}

      {/* Content */}
      <div style={{ padding:'16px', maxWidth:1200, margin:'0 auto' }}>
        {loading && tab !== 'overview' ? (
          <div style={{ display:'flex', justifyContent:'center', padding:60 }}>
            <div className="spinner" style={{ width:32, height:32 }} />
          </div>
        ) : (
          <>
            {/* ── OVERVIEW ───────────────────────────────────────── */}
            {tab === 'overview' && (
              <div>
                {stats ? (
                  <>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:12, marginBottom:20 }}>
                      {[
                        { label:'Businesses', value: stats.totalBusinesses, icon:'🏪' },
                        { label:'Suppliers',  value: stats.totalSuppliers,  icon:'🏭' },
                        { label:'Products',   value: stats.totalProducts,   icon:'📦' },
                        { label:'Orders',     value: stats.totalOrders,     icon:'🧾' },
                        { label:'Revenue',    value: fmtAmt(stats.totalRevenue), icon:'💰' },
                        { label:'Users',      value: stats.totalUsers,      icon:'👥' },
                      ].map(s => (
                        <div key={s.label} style={{ background:'var(--surface)', borderRadius:12, padding:'16px 14px', border:'1px solid var(--border)' }}>
                          <div style={{ fontSize:22, marginBottom:4 }}>{s.icon}</div>
                          <div style={{ fontSize:'1.4rem', fontWeight:800 }}>{s.value}</div>
                          <div style={{ fontSize:'.75rem', color:'var(--text-muted)', marginTop:2 }}>{s.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* Say plainly whether these are real numbers or still
                        carrying seeded volume — an unlabelled KPI is worse
                        than no KPI. */}
                    <div style={{ fontSize:'.75rem', color:'var(--text-muted)', margin:'-10px 0 18px' }}>
                      {stats.seedExcluded
                        ? '✅ Seed and test data excluded — these are real figures.'
                        : '⚠️ Includes seed/test data. Run RUN-THIS-grants-and-seed-flags.sql to exclude it.'}
                    </div>
                    {stats.pendingVerifications > 0 && (
                      <div style={{ background:'#FEF3C7', border:'1px solid #F59E0B', borderRadius:10, padding:'10px 14px', marginBottom:16, fontSize:'.88rem', color:'#92400E' }}>
                        ⏳ <strong>{stats.pendingVerifications}</strong> verification request{stats.pendingVerifications > 1 ? 's' : ''} pending
                      </div>
                    )}
                    <div style={{ background:'var(--surface)', borderRadius:12, border:'1px solid var(--border)', overflow:'hidden' }}>
                      <div style={{ padding:'14px 16px', fontWeight:700, borderBottom:'1px solid var(--border)' }}>🕐 Recent Orders</div>
                      <div style={{ overflowX:'auto' }}>
                        <table style={tbl}>
                          <thead><tr>
                            <th style={th}>Order ID</th><th style={th}>Customer</th>
                            <th style={th}>Items</th><th style={th}>Total</th>
                            <th style={th}>Payment</th><th style={th}>Status</th><th style={th}>Date</th>
                          </tr></thead>
                          <tbody>
                            {(stats.recentOrders ?? []).map(o => (
                              <tr key={o.id}>
                                <td style={td}><code style={{ fontSize:'.75rem' }}>{o.id}</code></td>
                                <td style={td}>{(o as Order & { customerName?: string }).customerName}</td>
                                <td style={td}>{Array.isArray((o as Order & { items?: unknown[] }).items) ? (o as Order & { items: unknown[] }).items.length : 0}</td>
                                <td style={td}><strong>{fmtAmt((o as Order & { total?: number }).total ?? 0)}</strong></td>
                                <td style={td}>{(o as Order & { paymentMethod?: string }).paymentMethod}</td>
                                <td style={td}><StatusBadge status={(o as Order & { status?: string }).status ?? ''} /></td>
                                <td style={td}>{fmtDate((o as Order & { createdAt?: string }).createdAt ?? '')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ display:'flex', justifyContent:'center', padding:60 }}><div className="spinner" style={{ width:32, height:32 }} /></div>
                )}
              </div>
            )}

            {/* ── BUSINESSES ─────────────────────────────────────── */}
            {tab === 'businesses' && (
              <div>
                <div style={{ display:'flex', gap:10, marginBottom:14, alignItems:'center', flexWrap:'wrap' }}>
                  <input
                    className="form-input"
                    type="search"
                    placeholder="Search name, location, link or ID…"
                    style={{ maxWidth:300 }}
                    value={bizQuery}
                    onChange={e => setBizQuery(e.target.value)}
                    aria-label="Search businesses"
                  />
                  <span style={{ fontSize:'.8rem', color:'var(--text-muted)' }}>
                    {filteredBusinesses.length}
                    {filteredBusinesses.length !== businesses.length && ` of ${businesses.length}`}
                    {' '}business{filteredBusinesses.length === 1 ? '' : 'es'}
                  </span>
                  {bizQuery && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setBizQuery('')}>Clear</button>
                  )}
                </div>
                <div style={{ background:'var(--surface)', borderRadius:12, border:'1px solid var(--border)', overflow:'hidden' }}>
                  <div style={{ overflowX:'auto' }}>
                    <table style={tbl}>
                      <thead><tr>
                        <th style={th}>Name</th><th style={th}>Type</th>
                        <th style={th}>Location</th><th style={th}>Status</th>
                        {isAdmin && <th style={th}>Actions</th>}
                      </tr></thead>
                      <tbody>
                        {bizPager.visible.map(b => (
                          <tr key={b.id}>
                            <td style={td}>
                              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                                <span style={{ width:32, height:32, flexShrink:0, borderRadius:8, overflow:'hidden', display:'grid', placeItems:'center', fontSize:20, background:'var(--bg)', border:'1px solid var(--border)' }}>
                                  <StoreAvatar value={b.icon} />
                                </span>
                                <div>
                                  <div style={{ fontWeight:600 }}>{b.name}</div>
                                  {b.bio && <div style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{b.bio.slice(0,40)}{b.bio.length>40?'…':''}</div>}
                                </div>
                              </div>
                            </td>
                            <td style={td}>
                              <span style={{ fontSize:'.8rem' }}>{b.accountType === 'supplier' ? '🏭 Supplier' : '🏪 Business'}</span>
                            </td>
                            <td style={td}>{b.location || '—'}</td>
                            <td style={td}>
                              {b.verified
                                ? <span style={{ color:'#10B981', fontWeight:600, fontSize:'.8rem' }}>✅ Verified</span>
                                : <span style={{ color:'#F59E0B', fontWeight:600, fontSize:'.8rem' }}>⏳ Pending</span>}
                              {b.approvalStatus && (
                                <div style={{ color: APPROVAL_BADGE[b.approvalStatus]?.color, fontWeight:600, fontSize:'.74rem', marginTop:3 }}>
                                  {APPROVAL_BADGE[b.approvalStatus]?.label}
                                </div>
                              )}
                              {b.registeredByAgentId != null && (
                                <div style={{ color:'#8B5CF6', fontWeight:600, fontSize:'.74rem', marginTop:3 }}>
                                  🧑‍💼 Agent #{b.registeredByAgentId}
                                </div>
                              )}
                            </td>
                            {isAdmin && (
                              <td style={td}>
                                <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                                  {b.approvalStatus && b.approvalStatus !== 'approved' && (
                                    <button className="btn btn-primary btn-sm" onClick={() => setApproval(b, 'approved')}>✔ Approve</button>
                                  )}
                                  {b.approvalStatus === 'pending' && (
                                    <button className="btn btn-ghost btn-sm" style={{ color:'var(--danger)' }} onClick={() => setApproval(b, 'rejected')}>✖ Reject</button>
                                  )}
                                  <button className="btn btn-secondary btn-sm" onClick={() => setEditBiz({ ...b })}>✏️ Edit</button>
                                  <button className="btn btn-secondary btn-sm" onClick={() => toggleVerify(b)}>
                                    {b.verified ? '⏸ Unverify' : '✅ Verify'}
                                  </button>
                                  <button className="btn btn-ghost btn-sm" style={{ color:'var(--danger)' }} onClick={() => deleteBiz(b.id, b.name)}>🗑️</button>
                                </div>

                                {/* Field-agent bounty — only for agent-registered stores */}
                                {b.registeredByAgentId != null && (
                                  <div style={{ marginTop:8, padding:'8px 10px', borderRadius:8, background:'var(--surface)', border:'1px dashed var(--border)' }}>
                                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)', marginBottom:6 }}>
                                      Agent bounty · store {b.subscriptionPaidAt && !b.subscriptionRefundedAt
                                        ? <span style={{ color:'#10B981', fontWeight:600 }}>paying ●</span>
                                        : <span style={{ color:'var(--text-muted)', fontWeight:600 }}>not paying ○</span>}
                                    </div>
                                    <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
                                      <span style={{ fontSize:'.8rem' }}>$</span>
                                      <input
                                        className="form-input" type="number" min="0" step="0.01"
                                        style={{ width:80, padding:'4px 8px', fontSize:'.8rem' }}
                                        placeholder={b.agentBountyAmount != null ? String(b.agentBountyAmount) : '0.00'}
                                        value={bountyDraft[b.id] ?? ''}
                                        onChange={e => setBountyDraft(d => ({ ...d, [b.id]: e.target.value }))}
                                      />
                                      <button className="btn btn-secondary btn-sm"
                                        onClick={() => setBounty(b.id, { amount: Number(bountyDraft[b.id] ?? b.agentBountyAmount ?? 0) })}>
                                        Set
                                      </button>
                                      {b.agentBountyPaidAt
                                        ? <button className="btn btn-ghost btn-sm" onClick={() => setBounty(b.id, { paid: false })}>↩ Unpay</button>
                                        : <button className="btn btn-primary btn-sm"
                                            disabled={b.agentBountyAmount == null || !(b.subscriptionPaidAt && !b.subscriptionRefundedAt)}
                                            title={!(b.subscriptionPaidAt && !b.subscriptionRefundedAt) ? 'Store must be paying first' : b.agentBountyAmount == null ? 'Set an amount first' : 'Mark the bounty paid'}
                                            onClick={() => setBounty(b.id, { paid: true })}>💵 Mark paid</button>}
                                    </div>
                                    {b.agentBountyPaidAt && (
                                      <div style={{ fontSize:'.7rem', color:'#10B981', marginTop:4 }}>
                                        ✓ Paid ${(b.agentBountyAmount ?? 0).toFixed(2)}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                        {filteredBusinesses.length === 0 && <tr><td colSpan={isAdmin?5:4} style={{ ...td, textAlign:'center', color:'var(--text-muted)' }}>{bizQuery ? `No businesses match "${bizQuery}"` : 'No businesses found'}</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={bizPager.page} totalPages={bizPager.totalPages} onPage={bizPager.setPage}
                    from={bizPager.from} to={bizPager.to} total={bizPager.total} label="businesses"
                  />
                </div>
              </div>
            )}

            {/* ── PRODUCTS ───────────────────────────────────────── */}
            {tab === 'products' && (
              <div>
                <div style={{ display:'flex', gap:10, marginBottom:14, flexWrap:'wrap', alignItems:'center' }}>
                  <input
                    className="form-input"
                    type="search"
                    placeholder="Search name, SKU, brand, barcode, tag or ID…"
                    style={{ maxWidth:280 }}
                    value={prodQuery}
                    onChange={e => setProdQuery(e.target.value)}
                    aria-label="Search products"
                  />
                  <select
                    className="form-input" style={{ maxWidth:180 }}
                    value={prodCat}
                    onChange={e => setProdCat(e.target.value)}
                    aria-label="Filter by category"
                  >
                    <option value="">All Categories</option>
                    {['electronics','clothes','home','food','health','sports','medicine','cosmetics','construction','furniture','cars','books','other'].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <select
                    className="form-input" style={{ maxWidth:200 }}
                    value={prodBiz || ''}
                    onChange={e => setProdBiz(parseInt(e.target.value) || 0)}
                    aria-label="Filter by business"
                  >
                    <option value="">All Businesses</option>
                    {sortedBusinesses.map(b => <option key={b.id} value={b.id}>{b.icon} {b.name}</option>)}
                  </select>
                  <span style={{ fontSize:'.8rem', color:'var(--text-muted)' }}>
                    {filteredProducts.length}
                    {filteredProducts.length !== products.length && ` of ${products.length}`}
                    {' '}product{filteredProducts.length === 1 ? '' : 's'}
                  </span>
                  {(prodQuery || prodCat || prodBiz) && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setProdQuery(''); setProdCat(''); setProdBiz(0); }}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div style={{ background:'var(--surface)', borderRadius:12, border:'1px solid var(--border)', overflow:'hidden' }}>
                  <div style={{ overflowX:'auto' }}>
                    <table style={tbl}>
                      <thead><tr>
                        <th style={th}>Product</th><th style={th}>Category</th>
                        <th style={th}>Price</th><th style={th}>Stock</th>
                        <th style={th}>Supplier</th>
                        {isAdmin && <th style={th}>Actions</th>}
                      </tr></thead>
                      <tbody>
                        {prodPager.visible.map(p => {
                          const sup = businesses.find(b => b.id === p.supplierId);
                          return (
                            <tr key={p.id}>
                              <td style={td}>
                                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                                  <div style={{ width:36, height:36, borderRadius:8, background:'var(--border-light,#f1f5f9)', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden', flexShrink:0 }}>
                                    <ProductImage imageUrl={p.imageUrl} imageUrls={p.imageUrls} name={p.name} />
                                  </div>
                                  <div>
                                    <div style={{ fontWeight:600, fontSize:'.85rem' }}>{p.name}</div>
                                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{p.sku}</div>
                                  </div>
                                </div>
                              </td>
                              <td style={td}><span style={{ fontSize:'.78rem', background:'var(--bg)', border:'1px solid var(--border)', borderRadius:6, padding:'2px 7px' }}>{p.category}</span></td>
                              <td style={td}><strong>{fmtAmt(p.price)}</strong></td>
                              <td style={td}>
                                <span style={{ color: p.stock === 0 ? '#EF4444' : p.stock <= 10 ? '#F59E0B' : 'inherit' }}>
                                  {p.stock}
                                </span>
                              </td>
                              <td style={td}>
                                {claimedIds.has(p.id) ? (
                                  // Listed by the selected store via the claim model — the
                                  // catalog row itself belongs to whoever uploaded it.
                                  <span title={sup ? `Catalog owner: ${sup.name}` : 'Claimed from the shared catalog'}
                                        style={{ fontSize:'.72rem', fontWeight:700, color:'#0369A1', background:'#0EA5E922', border:'1px solid #0EA5E944', borderRadius:99, padding:'2px 8px', whiteSpace:'nowrap' }}>
                                    🔗 Claimed
                                  </span>
                                ) : (sup ? `${sup.icon} ${sup.name}` : '—')}
                              </td>
                              {isAdmin && (
                                <td style={td}>
                                  <div style={{ display:'flex', gap:6 }}>
                                    <button className="btn btn-secondary btn-sm" onClick={() => setEditProd({ ...p })}>✏️</button>
                                    <button className="btn btn-ghost btn-sm" style={{ color:'var(--danger)' }} onClick={() => setConfirmDeleteProd({ id: p.id, name: p.name })}>🗑️</button>
                                  </div>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                        {filteredProducts.length === 0 && <tr><td colSpan={isAdmin?6:5} style={{ ...td, textAlign:'center', color:'var(--text-muted)' }}>{(prodQuery || prodCat || prodBiz) ? 'No products match these filters' : 'No products'}</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={prodPager.page} totalPages={prodPager.totalPages} onPage={prodPager.setPage}
                    from={prodPager.from} to={prodPager.to} total={prodPager.total} label="products"
                  />
                </div>
              </div>
            )}

            {/* ── ORDERS ─────────────────────────────────────────── */}
            {tab === 'orders' && (
              <div>
                <div style={{ display:'flex', gap:10, marginBottom:14 }}>
                  {/* Filtering must never mutate the source list. The old
                      handler did setOrders(prev => prev.filter(...)), which
                      DELETED the non-matching orders from state — switching
                      back to "All" showed a wrong list until a full refetch. */}
                  <select className="form-input" style={{ maxWidth:180 }}
                    value={orderStatusFilter}
                    onChange={e => setOrderStatusFilter(e.target.value)}>
                    <option value="">All Statuses</option>
                    <option value="pending">Pending</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
                <div style={{ background:'var(--surface)', borderRadius:12, border:'1px solid var(--border)', overflow:'hidden' }}>
                  <div style={{ overflowX:'auto' }}>
                    <table style={tbl}>
                      <thead><tr>
                        <th style={th}>Order ID</th><th style={th}>Customer</th>
                        <th style={th}>Items</th><th style={th}>Total</th>
                        <th style={th}>Payment</th><th style={th}>Status</th><th style={th}>Date</th>
                      </tr></thead>
                      <tbody>
                        {(orderPager.visible as (Order & { customerName?: string; customerPhone?: string; items?: {id:number;qty:number}[]; total?: number; paymentMethod?: string; status?: string; createdAt?: string })[]).map(o => (
                          <React.Fragment key={o.id}>
                            <tr style={{ cursor:'pointer' }} onClick={() => setExpandedOrder(expandedOrder === o.id ? null : o.id)}>
                              <td style={td}><code style={{ fontSize:'.75rem' }}>{o.id}</code></td>
                              <td style={td}>
                                <div style={{ fontWeight:600 }}>{o.customerName}</div>
                                <div style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{o.customerPhone}</div>
                              </td>
                              <td style={td}>{o.items?.length ?? 0}</td>
                              <td style={td}><strong>{fmtAmt(o.total ?? 0)}</strong></td>
                              <td style={td}>{o.paymentMethod}</td>
                              <td style={td}><StatusBadge status={o.status ?? ''} /></td>
                              <td style={td}>{fmtDate(o.createdAt ?? '')}</td>
                            </tr>
                            {expandedOrder === o.id && (
                              <tr>
                                <td colSpan={7} style={{ ...td, background:'var(--bg)', paddingTop:0 }}>
                                  <div style={{ padding:'10px 0', display:'flex', gap:8, flexWrap:'wrap' }}>
                                    {(o.items ?? []).map((item, i) => {
                                      const p = products.find(x => x.id === item.id);
                                      return (
                                        <div key={i} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'6px 12px', fontSize:'.8rem' }}>
                                          {p ? p.name : `Product #${item.id}`}
                                          {' '}<strong>× {item.qty}</strong>
                                          {p && <span style={{ color:'var(--text-muted)', marginLeft:6 }}>{fmtAmt(p.price * item.qty)}</span>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                        {orders.length === 0 && <tr><td colSpan={7} style={{ ...td, textAlign:'center', color:'var(--text-muted)' }}>No orders</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={orderPager.page} totalPages={orderPager.totalPages} onPage={orderPager.setPage}
                    from={orderPager.from} to={orderPager.to} total={orderPager.total} label="orders"
                  />
                </div>
              </div>
            )}

            {/* ── USERS ──────────────────────────────────────────── */}
            {tab === 'users' && (
              <div>
                <div style={{ marginBottom:14 }}>
                  {/* Derived view — searching no longer destroys the user list. */}
                  <input className="form-input" placeholder="Search users by name or phone…" style={{ maxWidth:320 }}
                    value={userQuery}
                    onChange={e => setUserQuery(e.target.value)}
                  />
                </div>
                <div style={{ background:'var(--surface)', borderRadius:12, border:'1px solid var(--border)', overflow:'hidden' }}>
                  <div style={{ overflowX:'auto' }}>
                    <table style={tbl}>
                      <thead><tr>
                        <th style={th}>User</th><th style={th}>Phone</th>
                        <th style={th}>Verified</th><th style={th}>Joined</th>
                      </tr></thead>
                      <tbody>
                        {userPager.visible.map(u => (
                          <tr key={u.id}>
                            <td style={td}>
                              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                                <span style={{ fontSize:22 }}>{u.avatar || '👤'}</span>
                                <div>
                                  <div style={{ fontWeight:600 }}>{u.fullName || 'Unnamed'}</div>
                                  <div style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{u.id.slice(0,12)}…</div>
                                </div>
                              </div>
                            </td>
                            <td style={td}>{u.phone || '—'}</td>
                            <td style={td}>
                              {u.verified
                                ? <span style={{ color:'#10B981', fontSize:'.8rem' }}>✅ Yes</span>
                                : <span style={{ color:'var(--text-muted)', fontSize:'.8rem' }}>—</span>}
                            </td>
                            <td style={td}>{fmtDate(u.createdAt)}</td>
                          </tr>
                        ))}
                        {users.length === 0 && <tr><td colSpan={4} style={{ ...td, textAlign:'center', color:'var(--text-muted)' }}>No users found</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={userPager.page} totalPages={userPager.totalPages} onPage={userPager.setPage}
                    from={userPager.from} to={userPager.to} total={userPager.total} label="users"
                  />
                </div>
              </div>
            )}

            {/* ── PAYOUTS (admin only) ────────────────────────────── */}
            {/* ── REVIEW QUEUE: stores a field agent finished ───── */}
            {tab === 'review' && (
              <div>
                <p style={{ color:'var(--text-muted)', fontSize:'.85rem', marginBottom:14 }}>
                  Stores a field agent has set up and submitted. Approving one ends the
                  agent&apos;s edit access and starts their commission — the first
                  ${COMMISSION_PER_STORE} is earned once the store makes a real payment.
                </p>
                {reviewQueue.length === 0 ? (
                  <div style={{ background:'var(--surface)', borderRadius:12, border:'1px solid var(--border)', padding:32, textAlign:'center', color:'var(--text-muted)' }}>
                    Nothing waiting for review.
                  </div>
                ) : (
                  <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    {reviewQueue.map(b => (
                      <div key={b.id} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'14px 16px' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                          <strong>{b.icon} {b.name}</strong>
                          <span style={{ fontSize:'.74rem', color:'var(--text-muted)' }}>
                            {b.accountType} · submitted {b.agentSubmittedAt ? new Date(b.agentSubmittedAt).toLocaleDateString() : '—'}
                          </span>
                          <span style={{ marginLeft:'auto', fontSize:'.74rem', color:'var(--text-muted)' }}>
                            agent #{b.registeredByAgentId ?? '—'}
                          </span>
                        </div>
                        <div style={{ display:'flex', gap:8, marginTop:12, flexWrap:'wrap' }}>
                          {isAdmin && (
                            <>
                              <button className="btn btn-primary btn-sm" disabled={busyId === b.id}
                                onClick={() => setApproval(b, 'approved')}>✓ Approve setup</button>
                              <button className="btn btn-ghost btn-sm" disabled={busyId === b.id}
                                onClick={() => setApproval(b, 'rejected')}>Reject</button>
                              <span style={{ width:1, background:'var(--border)', margin:'0 4px' }} />
                              <button className="btn btn-secondary btn-sm" disabled={busyId === b.id}
                                onClick={() => grantTrial(b, 7)}>🎁 7-day free trial</button>
                            </>
                          )}
                          {b.slug && <a className="btn btn-ghost btn-sm" href={`#/${b.slug}`}>View store →</a>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── AGENTS: register, approve, and pay commission ───── */}
            {tab === 'agents' && isAdmin && (
              <div>
                <p style={{ color:'var(--text-muted)', fontSize:'.85rem', marginBottom:14 }}>
                  ${COMMISSION_PER_STORE} per store, paid for {COMMISSION_INSTALMENTS} months while the
                  store keeps paying its bill. An agent earns nothing until you approve them
                  here, and a free trial never counts as a payment.
                </p>

                <div style={{ background:'var(--surface)', borderRadius:12, border:'1px solid var(--border)', overflow:'hidden', marginBottom:20 }}>
                  <div style={{ overflowX:'auto' }}>
                    <table style={tbl}>
                      <thead><tr>
                        <th style={th}>Agent</th><th style={th}>Status</th><th style={th}>Stores</th>
                        <th style={th}>Owed</th><th style={th}>Paid</th><th style={th}>Actions</th>
                      </tr></thead>
                      <tbody>
                        {agents.map(a => (
                          <tr key={a.id}>
                            <td style={td}>{a.icon} {a.name}</td>
                            <td style={td}>
                              <span style={{ fontWeight:700, fontSize:'.74rem',
                                color: a.status === 'approved' ? '#059669' : a.status === 'rejected' ? '#dc2626' : '#d97706' }}>
                                {a.status === 'approved' ? '✓ Approved' : a.status === 'rejected' ? '✕ Rejected' : '🕐 Pending'}
                              </span>
                            </td>
                            <td style={td}>{a.stores}</td>
                            <td style={{ ...td, fontWeight:800 }}>{fmtAmt(a.amountDue)}</td>
                            <td style={td}>{fmtAmt(a.amountPaid)}</td>
                            <td style={td}>
                              {a.status !== 'approved' && (
                                <button className="btn btn-primary btn-sm" disabled={busyId === a.id}
                                  onClick={() => decideAgent(a.id, 'approve')}>Approve</button>
                              )}
                              {a.status !== 'rejected' && (
                                <button className="btn btn-ghost btn-sm" disabled={busyId === a.id}
                                  onClick={() => decideAgent(a.id, 'reject')}>Reject</button>
                              )}
                            </td>
                          </tr>
                        ))}
                        {agents.length === 0 && (
                          <tr><td colSpan={6} style={{ ...td, textAlign:'center', color:'var(--text-muted)' }}>No field agents yet</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <h3 style={{ fontSize:'.9rem', fontWeight:800, marginBottom:8 }}>Commission ledger</h3>
                <div style={{ background:'var(--surface)', borderRadius:12, border:'1px solid var(--border)', overflow:'hidden' }}>
                  <div style={{ overflowX:'auto' }}>
                    <table style={tbl}>
                      <thead><tr>
                        <th style={th}>Agent</th><th style={th}>Store</th><th style={th}>Month</th>
                        <th style={th}>Amount</th><th style={th}>Status</th><th style={th}></th>
                      </tr></thead>
                      <tbody>
                        {commissions.map(c => (
                          <tr key={`${c.supplierId}-${c.instalment}`}>
                            <td style={td}>{c.agentName}</td>
                            <td style={td}>{c.storeName}</td>
                            <td style={td}>{c.instalment} of {COMMISSION_INSTALMENTS}</td>
                            <td style={{ ...td, fontWeight:700 }}>{fmtAmt(c.amount)}</td>
                            <td style={td}>
                              <span style={{ fontWeight:700, fontSize:'.74rem', color: c.status === 'paid' ? '#059669' : '#d97706' }}>
                                {c.status === 'paid' ? '✓ Paid' : 'Due'}
                              </span>
                            </td>
                            <td style={td}>
                              <button className="btn btn-ghost btn-sm"
                                disabled={busyId === c.supplierId * 10 + c.instalment}
                                onClick={() => payCommission(c, c.status === 'paid' ? 'unpay' : 'pay')}>
                                {c.status === 'paid' ? 'Undo' : 'Mark paid'}
                              </button>
                            </td>
                          </tr>
                        ))}
                        {commissions.length === 0 && (
                          <tr><td colSpan={6} style={{ ...td, textAlign:'center', color:'var(--text-muted)' }}>
                            Nothing earned yet — commission appears once an approved store pays.
                          </td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {tab === 'payouts' && isAdmin && (
              <div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 700, fontSize: '1rem' }}>💸 Payout Requests</div>
                  <div style={{ fontSize: '.8rem', color: 'var(--text-muted)' }}>
                    Shops request a withdrawal from the money they&apos;ve collected. Approving marks it paid — send the
                    money to the listed number, then approve here. Rejecting returns the amount to the shop&apos;s balance.
                  </div>
                </div>

                {/* Money at a glance */}
                <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:14 }}>
                  <div style={{ flex:'1 1 160px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'12px 14px' }}>
                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)', fontWeight:700, textTransform:'uppercase' }}>Awaiting approval</div>
                    <div style={{ fontSize:'1.5rem', fontWeight:800, color:'#d97706' }}>${payoutTotals.pending.toFixed(2)}</div>
                    <div style={{ fontSize:'.75rem', color:'var(--text-muted)' }}>{payoutTotals.pendingCount} request{payoutTotals.pendingCount !== 1 ? 's' : ''}</div>
                  </div>
                  <div style={{ flex:'1 1 160px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'12px 14px' }}>
                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)', fontWeight:700, textTransform:'uppercase' }}>Paid out</div>
                    <div style={{ fontSize:'1.5rem', fontWeight:800, color:'#059669' }}>${payoutTotals.approved.toFixed(2)}</div>
                  </div>
                </div>

                {/* Status filter */}
                <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
                  {(['pending','approved','rejected','all'] as const).map(f => (
                    <button key={f} className={`chip ${payoutFilter === f ? 'active' : ''}`} onClick={() => setPayoutFilter(f)}>
                      {f === 'pending' ? '⏳ Pending' : f === 'approved' ? '✓ Approved' : f === 'rejected' ? '✕ Rejected' : 'All'}
                    </button>
                  ))}
                </div>

                {payouts.length === 0 ? (
                  <div className="empty-state" style={{ padding:'40px 16px' }}>
                    <div className="empty-icon">💸</div>
                    <div className="empty-title">No {payoutFilter === 'all' ? '' : payoutFilter} payout requests</div>
                    <div className="empty-sub">Requests from shops show up here for approval.</div>
                  </div>
                ) : (
                  <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    {payouts.map(p => (
                      <div key={p.id} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:'12px 14px' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                          <span style={{ width:34, height:34, flexShrink:0, borderRadius:8, overflow:'hidden', display:'grid', placeItems:'center', fontSize:20, background:'var(--bg)', border:'1px solid var(--border)' }}>
                            <StoreAvatar value={p.storeIcon} />
                          </span>
                          <div style={{ minWidth:0, flex:1 }}>
                            <div style={{ fontWeight:700 }}>{p.storeName}</div>
                            <div style={{ fontSize:'.75rem', color:'var(--text-muted)' }}>
                              📞 {p.phone || 'no number saved'} · {new Date(p.createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}
                            </div>
                          </div>
                          <div style={{ fontSize:'1.15rem', fontWeight:800 }}>${p.amount.toFixed(2)}</div>
                          <span style={{
                            fontSize:'.68rem', fontWeight:800, padding:'3px 10px', borderRadius:99, whiteSpace:'nowrap',
                            background: p.status === 'approved' ? '#d1fae5' : p.status === 'rejected' ? '#fee2e2' : '#fef3c7',
                            color:      p.status === 'approved' ? '#059669' : p.status === 'rejected' ? '#dc2626' : '#d97706',
                          }}>
                            {p.status === 'approved' ? '✓ Paid' : p.status === 'rejected' ? '✕ Rejected' : '⏳ Pending'}
                          </span>
                        </div>

                        {p.note && (
                          <div style={{ marginTop:8, fontSize:'.78rem', color:'var(--text-muted)', fontStyle:'italic' }}>
                            Note: “{p.note}”
                          </div>
                        )}

                        {p.status === 'pending' && (
                          <div style={{ marginTop:10, display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                            <input
                              className="form-input"
                              style={{ flex:'1 1 200px', padding:'6px 10px', fontSize:'.82rem' }}
                              placeholder="Note for the shop (optional)"
                              value={payoutNote[p.id] ?? ''}
                              onChange={e => setPayoutNote(n => ({ ...n, [p.id]: e.target.value }))}
                            />
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={decidingId === p.id}
                              onClick={() => decidePayout(p.id, 'approved')}
                            >
                              {decidingId === p.id ? '…' : '✓ Approve & mark paid'}
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ color:'var(--danger)' }}
                              disabled={decidingId === p.id}
                              onClick={() => decidePayout(p.id, 'rejected')}
                            >
                              ✕ Reject
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── STOREFRONT (admin only) ─────────────────────────── */}
            {tab === 'storefront' && isAdmin && (
              <div style={{ maxWidth: 720 }}>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 700, fontSize: '1rem' }}>🎨 Hot Deals Hero Banner</div>
                  <div style={{ fontSize: '.8rem', color: 'var(--text-muted)' }}>
                    Change the discount banner image and text shown at the top of the Explore page. Changes go live for all shoppers on save.
                  </div>
                </div>

                {!hero ? (
                  <div style={{ display:'flex', justifyContent:'center', padding:60 }}><div className="spinner" style={{ width:32, height:32 }} /></div>
                ) : (
                  <>
                    {/* Live preview */}
                    <div className={`banner${hero.imageUrl ? ' banner-has-photo' : ''}`} style={{ margin: '0 0 18px', opacity: hero.enabled ? 1 : 0.5 }}>
                      {hero.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className="banner-bg" src={hero.imageUrl} alt="" aria-hidden="true" />
                      )}
                      <div className="banner-content">
                        {hero.tag && <span className="banner-tag">{hero.tag}</span>}
                        {hero.title && <h2>{hero.title}</h2>}
                        {hero.subtitle && <p>{hero.subtitle}</p>}
                        {hero.ctaLabel && <button className="btn btn-secondary btn-sm" type="button">{hero.ctaLabel}</button>}
                      </div>
                      {!hero.imageUrl && <span className="banner-emoji">🛍️</span>}
                    </div>

                    <div style={{ background:'var(--surface)', borderRadius:12, border:'1px solid var(--border)', padding:16 }}>
                      {/* Image */}
                      <div className="form-group">
                        <label className="form-label">Banner Image</label>
                        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                          {hero.imageUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={hero.imageUrl} alt="Hero" style={{ width:72, height:72, objectFit:'cover', borderRadius:10, border:'1px solid var(--border)' }} />
                          )}
                          <label className="btn btn-secondary btn-sm" style={{ cursor:'pointer' }}>
                            {uploadingHero ? 'Uploading…' : (hero.imageUrl ? '🔄 Replace Image' : '📷 Upload Image')}
                            <input type="file" accept="image/*" style={{ display:'none' }} disabled={uploadingHero}
                              onChange={e => { const f = e.target.files?.[0]; if (f) uploadHeroImage(f); e.target.value=''; }} />
                          </label>
                          {hero.imageUrl && (
                            <button className="btn btn-ghost btn-sm" style={{ color:'var(--danger)' }} type="button"
                              onClick={() => setHero(h => h ? { ...h, imageUrl: '' } : h)}>Remove</button>
                          )}
                        </div>
                        <p style={{ fontSize:'.72rem', color:'var(--text-muted)', marginTop:6 }}>
                          The image fills the whole hero with your text overlaid on top. Best with a wide/landscape photo (e.g. 1200×400). Leave empty to show the default 🛍️ emoji. Under 20&nbsp;MB.
                        </p>
                      </div>

                      {/* Text fields */}
                      <div className="form-group">
                        <label className="form-label">Tag (small pill)</label>
                        <input className="form-input" value={hero.tag} maxLength={60}
                          onChange={e => setHero(h => h ? { ...h, tag: e.target.value } : h)} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Title</label>
                        <input className="form-input" value={hero.title} maxLength={120}
                          onChange={e => setHero(h => h ? { ...h, title: e.target.value } : h)} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Subtitle</label>
                        <input className="form-input" value={hero.subtitle} maxLength={200}
                          onChange={e => setHero(h => h ? { ...h, subtitle: e.target.value } : h)} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Button label</label>
                        <input className="form-input" value={hero.ctaLabel} maxLength={40}
                          onChange={e => setHero(h => h ? { ...h, ctaLabel: e.target.value } : h)} />
                      </div>
                      <div className="form-group">
                        <label className="form-label" style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
                          <input type="checkbox" checked={hero.enabled} style={{ width:16, height:16 }}
                            onChange={e => setHero(h => h ? { ...h, enabled: e.target.checked } : h)} />
                          <span>Show banner on the Explore page</span>
                        </label>
                      </div>

                      <button className="btn btn-primary btn-full btn-lg" onClick={saveHero} disabled={savingHero || uploadingHero}>
                        {savingHero ? 'Saving…' : 'Save Banner'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── TEAM (admin only) ───────────────────────────────── */}
            {tab === 'team' && isAdmin && (
              <div>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
                  <div>
                    <div style={{ fontWeight:700, fontSize:'1rem' }}>Admin Team</div>
                    <div style={{ fontSize:'.8rem', color:'var(--text-muted)' }}>Manage who can access the admin panel and their role</div>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={() => setShowAddAdmin(true)}>+ Add Member</button>
                </div>

                {/* Role explanation */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:16 }}>
                  <div style={{ background:'#4F46E511', border:'1px solid #4F46E533', borderRadius:10, padding:'12px 16px' }}>
                    <div style={{ fontWeight:700, color:'#4F46E5', marginBottom:4 }}>👑 Admin — Full Access</div>
                    <div style={{ fontSize:'.8rem', color:'var(--text-muted)', lineHeight:1.5 }}>Can view everything, edit businesses & products, delete, verify, manage orders and change team roles.</div>
                  </div>
                  <div style={{ background:'#F59E0B11', border:'1px solid #F59E0B33', borderRadius:10, padding:'12px 16px' }}>
                    <div style={{ fontWeight:700, color:'#B45309', marginBottom:4 }}>👁️ Viewer — Read Only</div>
                    <div style={{ fontSize:'.8rem', color:'var(--text-muted)', lineHeight:1.5 }}>Can see all data — businesses, products, orders, users — but cannot edit, delete or perform any actions.</div>
                  </div>
                </div>

                <div style={{ background:'var(--surface)', borderRadius:12, border:'1px solid var(--border)', overflow:'hidden' }}>
                  <div style={{ overflowX:'auto' }}>
                    <table style={tbl}>
                      <thead><tr>
                        <th style={th}>Name</th><th style={th}>User ID</th>
                        <th style={th}>Role</th><th style={th}>Email</th>
                        <th style={th}>Added</th><th style={th}>Actions</th>
                      </tr></thead>
                      <tbody>
                        {admins.map(a => (
                          <tr key={a.id}>
                            <td style={td}>
                              <div style={{ fontWeight:600 }}>{a.name || 'Unnamed'}</div>
                              {a.userId === user.id && <div style={{ fontSize:'.72rem', color:'var(--primary)' }}>← You</div>}
                            </td>
                            <td style={td}><code style={{ fontSize:'.72rem' }}>{a.userId.slice(0,16)}…</code></td>
                            <td style={td}><RoleBadge role={a.role} /></td>
                            <td style={td}>{a.email || '—'}</td>
                            <td style={td}>{fmtDate(a.createdAt)}</td>
                            <td style={td}>
                              <div style={{ display:'flex', gap:6 }}>
                                <button
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => changeRole(a, a.role === 'admin' ? 'semi_admin' : 'admin')}
                                  disabled={a.userId === user.id}
                                  title={a.userId === user.id ? "You can't change your own role" : ''}
                                >
                                  {a.role === 'admin' ? '→ Viewer' : '→ Admin'}
                                </button>
                                <button
                                  className="btn btn-ghost btn-sm"
                                  style={{ color: a.userId === user.id ? 'var(--text-muted)' : 'var(--danger)' }}
                                  onClick={() => removeAdmin(a)}
                                  disabled={a.userId === user.id}
                                  title={a.userId === user.id ? "You can't remove yourself" : ''}
                                >
                                  🗑️
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {admins.length === 0 && <tr><td colSpan={6} style={{ ...td, textAlign:'center', color:'var(--text-muted)' }}>No team members yet</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Edit Business Modal ────────────────────────────────────── */}
      {editBiz && isAdmin && (
        <div className="modal-overlay" onClick={() => setEditBiz(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth:480 }}>
            <div className="modal-header">
              <span>✏️ Edit Business — {editBiz.name}</span>
              <button className="modal-close" onClick={() => setEditBiz(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Name</label>
                <input className="form-input" value={editBiz.name} onChange={e => setEditBiz(b => b ? { ...b, name: e.target.value } : b)} />
              </div>
              <div className="form-group">
                <label className="form-label">Bio</label>
                <textarea className="form-input" rows={2} value={editBiz.bio ?? ''} onChange={e => setEditBiz(b => b ? { ...b, bio: e.target.value } : b)} style={{ resize:'vertical', fontFamily:'inherit' }} />
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <div className="form-group">
                  <label className="form-label">Location</label>
                  <input className="form-input" value={editBiz.location ?? ''} onChange={e => setEditBiz(b => b ? { ...b, location: e.target.value } : b)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Account Type</label>
                  <select className="form-input" value={(editBiz as Supplier & { accountType?: string }).accountType ?? 'business'} onChange={e => setEditBiz(b => b ? { ...b, accountType: e.target.value } as typeof b : b)}>
                    <option value="business">🏪 Business</option>
                    <option value="supplier">🏭 Supplier</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
                  <input type="checkbox" checked={editBiz.verified ?? false} onChange={e => setEditBiz(b => b ? { ...b, verified: e.target.checked } : b)} style={{ width:16, height:16 }} />
                  <span>✅ Mark as Verified</span>
                </label>
              </div>
              <button className="btn btn-primary btn-full" onClick={saveBiz}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Product Modal ─────────────────────────────────────── */}
      {editProd && isAdmin && (
        <div className="modal-overlay" onClick={() => setEditProd(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth:480 }}>
            <div className="modal-header">
              <span>✏️ Edit Product</span>
              <button className="modal-close" onClick={() => setEditProd(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Product Name</label>
                <input className="form-input" value={editProd.name} onChange={e => setEditProd(p => p ? { ...p, name: e.target.value } : p)} />
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <div className="form-group">
                  <label className="form-label">Price ($)</label>
                  <input className="form-input" type="number" min="0" step="0.01" value={editProd.price} onChange={e => setEditProd(p => p ? { ...p, price: parseFloat(e.target.value) } : p)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Original Price ($)</label>
                  <input className="form-input" type="number" min="0" step="0.01" value={editProd.originalPrice} onChange={e => setEditProd(p => p ? { ...p, originalPrice: parseFloat(e.target.value) } : p)} />
                </div>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <div className="form-group">
                  <label className="form-label">Stock</label>
                  <input className="form-input" type="number" min="0" value={editProd.stock} onChange={e => setEditProd(p => p ? { ...p, stock: parseInt(e.target.value) } : p)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Category</label>
                  <select className="form-input" value={editProd.category} onChange={e => setEditProd(p => p ? { ...p, category: e.target.value } : p)}>
                    {['electronics','clothes','home','food','health','sports','medicine','cosmetics','construction','furniture','cars','books','other'].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <textarea className="form-input" rows={2} value={editProd.description} onChange={e => setEditProd(p => p ? { ...p, description: e.target.value } : p)} style={{ resize:'vertical', fontFamily:'inherit' }} />
              </div>
              <button className="btn btn-primary btn-full" onClick={saveProd}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Product Confirm Modal ───────────────────────────── */}
      {confirmDeleteProd && isAdmin && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteProd(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth:400 }}>
            <div className="modal-header">
              <span>🗑️ Delete product</span>
              <button className="modal-close" onClick={() => setConfirmDeleteProd(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom:18, lineHeight:1.5 }}>
                Delete <strong>{confirmDeleteProd.name}</strong>? This cannot be undone.
              </p>
              <div style={{ display:'flex', gap:10 }}>
                <button className="btn btn-outline btn-lg" style={{ flex:1 }} onClick={() => setConfirmDeleteProd(null)}>Cancel</button>
                <button className="btn btn-danger btn-lg" style={{ flex:1 }} onClick={doDeleteProd}>Delete</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Admin Modal ────────────────────────────────────────── */}
      {showAddAdmin && isAdmin && (
        <div className="modal-overlay" onClick={() => setShowAddAdmin(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth:440 }}>
            <div className="modal-header">
              <span>➕ Add Team Member</span>
              <button className="modal-close" onClick={() => setShowAddAdmin(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ background:'#EFF6FF', border:'1px solid #BFDBFE', borderRadius:8, padding:'10px 12px', fontSize:'.82rem', color:'#1E40AF', marginBottom:14 }}>
                💡 The user's UID is shown on the Access Denied page when they visit <code>/admin</code>.
              </div>
              <div className="form-group">
                <label className="form-label">User UID *</label>
                <input className="form-input" placeholder="Supabase UID" value={newAdminUid} onChange={e => setNewAdminUid(e.target.value)} />
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <div className="form-group">
                  <label className="form-label">Display Name</label>
                  <input className="form-input" placeholder="e.g. Ahmed" value={newAdminName} onChange={e => setNewAdminName(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Email (optional)</label>
                  <input className="form-input" type="email" placeholder="email@example.com" value={newAdminEmail} onChange={e => setNewAdminEmail(e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Role *</label>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <button
                    type="button"
                    onClick={() => setNewAdminRole('admin')}
                    style={{ padding:'10px', borderRadius:10, border: newAdminRole==='admin' ? '2px solid #4F46E5' : '2px solid var(--border)', background: newAdminRole==='admin' ? '#4F46E511' : 'var(--surface)', cursor:'pointer', textAlign:'left' }}
                  >
                    <div style={{ fontWeight:700, color:'#4F46E5' }}>👑 Admin</div>
                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)', marginTop:2 }}>Full access — can edit & delete</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewAdminRole('semi_admin')}
                    style={{ padding:'10px', borderRadius:10, border: newAdminRole==='semi_admin' ? '2px solid #F59E0B' : '2px solid var(--border)', background: newAdminRole==='semi_admin' ? '#F59E0B11' : 'var(--surface)', cursor:'pointer', textAlign:'left' }}
                  >
                    <div style={{ fontWeight:700, color:'#B45309' }}>👁️ Viewer</div>
                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)', marginTop:2 }}>Read-only — view only, no actions</div>
                  </button>
                </div>
              </div>
              <button className="btn btn-primary btn-full btn-lg" onClick={addAdmin} disabled={savingAdmin || !newAdminUid.trim()}>
                {savingAdmin ? 'Adding…' : `Add ${newAdminRole === 'admin' ? 'Admin' : 'Viewer'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
