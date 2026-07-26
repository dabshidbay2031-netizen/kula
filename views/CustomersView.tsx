'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import Header from '@/components/Header';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { useStoreActor } from '@/lib/useStoreActor';
import { authHeaders } from '@/lib/clientAuth';
import { useMyProductIds } from '@/lib/useMyProductIds';
import Pagination from '@/components/Pagination';
import { usePagination } from '@/lib/usePagination';
import type { Customer } from '@/lib/types';

/* ─── constants ──────────────────────────────────── */
/* Offline cache key — MUST be per-store. A single shared key let one store's
   customer book stay in the browser and surface for the next account signed in
   on the same device. */
const localKeyFor = (supplierId: number | null) =>
  supplierId != null ? `mogarenta_customers_${supplierId}` : null;
const AVATAR_COLORS = ['#4F46E5','#7C3AED','#DB2777','#EA580C','#16A34A','#0891B2','#D97706','#6366F1'];

function initials(name: string) {
  return name.trim().split(/\s+/).map(w => w[0]?.toUpperCase() ?? '').slice(0, 2).join('');
}
function avatarBg(name: string) {
  return AVATAR_COLORS[name.charCodeAt(0) % AVATAR_COLORS.length];
}
function makeId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const emptyForm = { name: '', phone: '', email: '', address: '', gender: '', notes: '' };
type FormState = typeof emptyForm;

/* ─── Invoice types ──────────────────────────────── */
interface InvItem {
  productId: number;
  name: string;
  price: number;
  qty: number;
}

interface InvoicePayment { id: number; amount: number; method: string; note: string | null; paidAt: string; }
interface Invoice {
  id: string; supplierId: number; customerId: string; customerName: string;
  items: { id: number; name: string; price: number; qty: number }[];
  subtotal: number; discount: number; total: number; paidTotal: number; balance: number;
  status: string; notes: string | null; orderId: string | null; createdAt: string;
  payments: InvoicePayment[];
}

