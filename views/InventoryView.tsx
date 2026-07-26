'use client';

import { useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Header from '@/components/Header';
import ProductImage from '@/components/ProductImage';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { useMyProductIds, type ClaimRecord } from '@/lib/useMyProductIds';
import { authHeaders } from '@/lib/clientAuth';
import ProductFormModal, { type ProductFormShape, emptyProductForm } from '@/components/ProductFormModal';
import { tiersToForm, formToTiers } from '@/lib/tierPricing';

const BarcodeScanner = dynamic(() => import('@/components/BarcodeScanner'), { ssr: false });

type StockFilter = 'all' | 'low' | 'out';

type ProductForm = ProductFormShape;
const emptyForm: ProductForm = emptyProductForm;

export default function InventoryPage() {
  const { state, adjustStock, toast, reloadProducts } = useApp();
  const { currentSupplier } = useAuth();
  const { products, inventory, suppliers, loading } = state;

  // A store only manages its OWN products (owned + claimed), never the whole
  // catalog. `scoped` is false for admins / non-store accounts → show all.
  // `claimed` distinguishes products this store CLAIMED from the catalog from
  // products it OWNS directly. Both are fully editable, but they save to
  // different places: a claim's edits become per-store overrides on the
  // business_products row ("delete" = unclaim), while an owned product edits
  // the shared catalog row itself ("delete" = remove from the catalog).
  // Getting this wrong either 403s (owner-only APIs) or lets one store's edit
  // silently mutate the catalog row every other store sells from.
  const { ids: myIds, scoped: myScoped, claimed, refresh: refreshClaims } = useMyProductIds();

  const [search, setSearch]   = useState('');
  const [filter, setFilter]   = useState<StockFilter>('all');

  // ── CRUD state ────────────────────────────────────────────
  const [showForm, setShowForm]     = useState(false);
  const [editingId, setEditingId]   = useState<number | null>(null);
  // Set only when editing a product CLAIMED from the catalog. The listing is
  // this store's own — every detail is editable — but the edits are saved as
  // overrides on the claim, never onto the shared catalog row (see
  // useMyProductIds / lib/listings).
  const [editingClaim, setEditingClaim] = useState<ClaimRecord | null>(null);
  const [form, setForm]             = useState<ProductForm>(emptyForm);
  const [saving, setSaving]         = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  // Bulk-restock modal (replaces the blocked window.prompt) + delete confirm
  // modal (replaces the blocked window.confirm — neither is supported in the
  // Next 16 / Turbopack runtime).
  const [restockFor, setRestockFor] = useState<number | null>(null);
  const [restockQty, setRestockQty] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; name: string; isClaim: boolean } | null>(null);

  // ── Barcode scanner state ─────────────────────────────────
  // Both scan buttons open the shared <BarcodeScanner> modal, which always
  // shows a live camera preview. `scanTarget` says what to do with the code:
  //   'lookup' — top bar: find/edit the product with that barcode
  //   'form'   — product form: fill in the Barcode field
  const [barcodeInput, setBarcodeInput] = useState('');
  const [lookingUp, setLookingUp]       = useState(false);
  const [scanTarget, setScanTarget]     = useState<'lookup' | 'form' | null>(null);

  const openAdd = () => { setEditingId(null); setEditingClaim(null); setForm(emptyForm); setShowForm(true); };

  const openEdit = (productId: number) => {
    const p = products.find(x => x.id === productId) as (typeof products[number] & { barcode?: string }) | undefined;
    if (!p) return;
    // A CLAIMED product's real values are THIS store's own claim record — its
    // price, stock, and any details it has overridden (photos, name, …) — not
    // the catalog's. Show the store's version, falling back to the catalog for
    // anything it hasn't customized; otherwise re-saving would silently wipe
    // the store's own edits back to the catalog values.
    const claim = claimed.get(productId) ?? null;
    const ov    = (claim?.overrides ?? {}) as Record<string, unknown>;
    const own   = <T,>(key: string, base: T): T =>
      (ov[key] === null || ov[key] === undefined ? base : ov[key] as T);

    const photos = own<string[] | null>('imageUrls', null)
      ?? (own<string | null>('imageUrl', null) ? [own<string>('imageUrl', '')] : null)
      ?? (p.imageUrls?.length ? p.imageUrls : (p.imageUrl ? [p.imageUrl] : []));

    setEditingId(productId);
    setEditingClaim(claim);
    setForm({
      name: own('name', p.name),
      price: String(claim ? claim.customPrice : p.price),
      originalPrice: String(own('originalPrice', p.originalPrice)),
      cost: (() => { const c = own<number | undefined>('cost', p.cost); return c ? String(c) : ''; })(),
      category: own('category', p.category),
      subCategory: (p.subCategory as string | null) ?? '',
      brand: (p.brand as string | null) ?? '',
      tags: Array.isArray(p.tags) ? p.tags.join(', ') : '',
      stock: String(claim ? claim.stockQty : (inventory.find(i => i.id === p.id)?.stock ?? p.stock)),
      sku: own('sku', p.sku),
      description: own('description', p.description),
      supplierId: p.supplierId ? String(p.supplierId) : '',
      barcode: p.barcode ?? '',
      imageUrls: photos,
      taxMode: (p as typeof p & { taxMode?: 'none' | 'included' | 'excluded' }).taxMode ?? 'none',
      feeAbsorbedByStore: Boolean((p as typeof p & { feeAbsorbedByStore?: boolean }).feeAbsorbedByStore),
      priceTiers: tiersToForm(p.priceTiers),
    });
    setShowForm(true);
  };

  // ── Barcode lookup ────────────────────────────────────────
  const handleBarcodeLookup = useCallback(async (code: string) => {
    code = code.trim();
    if (!code) return;
    setLookingUp(true);
    try {
      const res = await fetch(`/api/products?barcode=${encodeURIComponent(code)}`);
      if (res.ok && res.status !== 404) {
        const p = await res.json();
        if (p && p.id) {
          toast(`Found: ${p.name}`, 'success');
          const claim = claimed.get(p.id) ?? null;
          const localStock = claim ? claim.stockQty : (inventory.find(i => i.id === p.id)?.stock ?? p.stock ?? 0);
          setEditingId(p.id);
          setEditingClaim(claim);
          setForm({
            name: p.name ?? '', price: String(claim ? claim.customPrice : (p.price ?? '')),
            originalPrice: String(p.originalPrice ?? p.price ?? ''),
            cost: p.cost ? String(p.cost) : '',
            category: p.category ?? 'electronics',
            subCategory: p.subCategory ?? '',
            brand: p.brand ?? '',
            tags: Array.isArray(p.tags) ? p.tags.join(', ') : '',
            stock: String(localStock),
            sku: p.sku ?? '', description: p.description ?? '',
            supplierId: p.supplierId ? String(p.supplierId) : '',
            barcode: code,
            imageUrls: p.imageUrls?.length ? p.imageUrls : (p.imageUrl ? [p.imageUrl] : []),
            taxMode: (p.taxMode as 'none' | 'included' | 'excluded') ?? 'none',
            feeAbsorbedByStore: Boolean(p.feeAbsorbedByStore),
            priceTiers: tiersToForm(p.priceTiers),
          });
          setShowForm(true);
        } else {
          toast('No product with that barcode — create one', 'default');
          setEditingId(null);
          setEditingClaim(null);
          setForm({ ...emptyForm, barcode: code });
          setShowForm(true);
        }
      } else {
        toast('No product with that barcode — create one', 'default');
        setEditingId(null);
        setForm({ ...emptyForm, barcode: code });
        setShowForm(true);
      }
    } catch {
      toast('Lookup failed — check your connection', 'error');
    }
    setLookingUp(false);
    setBarcodeInput('');
  }, [inventory, toast, claimed]);

  // Camera scanning lives entirely in <BarcodeScanner> (html5-qrcode), which
  // renders a visible preview and works on every browser. This view used to
  // call the native BarcodeDetector API directly — Chromium-only, so it simply
  // refused to scan on iOS Safari and Firefox.

  // ── Save ──────────────────────────────────────────────────
  const handleSave = async () => {
    if (!form.name.trim() || !form.price) { toast('Name and price required', 'error'); return; }
    setSaving(true);

    // A CLAIMED product is this store's own listing: photos, name, price —
    // every detail is ours to change. The edits are saved as per-store
    // overrides on the claim, so the shared catalog row is never touched and
    // the reviews stay pooled across every store selling this product.
    if (editingId && editingClaim) {
      const res = await fetch(`/api/business-products/${editingClaim.bpId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({
          customPrice:   form.price,
          stockQty:      form.stock,
          name:          form.name.trim(),
          description:   form.description.trim(),
          category:      form.category,
          sku:           form.sku.trim(),
          originalPrice: form.originalPrice || form.price,
          cost:          form.cost || '0',
          imageUrl:      form.imageUrls[0] ?? null,
          imageUrls:     form.imageUrls,
        }),
      });
      setSaving(false);
      if (res.ok) {
        toast('Listing updated ✓', 'success');
        setShowForm(false);
        refreshClaims();
        await reloadProducts();
      } else {
        const err = await res.json();
        toast(err.error ?? 'Save failed', 'error');
      }
      return;
    }

    const body = {
      name: form.name.trim(), price: form.price,
      originalPrice: form.originalPrice || form.price,
      cost: form.cost || '0',
      category: form.category, stock: form.stock,
      subCategory: form.subCategory || null,
      brand:       form.brand.trim() || null,
      tags:        form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      sku: form.sku.trim(), description: form.description.trim(),
      // Default to the signed-in store: a product created with NO supplier is
      // an orphan (supplier_id null) that its own creator can't edit/delete
      // (requireProductOwner treats ownerless rows as admin-only).
      supplierId: form.supplierId ? parseInt(form.supplierId, 10) : (currentSupplier?.id ?? null),
      barcode: form.barcode.trim() || null,
      imageUrl: form.imageUrls[0] ?? null,
      imageUrls: form.imageUrls,
      taxMode: form.taxMode,
      feeAbsorbedByStore: form.feeAbsorbedByStore,
      priceTiers: formToTiers(form.priceTiers),
    };
    const url    = editingId ? `/api/products/${editingId}` : '/api/products';
    const method = editingId ? 'PATCH' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setSaving(false);
    if (res.ok) {
      toast(editingId ? 'Product updated ✓' : 'Product added ✓', 'success');
      setShowForm(false);
      await reloadProducts();
    } else {
      const err = await res.json();
      toast(err.error ?? 'Save failed', 'error');
    }
  };

  // ── Delete / restock ──────────────────────────────────────
  // A CLAIMED product isn't ours to delete from the shared catalog — only to
  // remove FROM OUR OWN STORE (unclaim). An OWNED product is deleted outright.
  // Opens a confirm modal (window.confirm is blocked in this runtime).
  const handleDelete = (productId: number, name: string) => {
    setConfirmDelete({ id: productId, name, isClaim: claimed.has(productId) });
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    const { id: productId, isClaim } = confirmDelete;
    const claim = claimed.get(productId);
    setConfirmDelete(null);

    setDeletingId(productId);
    const res = isClaim && claim
      ? await fetch(`/api/business-products/${claim.bpId}`, { method: 'DELETE' })
      : await fetch(`/api/products/${productId}`, { method: 'DELETE' });
    setDeletingId(null);

    if (res.ok) {
      toast(isClaim ? 'Removed from your store' : 'Product deleted', 'default');
      if (isClaim) refreshClaims();
      await reloadProducts();
    } else {
      const err = await res.json().catch(() => null);
      toast(err?.error ?? 'Delete failed', 'error');
    }
  };

  // Same claimed-vs-owned branch as handleRestock, for the ±1 quick buttons.
  const quickAdjust = async (productId: number, delta: number) => {
    const claim = claimed.get(productId);
    if (claim) {
      const nextQty = Math.max(0, claim.stockQty + delta);
      const res = await fetch(`/api/business-products/${claim.bpId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stockQty: nextQty }),
      });
      if (res.ok) { refreshClaims(); await reloadProducts(); }
      else toast('Stock update failed', 'error');
      return;
    }
    adjustStock(productId, delta);
  };

  // Opens the bulk-restock modal (window.prompt is blocked in this runtime).
  const handleRestock = (productId: number) => {
    setRestockQty('');
    setRestockFor(productId);
  };

  const doRestock = async () => {
    if (restockFor == null) return;
    const productId = restockFor;
    const qty = parseInt(restockQty, 10);
    if (!Number.isFinite(qty) || qty <= 0) { toast('Enter a quantity greater than 0', 'error'); return; }
    setRestockFor(null);

    // A CLAIMED product's stock is OUR OWN allocation (business_products
    // .stock_qty), not the wholesaler's shared catalog stock.
    const claim = claimed.get(productId);
    if (claim) {
      const res = await fetch(`/api/business-products/${claim.bpId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stockQty: claim.stockQty + qty }),
      });
      if (res.ok) { toast(`Restocked ${qty} units ✓`, 'success'); refreshClaims(); await reloadProducts(); }
      else toast('Restock failed', 'error');
      return;
    }

    adjustStock(productId, qty);
    toast(`Restocked ${qty} units ✓`, 'success');
  };

  // ── Filtered list ─────────────────────────────────────────
  // Only this store's products (owned + claimed); the whole catalog for admins.
  const myProducts   = useMemo(
    () => myScoped ? products.filter(p => myIds.has(p.id)) : products,
    [products, myIds, myScoped]
  );

  // A CLAIMED product's real price/stock are THIS store's own claim record
  // (custom_price / stock_qty) — the global catalog only holds the
  // wholesaler's numbers, which would otherwise show as this store's own.
  const effectiveStock = useCallback((id: number) => {
    const c = claimed.get(id);
    if (c) return c.stockQty;
    return inventory.find(i => i.id === id)?.stock ?? 0;
  }, [claimed, inventory]);
  const effectivePrice = useCallback((p: typeof products[number]) => claimed.get(p.id)?.customPrice ?? p.price, [claimed]);

  const myInventory = useMemo(
    () => myProducts.map(p => ({ id: p.id, stock: effectiveStock(p.id) })),
    [myProducts, effectiveStock]
  );

  const items = useMemo(() => {
    return myProducts.map(p => ({
      ...p, price: effectivePrice(p), stock: effectiveStock(p.id),
    })).filter(p => {
      if (filter === 'low') return p.stock > 0 && p.stock <= 10;
      if (filter === 'out') return p.stock === 0;
      return true;
    }).filter(p => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      const bc = (p as typeof p & { barcode?: string }).barcode ?? '';
      return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || bc.toLowerCase().includes(q);
    });
  }, [myProducts, effectivePrice, effectiveStock, filter, search]);

  const totalUnits = myInventory.reduce((n, i) => n + i.stock, 0);
  const lowStock   = myInventory.filter(i => i.stock > 0 && i.stock <= 10).length;
  const outOfStock = myInventory.filter(i => i.stock === 0).length;
  const totalValue = myProducts.reduce((n, p) => n + effectivePrice(p) * effectiveStock(p.id), 0);

  function stockClass(s: number) { return s === 0 ? 'stock-danger' : s <= 10 ? 'stock-warn' : 'stock-ok'; }
  function fillClass(s: number)  { return s === 0 ? 'fill-danger'  : s <= 10 ? 'fill-warn'  : 'fill-ok'; }

  return (
    <div className="page-anim">
      <Header showSearch={false} />

      <div className="page-title-bar">
        <span className="page-title">📦 Inventory</span>
        <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add Product</button>
      </div>
      <p className="page-subtitle">Manage stock levels and product catalogue</p>

      {/* ── Barcode scanner ──────────────────────────────── */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 16, pointerEvents: 'none' }}>
              {lookingUp ? '⏳' : '🔖'}
            </span>
            <input
              className="form-input"
              style={{ paddingLeft: 34 }}
              placeholder="Scan or type barcode to find / edit product…"
              value={barcodeInput}
              onChange={e => setBarcodeInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleBarcodeLookup(barcodeInput)}
              disabled={lookingUp}
            />
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => handleBarcodeLookup(barcodeInput)}
            disabled={!barcodeInput.trim() || lookingUp}
            style={{ whiteSpace: 'nowrap' }}
          >
            {lookingUp ? 'Looking…' : '🔍 Find'}
          </button>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => setScanTarget('lookup')}
            disabled={lookingUp}
            style={{ whiteSpace: 'nowrap' }}
            title="Scan with camera"
          >
            📷 Scan
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card"><div className="stat-icon">📦</div><div className="stat-value">{totalUnits.toLocaleString()}</div><div className="stat-label">Total Units</div></div>
        <div className="stat-card warning"><div className="stat-icon">⚠️</div><div className="stat-value">{lowStock}</div><div className="stat-label">Low Stock</div></div>
        <div className="stat-card danger"><div className="stat-icon">❌</div><div className="stat-value">{outOfStock}</div><div className="stat-label">Out of Stock</div></div>
        <div className="stat-card success"><div className="stat-icon">💰</div><div className="stat-value">${Math.round(totalValue / 1000)}k</div><div className="stat-label">Total Value</div></div>
      </div>

      {/* Filters */}
      <div className="inventory-header">
        <input className="inv-search" placeholder="Search by name, SKU or barcode…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="inv-filter" value={filter} onChange={e => setFilter(e.target.value as StockFilter)}>
          <option value="all">All</option>
          <option value="low">Low Stock</option>
          <option value="out">Out of Stock</option>
        </select>
      </div>

      {/* List */}
      <div className="inv-list">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="inv-item">
              <div className="skeleton" style={{ width: 46, height: 46, borderRadius: 10, flexShrink: 0 }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="skeleton" style={{ height: 13, width: '60%', borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 10, width: '30%', borderRadius: 6 }} />
                <div className="skeleton" style={{ height: 5, borderRadius: 99 }} />
              </div>
            </div>
          ))
        ) : items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📦</div>
            <div className="empty-title">No items found</div>
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={openAdd}>Add First Product</button>
          </div>
        ) : (
          items.map(p => {
            const original = products.find(x => x.id === p.id);
            const maxStock = original?.stock ?? 100;
            const pct = Math.round((p.stock / Math.max(maxStock, 1)) * 100);
            const barcode = (p as typeof p & { barcode?: string }).barcode;
            const isClaimedItem = claimed.has(p.id);
            return (
              <div key={p.id} className="inv-item">
                <div className="inv-item-icon">
                  <ProductImage imageUrl={(p as typeof p & {imageUrl?:string}).imageUrl} imageUrls={(p as typeof p & {imageUrls?:string[]}).imageUrls} name={p.name} style={{ borderRadius: 10 }} />
                </div>
                <div className="inv-item-info">
                  <div className="inv-item-name">
                    {p.name}
                    {isClaimedItem && <span className="inv-claimed-badge" title="Claimed from a wholesaler — price & stock are yours; everything else isn't">🔗 Claimed</span>}
                  </div>
                  <div className="inv-item-sku">
                    {p.sku} · ${p.price.toFixed(2)}
                    {barcode && (
                      <span style={{ marginLeft: 6, opacity: 0.55, fontSize: 11 }}>🔖 {barcode}</span>
                    )}
                  </div>
                  <div className="stock-bar-wrap">
                    <div className="stock-bar">
                      <div className={`stock-bar-fill ${fillClass(p.stock)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                    <span className={`stock-count ${stockClass(p.stock)}`}>
                      {p.stock === 0 ? '❌ Out' : p.stock <= 10 ? `⚠️ ${p.stock}` : `${p.stock} units`}
                    </span>
                  </div>
                </div>
                <div className="inv-item-actions">
                  <button className="inv-action-btn" onClick={() => quickAdjust(p.id, -1)} title="Remove 1">−</button>
                  <button className="inv-action-btn" onClick={() => quickAdjust(p.id,  1)} title="Add 1">+</button>
                  <button className="inv-action-btn" onClick={() => handleRestock(p.id)}  title="Bulk restock">↑</button>
                  <button className="inv-action-btn edit" onClick={() => openEdit(p.id)} title="Edit">✏️</button>
                  <button
                    className="inv-action-btn del"
                    onClick={() => handleDelete(p.id, p.name)}
                    disabled={deletingId === p.id}
                    title={isClaimedItem ? 'Remove from your store' : 'Delete'}
                  >
                    {deletingId === p.id ? '…' : '🗑️'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Add / Edit Modal — the shared app-wide product form ─── */}
      {showForm && (
        <ProductFormModal
          form={form}
          setForm={setForm}
          saving={saving}
          onSave={handleSave}
          onClose={() => setShowForm(false)}
          editingId={editingId}
          editingClaim={!!editingClaim}
          suppliers={suppliers}
        />
      )}

      {/* ── Bulk Restock Modal ────────────────────────────── */}
      {restockFor !== null && (
        <div className="modal-overlay" onClick={() => setRestockFor(null)}>
          <div className="modal-box" style={{ maxWidth: 380 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>↑ Restock {products.find(p => p.id === restockFor)?.name ?? 'product'}</span>
              <button className="modal-close" onClick={() => setRestockFor(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Quantity to add</label>
                <input
                  className="form-input"
                  type="number" min="1" inputMode="numeric" autoFocus
                  placeholder="e.g. 50"
                  value={restockQty}
                  onChange={e => setRestockQty(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') doRestock(); }}
                />
              </div>
              <button className="btn btn-primary btn-full btn-lg" onClick={doRestock}>
                Add to stock
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete / Unclaim Confirm Modal ────────────────── */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal-box" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>{confirmDelete.isClaim ? '🔗 Remove from your store' : '🗑️ Delete product'}</span>
              <button className="modal-close" onClick={() => setConfirmDelete(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 18, lineHeight: 1.5 }}>
                {confirmDelete.isClaim
                  ? <>Remove <strong>{confirmDelete.name}</strong> from your store? Other stores that claimed it are unaffected.</>
                  : <>Delete <strong>{confirmDelete.name}</strong>? This cannot be undone.</>}
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-outline btn-lg" style={{ flex: 1 }} onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
                <button className="btn btn-danger btn-lg" style={{ flex: 1 }} onClick={doDelete}>
                  {confirmDelete.isClaim ? 'Remove' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Camera scanner for the top lookup bar — finds/edits a product by its
          barcode. (The product form has its own scanner inside ProductFormModal.) */}
      {scanTarget === 'lookup' && (
        <BarcodeScanner
          title="Scan to find product"
          onDetected={code => handleBarcodeLookup(code)}
          onClose={() => setScanTarget(null)}
        />
      )}
    </div>
  );
}