/* ─── Component ──────────────────────────────────── */
export default function CustomersPage() {
  const { state, toast, reloadProducts } = useApp();
  const { user } = useAuth();
  // Works for the owner AND a staff cashier operating the store.
  const actor = useStoreActor();
  const supplierId = actor.storeId;

  /* ── Credit report download ────────────────────────────────
     The file is generated server-side (scoped to this store) and saved
     straight to the device. An empty period is reported rather than silently
     handing over a blank file the shop might mistake for a good backup. */
  const [exportPeriod, setExportPeriod] = useState('month');
  const [exporting,    setExporting]    = useState(false);

  const downloadCredits = useCallback(async (shape: 'summary' | 'detail') => {
    if (supplierId == null) return;
    setExporting(true);
    try {
      const res = await fetch(
        `/api/invoices/export?supplierId=${supplierId}&period=${exportPeriod}&shape=${shape}`,
        { headers: await authHeaders(), cache: 'no-store' });
      if (!res.ok) { toast('Could not build the credit report', 'error'); return; }

      const blob = await res.blob();
      // Only the header line + BOM means nothing matched the period.
      if (blob.size < 120) {
        toast('No credit records in that period', 'error');
        return;
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
        ?? `credits-${exportPeriod}.csv`;
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast(`Saved ${name}`, 'success');
    } catch {
      toast('Could not build the credit report', 'error');
    } finally {
      setExporting(false);
    }
  }, [supplierId, exportPeriod, toast]);
  const products = state.products;

  // Only THIS store's products are invoiceable — owned catalog rows plus
  // claimed ones, at the store's own claim price. Never other shops' items.
  const { ids: myIds, scoped: myScoped, claimed: myClaims } = useMyProductIds();
  const myProducts = useMemo(() => {
    const list = myScoped ? products.filter(p => myIds.has(p.id)) : products;
    return list.map(p => {
      const claim = myClaims.get(p.id);
      return claim ? { ...p, price: claim.customPrice } : p;
    });
  }, [products, myIds, myScoped, myClaims]);

  /* customers state */
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search,    setSearch]    = useState('');
  const [loading,   setLoading]   = useState(true);

  /* form / CRUD state */
  const [showForm,   setShowForm]   = useState(false);
  const [editingId,  setEditingId]  = useState<string | null>(null);
  const [form,       setForm]       = useState<FormState>(emptyForm);
  const [saving,     setSaving]     = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /* invoice creation state */
  const [invoiceCust, setInvoiceCust] = useState<Customer | null>(null);
  const [invItems,    setInvItems]    = useState<InvItem[]>([]);
  const [invDiscount, setInvDiscount] = useState('0');
  const [invPayment,  setInvPayment]  = useState('cash');
  const [invNotes,    setInvNotes]    = useState('');
  const [savingInv,   setSavingInv]   = useState(false);

  /* ledger (per-customer invoices + payments) state */
  const [invoices,   setInvoices]   = useState<Invoice[]>([]);
  const [ledgerCust, setLedgerCust] = useState<Customer | null>(null);
  const [payAmount,  setPayAmount]  = useState('');
  const [payMethod,  setPayMethod]  = useState('cash');
  const [savingPay,  setSavingPay]  = useState(false);

  /* ── Load this store's customers: API first, localStorage fallback ─────── */
  useEffect(() => {
    (async () => {
      // No store → no customer book. Never fall back to the unscoped
      // /api/customers, which is the whole platform's book (admin only).
      if (supplierId == null) { setCustomers([]); setLoading(false); return; }
      const key = localKeyFor(supplierId)!;
      try {
        const res  = await fetch(`/api/customers?supplierId=${supplierId}`, { headers: await authHeaders() });
        const data = await res.json();
        if (Array.isArray(data)) {
          setCustomers(data);
          localStorage.setItem(key, JSON.stringify(data));
          setLoading(false);
          return;
        }
      } catch {}
      /* fallback to this store's own cache */
      try {
        const raw = localStorage.getItem(key);
        if (raw) setCustomers(JSON.parse(raw));
      } catch {}
      setLoading(false);
    })();
  }, [supplierId]);

  /* ── Load this store's invoice ledger ───────────────────────── */
  const loadInvoices = useCallback(async () => {
    if (supplierId == null) return;
    try {
      const res = await fetch(`/api/invoices?supplierId=${supplierId}`, { headers: await authHeaders() });
      const d   = await res.json();
      if (Array.isArray(d)) setInvoices(d);
    } catch { /* ledger simply stays empty */ }
  }, [supplierId]);
  useEffect(() => { loadInvoices(); }, [loadInvoices]);

  /* Per-customer money summary: invoiced / paid / still owed */
  const ledgerByCustomer = useMemo(() => {
    const m = new Map<string, { invoiced: number; paid: number; balance: number; count: number }>();
    for (const inv of invoices) {
      const g = m.get(inv.customerId) ?? { invoiced: 0, paid: 0, balance: 0, count: 0 };
      g.invoiced += inv.total;
      g.paid     += inv.paidTotal;
      g.balance  += inv.balance;
      g.count    += 1;
      m.set(inv.customerId, g);
    }
    return m;
  }, [invoices]);

  /* ── Persist helper ──────────────────────────────── */
  const persist = useCallback((updated: Customer[]) => {
    setCustomers(updated);
    const key = localKeyFor(supplierId);
    if (key) localStorage.setItem(key, JSON.stringify(updated));
  }, [supplierId]);

  /* ── CRUD ────────────────────────────────────────── */
  function openAdd() { setEditingId(null); setForm(emptyForm); setShowForm(true); }
  function openEdit(c: Customer) {
    setEditingId(c.id);
    setForm({ name: c.name, phone: c.phone, email: c.email, address: c.address, gender: c.gender ?? '', notes: c.notes });
    setShowForm(true);
  }

  const sf = (k: keyof FormState, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function handleSave() {
    if (!form.name.trim()) { toast('Name is required', 'error'); return; }
    setSaving(true);

    if (editingId) {
      /* try API first */
      try {
        const res = await fetch(`/api/customers/${editingId}`, {
          method: 'PATCH',
          headers: await authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(form),
        });
        if (res.ok) {
          const updated = await res.json() as Customer;
          persist(customers.map(c => c.id === editingId ? updated : c));
          toast('Customer updated ✓', 'success');
          setSaving(false); setShowForm(false); return;
        }
      } catch {}
      /* local fallback */
      persist(customers.map(c => c.id === editingId ? { ...c, ...form, gender: form.gender as Customer['gender'] } : c));
      toast('Customer updated ✓', 'success');
    } else {
      /* try API first */
      try {
        const res = await fetch('/api/customers', {
          method: 'POST',
          headers: await authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ ...form, supplierId }),
        });
        if (res.ok) {
          const newC = await res.json() as Customer;
          persist([newC, ...customers]);
          toast('Customer added ✓', 'success');
          setSaving(false); setShowForm(false); return;
        }
      } catch {}
      /* local fallback — still usable without DB */
      const newC: Customer = {
        id: makeId(), ...form, gender: form.gender as Customer['gender'], createdAt: new Date().toISOString(),
      };
      persist([newC, ...customers]);
      toast('Customer added ✓', 'success');
    }
    setSaving(false);
    setShowForm(false);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this customer?')) return;
    setDeletingId(id);
    try {
      await fetch(`/api/customers/${id}`, { method: 'DELETE', headers: await authHeaders() });
    } catch {}
    persist(customers.filter(c => c.id !== id));
    setDeletingId(null);
    toast('Customer deleted', 'default');
  }

  /* ── Invoice helpers ─────────────────────────────── */
  function openInvoice(c: Customer) {
    setInvoiceCust(c);
    setInvItems([]); setInvDiscount('0'); setInvPayment('cash'); setInvNotes('');
  }

  function addProduct(productId: number) {
    const p = myProducts.find(x => x.id === productId);
    if (!p) return;
    setInvItems(prev => {
      const exists = prev.find(i => i.productId === productId);
      if (exists) return prev.map(i => i.productId === productId ? { ...i, qty: i.qty + 1 } : i);
      return [...prev, { productId, name: p.name, price: p.price, qty: 1 }];
    });
  }

  function changeQty(productId: number, delta: number) {
    setInvItems(prev =>
      prev.map(i => i.productId === productId ? { ...i, qty: Math.max(1, i.qty + delta) } : i)
    );
  }

  function removeItem(productId: number) {
    setInvItems(prev => prev.filter(i => i.productId !== productId));
  }

  const invSubtotal    = invItems.reduce((s, i) => s + i.price * i.qty, 0);
  const invDiscountAmt = Math.min(Math.max(parseFloat(invDiscount) || 0, 0), invSubtotal);
  const invTotal       = invSubtotal - invDiscountAmt;

  /** Record the sale as an order (stock moves, revenue counts). */
  async function placeInvoiceOrder(paymentMethod: string, notes: string): Promise<{ id: string } | null> {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName:  invoiceCust!.name,
        customerPhone: invoiceCust!.phone,
        userId:        user?.id ?? null,
        items:         invItems.map(i => ({ id: i.productId, qty: i.qty })),
        paymentMethod,
        status:        'completed',
        supplierId,
        notes,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      toast(err?.error ?? 'Failed to save order', 'error');
      return null;
    }
    return res.json();
  }

  /** Credit sale: order + open receivable on the customer's ledger. */
  async function handleSaveAsInvoice() {
    if (!invoiceCust || invItems.length === 0) { toast('Add at least one product', 'error'); return; }
    if (supplierId == null) { toast('Invoicing needs a business account', 'error'); return; }
    setSavingInv(true);
    try {
      const order = await placeInvoiceOrder('invoice', `Invoiced to ${invoiceCust.name} — pay later${invNotes ? ` | ${invNotes}` : ''}`);
      if (!order) { setSavingInv(false); return; }
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          supplierId,
          customerId:   invoiceCust.id,
          customerName: invoiceCust.name,
          items:        invItems.map(i => ({ id: i.productId, name: i.name, price: i.price, qty: i.qty })),
          discount:     invDiscountAmt,
          notes:        invNotes.trim() || null,
          orderId:      order.id,
        }),
      });
      if (res.ok) {
        toast(`Invoice saved — ${invoiceCust.name} owes $${invTotal.toFixed(2)}`, 'success');
        setInvoiceCust(null);
        loadInvoices();
        reloadProducts().catch(() => {});
      } else {
        const err = await res.json().catch(() => null);
        toast(err?.error ?? 'Order placed but invoice not recorded', 'warning');
      }
    } catch {
      toast('Failed to save invoice', 'error');
    }
    setSavingInv(false);
  }

  /** Immediate sale paid on the spot (cash/waafi/card). */
  async function handleSaveAsOrder() {
    if (!invoiceCust || invItems.length === 0) { toast('Add at least one product', 'error'); return; }
    setSavingInv(true);
    try {
      const order = await placeInvoiceOrder(invPayment, invNotes.trim() || `Sold to ${invoiceCust.name}`);
      if (order) {
        toast('Order saved ✓', 'success');
        setInvoiceCust(null);
        reloadProducts().catch(() => {});
      }
    } catch {
      toast('Failed to save order', 'error');
    }
    setSavingInv(false);
  }

  /* ── Record a payment against the customer's TOTAL balance ─────────
     One lump sum settles the account, applied to the oldest unpaid invoices
     first — the store tracks a single running balance, not each order. */
  async function handleRecordTotalPayment() {
    const amount = parseFloat(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) { toast('Enter a valid amount', 'error'); return; }
    if (amount > ledgerTotals.balance + 0.005) { toast(`Max is the $${ledgerTotals.balance.toFixed(2)} balance`, 'error'); return; }
    setSavingPay(true);
    const unpaid = ledgerInvoices
      .filter(v => v.balance > 0.005)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    let remaining = amount;
    try {
      for (const inv of unpaid) {
        if (remaining <= 0.005) break;
        const pay = Math.min(remaining, inv.balance);
        const res = await fetch(`/api/invoices/${inv.id}`, {
          method: 'PATCH',
          headers: await authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ payment: { amount: pay, method: payMethod } }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          toast(err?.error ?? 'Failed to record payment', 'error');
          break;
        }
        remaining -= pay;
      }
      await loadInvoices();
      setPayAmount('');
      toast(remaining <= 0.005 ? 'Payment recorded ✓' : 'Partial payment recorded', 'success');
    } catch {
      toast('Network error — payment not recorded', 'error');
    }
    setSavingPay(false);
  }

  function handlePrint() {
    if (!invoiceCust || invItems.length === 0) { toast('Add at least one product', 'error'); return; }

    const storeName = actor.store?.name ?? 'Hamar Mall Store';

    const invNum = `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
    const date   = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const rows = invItems.map(i => `
      <tr>
        <td>${i.name}</td>
        <td class="center">${i.qty}</td>
        <td class="right">$${i.price.toFixed(2)}</td>
        <td class="right"><strong>$${(i.price * i.qty).toFixed(2)}</strong></td>
      </tr>`).join('');

    const html = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>Invoice – ${invoiceCust.name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;padding:48px;max-width:700px;margin:0 auto}
  h1{font-size:1.6rem;font-weight:800;color:#4F46E5}
  .header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:24px;border-bottom:2.5px solid #4F46E5;margin-bottom:28px}
  .brand-sub{font-size:.82rem;color:#64748b;margin-top:5px}
  .inv-num{font-size:1rem;font-weight:700;color:#0f172a}
  .inv-date{font-size:.82rem;color:#64748b;margin-top:5px}
  .bill-section{margin-bottom:28px}
  .section-label{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;margin-bottom:8px}
  .bill-name{font-size:1.1rem;font-weight:700}
  .bill-detail{font-size:.85rem;color:#475569;margin-top:4px;line-height:1.6}
  table{width:100%;border-collapse:collapse;margin-bottom:24px}
  th{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;padding:10px 12px;border-bottom:1.5px solid #e2e8f0;text-align:left}
  td{padding:11px 12px;border-bottom:1px solid #f1f5f9;font-size:.88rem;vertical-align:middle}
  .center{text-align:center}.right{text-align:right}
  .totals{margin-left:auto;width:260px}
  .t-row{display:flex;justify-content:space-between;padding:7px 0;font-size:.88rem;color:#64748b;border-bottom:1px solid #f1f5f9}
  .t-row.disc{color:#dc2626}
  .t-row.final{border-top:2px solid #0f172a;border-bottom:none;margin-top:8px;padding-top:14px;font-size:1.15rem;font-weight:800;color:#0f172a}
  .footer{margin-top:40px;padding-top:20px;border-top:1px solid #e2e8f0;font-size:.78rem;color:#94a3b8;text-align:center;line-height:1.8}
  .pay-tag{display:inline-block;background:#eef2ff;color:#4F46E5;padding:3px 12px;border-radius:99px;font-size:.75rem;font-weight:700;margin-bottom:8px}
  @media print{body{padding:20px}}
</style></head><body>
<div class="header">
  <div><h1>🏪 ${storeName}</h1><div class="brand-sub">Official Tax Invoice</div></div>
  <div><div class="inv-num">${invNum}</div><div class="inv-date">${date}</div></div>
</div>
<div class="bill-section">
  <div class="section-label">Bill To</div>
  <div class="bill-name">${invoiceCust.name}</div>
  <div class="bill-detail">
    📞 ${invoiceCust.phone}
    ${invoiceCust.email   ? `<br>✉️ ${invoiceCust.email}`   : ''}
    ${invoiceCust.address ? `<br>📍 ${invoiceCust.address}` : ''}
  </div>
</div>
<table>
  <thead><tr><th>Product</th><th class="center">Qty</th><th class="right">Unit Price</th><th class="right">Amount</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="totals">
  <div class="t-row"><span>Subtotal</span><span>$${invSubtotal.toFixed(2)}</span></div>
  ${invDiscountAmt > 0 ? `<div class="t-row disc"><span>Discount</span><span>-$${invDiscountAmt.toFixed(2)}</span></div>` : ''}
  <div class="t-row final"><span>Total Due</span><span>$${invTotal.toFixed(2)}</span></div>
</div>
<div class="footer">
  <div class="pay-tag">Payment: ${invPayment.charAt(0).toUpperCase() + invPayment.slice(1)}</div>
  ${invNotes ? `<p style="margin-top:8px;font-style:italic">"${invNotes}"</p>` : ''}
  <p style="margin-top:16px">Thank you for your business! 🙏</p>
</div>
</body></html>`;

    const win = window.open('', '_blank', 'width=820,height=680');
    if (win) {
      win.document.write(html);
      win.document.close();
      setTimeout(() => win.print(), 600);
    }
  }

  /* ── Filtered list ───────────────────────────────── */
  const filtered = useMemo(() => {
    if (!search.trim()) return customers;
    const q = search.toLowerCase();
    return customers.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.phone.includes(q) ||
      c.email.toLowerCase().includes(q)
    );
  }, [customers, search]);

  // A shop's customer book grows without bound; page it. Searching re-pages
  // from the start so results are never hidden behind a stale page number.
  const custPager = usePagination(filtered, 20, search);

  const ledgerInvoices = useMemo(
    () => (ledgerCust ? invoices.filter(v => v.customerId === ledgerCust.id) : []),
    [invoices, ledgerCust]
  );
  const ledgerTotals = useMemo(() => ledgerInvoices.reduce(
    (t, v) => ({ invoiced: t.invoiced + v.total, paid: t.paid + v.paidTotal, balance: t.balance + v.balance }),
    { invoiced: 0, paid: 0, balance: 0 },
  ), [ledgerInvoices]);

  const totalOutstanding = useMemo(
    () => invoices.reduce((s, v) => s + v.balance, 0),
    [invoices]
  );

  /* ── Render ──────────────────────────────────────── */
  return (
    <div className="page-anim">
      <Header showSearch={false} />

      <div className="page-title-bar">
        <span className="page-title">👥 Customers</span>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center' }}>
          {/* Credit backup — sellers worry about losing the record of what
              they're owed, so give them a copy they keep themselves. */}
          <select
            className="form-input"
            style={{ width: 'auto', padding: '6px 10px', fontSize: '.85rem' }}
            value={exportPeriod}
            onChange={e => setExportPeriod(e.target.value)}
            aria-label="Credit report period"
          >
            <option value="day">Today</option>
            <option value="week">This week</option>
            <option value="month">This month</option>
            <option value="year">This year</option>
            <option value="all">Everything</option>
          </select>
          <button className="btn btn-secondary btn-sm" onClick={() => downloadCredits('summary')}
            disabled={exporting || supplierId == null}
            title="Download who owes you, as a spreadsheet">
            {exporting ? 'Preparing…' : '⬇ Credit report'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => downloadCredits('detail')}
            disabled={exporting || supplierId == null}
            title="Download every credit invoice — the full ledger">
            Full ledger
          </button>
          <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add Customer</button>
        </div>
      </div>
      <p className="page-subtitle">
        {customers.length} customer{customers.length !== 1 ? 's' : ''}
        {totalOutstanding > 0 && <> · <strong style={{ color: 'var(--danger)' }}>${totalOutstanding.toFixed(2)} owed to you</strong></>}
      </p>

      {/* Search */}
      {customers.length > 3 && (
        <div style={{ padding: '0 16px 12px' }}>
          <input
            className="form-input"
            placeholder="Search by name, phone or email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      )}

      {/* List */}
      <div className="cust-list">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="cust-card">
              <div className="skeleton" style={{ width: 50, height: 50, borderRadius: '50%', flexShrink: 0 }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="skeleton" style={{ height: 13, width: '45%', borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 11, width: '30%', borderRadius: 6 }} />
              </div>
            </div>
          ))
        ) : filtered.length === 0 && customers.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">👥</div>
            <div className="empty-title">No customers yet</div>
            <div className="empty-sub">Add your first customer to create invoices</div>
            <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={openAdd}>
              Add First Customer
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🔍</div>
            <div className="empty-title">No results</div>
            <div className="empty-sub">Try a different name or number</div>
          </div>
        ) : (
          custPager.visible.map(c => {
            const ledger = ledgerByCustomer.get(c.id);
            return (
            <div key={c.id} className="cust-card">
              <div className="cust-avatar" style={{ background: avatarBg(c.name) }}>
                {initials(c.name)}
              </div>
              <div className="cust-info">
                <div className="cust-name">
                  {c.name}
                  {c.gender === 'male'   && <span title="Male"   style={{ marginLeft: 6, color: '#2563eb' }}>♂</span>}
                  {c.gender === 'female' && <span title="Female" style={{ marginLeft: 6, color: '#db2777' }}>♀</span>}
                </div>
                {c.phone   && <div className="cust-phone">📞 {c.phone}</div>}
                {c.email   && <div className="cust-detail">✉️ {c.email}</div>}
                {c.address && <div className="cust-detail">📍 {c.address}</div>}
                {c.notes   && <div className="cust-notes">{c.notes}</div>}
                {ledger && ledger.count > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: '.72rem', fontWeight: 700 }}>
                    <span style={{ padding: '2px 8px', borderRadius: 99, background: 'var(--primary-light)', color: 'var(--primary)' }}>
                      📋 {ledger.count} invoice{ledger.count !== 1 ? 's' : ''} · ${ledger.invoiced.toFixed(2)}
                    </span>
                    {ledger.balance > 0.005 ? (
                      <span style={{ padding: '2px 8px', borderRadius: 99, background: '#fee2e2', color: '#dc2626' }}>
                        Owes ${ledger.balance.toFixed(2)}
                      </span>
                    ) : (
                      <span style={{ padding: '2px 8px', borderRadius: 99, background: '#d1fae5', color: '#059669' }}>
                        ✓ Paid up
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="cust-actions">
                <button
                  className="btn btn-primary btn-sm"
                  style={{ fontSize: '.75rem', padding: '6px 10px' }}
                  onClick={() => openInvoice(c)}
                >📋 Invoice</button>
                {ledger && ledger.count > 0 && (
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: '.75rem', padding: '6px 10px' }}
                    onClick={() => { setLedgerCust(c); setPayAmount(''); }}
                  >📒 Ledger</button>
                )}
                <button className="btn btn-ghost btn-sm crud-edit-btn" onClick={() => openEdit(c)}>✏️</button>
                <button
                  className="btn btn-ghost btn-sm crud-del-btn"
                  onClick={() => handleDelete(c.id)}
                  disabled={deletingId === c.id}
                >{deletingId === c.id ? '…' : '🗑️'}</button>
              </div>
            </div>
            );
          })
        )}
        <Pagination
          page={custPager.page} totalPages={custPager.totalPages} onPage={custPager.setPage}
          from={custPager.from} to={custPager.to} total={custPager.total} label="customers"
        />
      </div>

      {/* ── Add / Edit Modal ─────────────────────────── */}
      {showForm && (
        <div className="modal-overlay" onClick={() => !saving && setShowForm(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>{editingId ? '✏️ Edit Customer' : '➕ New Customer'}</span>
              <button className="modal-close" onClick={() => setShowForm(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input className="form-input" placeholder="e.g. Ahmed Hassan" value={form.name} onChange={e => sf('name', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Phone Number *</label>
                <input className="form-input" placeholder="+252 61 234 5678" value={form.phone} onChange={e => sf('phone', e.target.value)} inputMode="tel" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input className="form-input" type="email" placeholder="email@example.com" value={form.email} onChange={e => sf('email', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Address</label>
                  <input className="form-input" placeholder="City, Street" value={form.address} onChange={e => sf('address', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Gender</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {([['', 'Not specified'], ['male', '♂ Male'], ['female', '♀ Female']] as const).map(([val, label]) => (
                    <button
                      key={val || 'none'}
                      type="button"
                      className={`btn btn-sm ${form.gender === val ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ flex: 1 }}
                      onClick={() => sf('gender', val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea className="form-input" rows={2} style={{ resize: 'vertical', fontFamily: 'inherit' }} placeholder="VIP customer, payment terms…" value={form.notes} onChange={e => sf('notes', e.target.value)} />
              </div>
              <button className="btn btn-primary btn-full btn-lg" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Update Customer' : 'Add Customer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Invoice Modal ─────────────────────────────── */}
      {invoiceCust && (
        <div className="modal-overlay" onClick={() => setInvoiceCust(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>📋 Create Invoice</span>
              <button className="modal-close" onClick={() => setInvoiceCust(null)}>✕</button>
            </div>
            <div className="modal-body">

              {/* Customer banner */}
              <div className="inv-cust-banner">
                <div className="inv-cust-avatar" style={{ background: avatarBg(invoiceCust.name) }}>
                  {initials(invoiceCust.name)}
                </div>
                <div>
                  <div className="inv-cust-name">{invoiceCust.name}</div>
                  <div className="inv-cust-phone">📞 {invoiceCust.phone}</div>
                </div>
              </div>

              {/* Product selector — this store's own products only */}
              <div className="form-group">
                <label className="form-label">Add Product (your store)</label>
                <select
                  className="form-input"
                  defaultValue=""
                  onChange={e => {
                    if (e.target.value) {
                      addProduct(parseInt(e.target.value, 10));
                      e.target.value = '';
                    }
                  }}
                >
                  <option value="" disabled>
                    {myProducts.length === 0 ? 'No products in your store yet' : 'Select a product to add…'}
                  </option>
                  {myProducts.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} — ${p.price.toFixed(2)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Items list */}
              {invItems.length > 0 && (
                <div className="inv-items-list">
                  {invItems.map(item => (
                    <div key={item.productId} className="inv-item-row">
                      <span className="inv-item-icon">📦</span>
                      <div className="inv-item-info">
                        <div className="inv-item-name">{item.name}</div>
                        <div className="inv-item-uprice">${item.price.toFixed(2)} ea</div>
                      </div>
                      <div className="inv-qty-ctrl">
                        <button className="inv-qty-btn" onClick={() => changeQty(item.productId, -1)}>−</button>
                        <span className="inv-qty-val">{item.qty}</span>
                        <button className="inv-qty-btn" onClick={() => changeQty(item.productId,  1)}>+</button>
                      </div>
                      <span className="inv-line-total">${(item.price * item.qty).toFixed(2)}</span>
                      <button className="inv-remove-btn" onClick={() => removeItem(item.productId)}>✕</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Discount + Payment */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
                <div className="form-group">
                  <label className="form-label">Discount ($)</label>
                  <input className="form-input" type="number" min="0" step="0.01" placeholder="0.00" value={invDiscount} onChange={e => setInvDiscount(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Payment (if paid now)</label>
                  <select className="form-input" value={invPayment} onChange={e => setInvPayment(e.target.value)}>
                    <option value="cash">💵 Cash</option>
                    <option value="waafi">📱 Waafi</option>
                    <option value="card">💳 Card</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Notes / Terms</label>
                <textarea className="form-input" rows={2} style={{ resize: 'vertical', fontFamily: 'inherit' }} placeholder="Payment terms, delivery info, thank-you note…" value={invNotes} onChange={e => setInvNotes(e.target.value)} />
              </div>

              {/* Totals */}
              {invItems.length > 0 && (
                <div className="inv-totals-box">
                  <div className="inv-total-row">
                    <span>Subtotal</span>
                    <span>${invSubtotal.toFixed(2)}</span>
                  </div>
                  {invDiscountAmt > 0 && (
                    <div className="inv-total-row disc">
                      <span>Discount</span>
                      <span>−${invDiscountAmt.toFixed(2)}</span>
                    </div>
                  )}
                  <div className="inv-total-row final">
                    <span>Total Due</span>
                    <span>${invTotal.toFixed(2)}</span>
                  </div>
                </div>
              )}

              {/* Actions */}
              <button
                className="btn btn-primary btn-full"
                style={{ marginTop: 12 }}
                onClick={handleSaveAsInvoice}
                disabled={invItems.length === 0 || savingInv || supplierId == null}
              >
                {savingInv ? 'Saving…' : `💾 Save Invoice — ${invoiceCust.name.split(' ')[0]} pays later`}
              </button>
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <button
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={handlePrint}
                  disabled={invItems.length === 0}
                >
                  🖨️ Print
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ flex: 1 }}
                  onClick={handleSaveAsOrder}
                  disabled={invItems.length === 0 || savingInv}
                >
                  {savingInv ? '…' : '✅ Paid now (save order)'}
                </button>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* ── Ledger Modal — invoices + payments for one customer ── */}
      {ledgerCust && (
        <div className="modal-overlay" onClick={() => setLedgerCust(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>📒 {ledgerCust.name} — Ledger</span>
              <button className="modal-close" onClick={() => setLedgerCust(null)}>✕</button>
            </div>
            <div className="modal-body">

              {/* Total owed — the store tracks one running balance per customer */}
              <div style={{ textAlign: 'center', padding: '4px 0 14px' }}>
                <div style={{ fontSize: '.7rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  Total owed
                </div>
                <div style={{ fontSize: '2rem', fontWeight: 800, lineHeight: 1.1, color: ledgerTotals.balance > 0.005 ? '#dc2626' : '#059669' }}>
                  ${ledgerTotals.balance.toFixed(2)}
                </div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  ${ledgerTotals.invoiced.toFixed(2)} invoiced · ${ledgerTotals.paid.toFixed(2)} paid
                </div>
              </div>

              {/* Pay off the balance — applied to the oldest invoices first */}
              {ledgerTotals.balance > 0.005 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                  <input
                    className="form-input" type="number" min="0.01" step="0.01"
                    placeholder={`Amount (max $${ledgerTotals.balance.toFixed(2)})`}
                    value={payAmount} onChange={e => setPayAmount(e.target.value)}
                    style={{ flex: '1 1 130px' }}
                  />
                  <select className="form-input" value={payMethod} onChange={e => setPayMethod(e.target.value)} style={{ flex: '0 0 110px' }}>
                    <option value="cash">💵 Cash</option>
                    <option value="waafi">📱 Waafi</option>
                    <option value="card">💳 Card</option>
                  </select>
                  <button className="btn btn-primary" disabled={savingPay || !payAmount} onClick={handleRecordTotalPayment}>
                    {savingPay ? '…' : '💰 Record'}
                  </button>
                </div>
              )}

              {/* Simple invoice list — one line each */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {ledgerInvoices.map(inv => {
                  const units = inv.items.reduce((n, i) => n + i.qty, 0);
                  return (
                    <div key={inv.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 10 }}>
                      <div>
                        <div style={{ fontSize: '.82rem', fontWeight: 700 }}>${inv.total.toFixed(2)}</div>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>
                          {fmtDate(inv.createdAt)} · {units} item{units !== 1 ? 's' : ''}
                        </div>
                      </div>
                      <span style={{
                        fontSize: '.7rem', fontWeight: 800, padding: '3px 10px', borderRadius: 99, whiteSpace: 'nowrap',
                        background: inv.status === 'paid' ? '#d1fae5' : inv.status === 'partial' ? '#fef3c7' : '#fee2e2',
                        color:      inv.status === 'paid' ? '#059669' : inv.status === 'partial' ? '#d97706' : '#dc2626',
                      }}>
                        {inv.status === 'paid' ? '✓ Paid' : `Owes $${inv.balance.toFixed(2)}`}
                      </span>
                    </div>
                  );
                })}
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
