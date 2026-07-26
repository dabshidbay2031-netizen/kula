'use client';

import { useMemo, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { CATEGORIES, SUBCATEGORIES } from '@/lib/data';
import StoreAvatar, { isLogoUrl } from '@/components/StoreAvatar';
import type { Supplier } from '@/lib/types';

const ProductImageUpload = dynamic(() => import('@/components/ProductImageUpload'), { ssr: false });
const BarcodeScanner     = dynamic(() => import('@/components/BarcodeScanner'),     { ssr: false });

/**
 * The ONE product add/edit form for the whole app — used by both the Inventory
 * page and the business Profile page so they stay pixel-for-pixel identical.
 *
 * It owns nothing but the camera-scanner toggle; the caller holds the form
 * state (so it can pre-fill on edit and drive its own save call) and passes a
 * `setForm` dispatcher. `editingClaim` switches to "your listing" mode, which
 * hides the fields that belong to the shared catalog (supplier, tax, barcode).
 */
export interface ProductFormShape {
  name: string; price: string; originalPrice: string; cost: string;
  category: string; subCategory: string; brand: string; tags: string;
  stock: string; sku: string; description: string;
  supplierId: string; barcode: string; imageUrls: string[];
  taxMode: 'none' | 'included' | 'excluded';
  /** Store pays the 3% transaction fee instead of adding it to the buyer. */
  feeAbsorbedByStore: boolean;
  /** Wholesale bulk pricing. Kept as strings while editing so a half-typed
   *  number doesn't get coerced to 0 under the seller's cursor. */
  priceTiers: { minQty: string; maxQty: string; price: string }[];
}

export const emptyProductForm: ProductFormShape = {
  name: '', price: '', originalPrice: '', cost: '', category: 'electronics',
  subCategory: '', brand: '', tags: '',
  stock: '0', sku: '', description: '', supplierId: '', barcode: '', imageUrls: [],
  taxMode: 'none',
  feeAbsorbedByStore: false,
  priceTiers: [],
};

interface Props {
  form: ProductFormShape;
  setForm: Dispatch<SetStateAction<ProductFormShape>>;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
  editingId: number | null;
  /** Editing a listing CLAIMED from the catalog — hide catalog-owned fields. */
  editingClaim?: boolean;
  suppliers: Supplier[];
  /** Show the Supplier picker (owned products only). Default true. */
  showSupplier?: boolean;
  /** Optional AI-generate button, rendered under the photo uploader. */
  aiSlot?: ReactNode;
}

export default function ProductFormModal({
  form, setForm, saving, onSave, onClose, editingId,
  editingClaim = false, suppliers, showSupplier = true, aiSlot,
}: Props) {
  const [scanOpen, setScanOpen] = useState(false);
  const pf = (k: keyof ProductFormShape, v: string) => setForm(f => ({ ...f, [k]: v }));

  /** Edit one field of one bulk-pricing tier. */
  const setTier = (i: number, k: 'minQty' | 'maxQty' | 'price', v: string) =>
    setForm(f => ({
      ...f,
      priceTiers: f.priceTiers.map((t, j) => (j === i ? { ...t, [k]: v } : t)),
    }));

  // Live margin readout as the owner types price & cost.
  const formMargin = useMemo(() => {
    const price = parseFloat(form.price) || 0;
    const cost  = parseFloat(form.cost)  || 0;
    if (!form.cost || price <= 0) return null;
    const profit = price - cost;
    return { profit, pct: Math.round((profit / price) * 100) };
  }, [form.price, form.cost]);

  const withSupplier = showSupplier && !editingClaim;

  return (
    <div className="modal-overlay" onClick={() => !saving && onClose()}>
      <div className="modal-box" style={{ maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{editingClaim ? '✏️ Edit Your Listing' : editingId ? '✏️ Edit Product' : '➕ Add Product'}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">

          {editingClaim && (
            <div className="inv-claim-notice">
              This is <strong>your listing</strong> — the photos, name, price and every detail below are yours to
              change, and only your store sees them. <strong>Reviews are shared</strong> with every store selling
              this product, so its ratings stay pooled. Use Delete to remove it from your store.
            </div>
          )}

          {/* Product photos — upload up to 8; the first is the cover. */}
          <div className="form-group">
            <label className="form-label">📷 Product Photos</label>
            <ProductImageUpload
              urls={form.imageUrls}
              onChange={urls => setForm(f => ({ ...f, imageUrls: urls }))}
              maxPhotos={8}
            />
          </div>

          {aiSlot}

          <div className="form-group">
            <label className="form-label">Product Name *</label>
            <input className="form-input" placeholder="e.g. iPhone 15 Pro" value={form.name} onChange={e => pf('name', e.target.value)} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group">
              <label className="form-label">{editingClaim ? 'Your Price ($) *' : 'Sale Price ($) *'}</label>
              <input className="form-input" type="number" min="0" step="0.01" placeholder="0.00" value={form.price} onChange={e => pf('price', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Original Price ($)</label>
              <input className="form-input" type="number" min="0" step="0.01" placeholder="0.00" value={form.originalPrice} onChange={e => pf('originalPrice', e.target.value)} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group">
              <label className="form-label">Cost ($)</label>
              <input className="form-input" type="number" min="0" step="0.01" placeholder="0.00" value={form.cost} onChange={e => pf('cost', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Profit Margin</label>
              <div className="form-input" style={{
                display: 'flex', alignItems: 'center', fontWeight: 700,
                color: formMargin == null ? 'var(--text-muted)' : formMargin.profit >= 0 ? 'var(--success)' : 'var(--danger)',
              }}>
                {formMargin == null ? '— enter a cost' : `$${formMargin.profit.toFixed(2)} (${formMargin.pct}%)`}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group">
              <label className="form-label">Category *</label>
              <select className="form-input" value={form.category} onChange={e => { pf('category', e.target.value); pf('subCategory', ''); }}>
                {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Subcategory</label>
              <select className="form-input" value={form.subCategory} onChange={e => pf('subCategory', e.target.value)}>
                <option value="">None</option>
                {(SUBCATEGORIES[form.category] ?? []).map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group">
              <label className="form-label">Stock Qty</label>
              <input className="form-input" type="number" min="0" placeholder="0" value={form.stock} onChange={e => pf('stock', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Brand</label>
              <input className="form-input" placeholder="Apple, Samsung…" value={form.brand} onChange={e => pf('brand', e.target.value)} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Tags (comma-separated)</label>
            <input className="form-input" placeholder="Wireless, USB-C, 5G" value={form.tags} onChange={e => pf('tags', e.target.value)} />
          </div>

          {/* SKU is the store's own code; the Supplier picker only applies to an
              owned product (a claim's selling store IS the supplier). */}
          <div style={{ display: 'grid', gridTemplateColumns: withSupplier ? '1fr 1fr' : '1fr', gap: 10 }}>
            <div className="form-group">
              <label className="form-label">SKU</label>
              <input className="form-input" placeholder="e.g. PRD-001" value={form.sku} onChange={e => pf('sku', e.target.value)} />
            </div>
            {withSupplier && (
              <div className="form-group">
                <label className="form-label">Supplier</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {(() => {
                    const picked = suppliers.find(s => String(s.id) === form.supplierId);
                    return (
                      <div style={{ width: 38, height: 38, flexShrink: 0, borderRadius: 10, overflow: 'hidden', display: 'grid', placeItems: 'center', fontSize: 22, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                        <StoreAvatar value={picked?.icon ?? '🏪'} />
                      </div>
                    );
                  })()}
                  <select className="form-input" style={{ flex: 1 }} value={form.supplierId} onChange={e => pf('supplierId', e.target.value)}>
                    <option value="">None</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>
                        {isLogoUrl(s.icon) ? '🏪' : s.icon} {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {!editingClaim && (
            <>
              {/* Tax / VAT mode */}
              <div className="form-group">
                <label className="form-label">VAT / Tax (5%)</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                  {([
                    { value: 'none',     label: 'No Tax',       sub: 'Tax-free' },
                    { value: 'included', label: 'Tax Included', sub: 'Price incl. VAT' },
                    { value: 'excluded', label: 'Tax Excluded', sub: '+5% at checkout' },
                  ] as const).map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, taxMode: opt.value }))}
                      style={{
                        padding: '8px 6px',
                        borderRadius: 10,
                        border: `2px solid ${form.taxMode === opt.value ? 'var(--primary)' : 'var(--border)'}`,
                        background: form.taxMode === opt.value ? 'var(--primary-soft, rgba(99,102,241,.1))' : 'var(--surface)',
                        color: form.taxMode === opt.value ? 'var(--primary)' : 'var(--text)',
                        cursor: 'pointer',
                        textAlign: 'center',
                        transition: 'border-color .15s, background .15s',
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: '.8rem' }}>{opt.label}</div>
                      <div style={{ fontSize: '.68rem', opacity: .7, marginTop: 2 }}>{opt.sub}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Who pays the 3% platform fee on online-paid orders */}
              <div className="form-group">
                <label className="form-label">Transaction fee (3%)</label>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, feeAbsorbedByStore: !f.feeAbsorbedByStore }))}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                    border: `2px solid ${form.feeAbsorbedByStore ? 'var(--primary)' : 'var(--border)'}`,
                    background: form.feeAbsorbedByStore ? 'var(--primary-soft, rgba(99,102,241,.1))' : 'var(--surface)',
                    transition: 'border-color .15s, background .15s',
                  }}
                >
                  <span style={{
                    width: 20, height: 20, flexShrink: 0, borderRadius: 6, display: 'grid', placeItems: 'center',
                    border: `2px solid ${form.feeAbsorbedByStore ? 'var(--primary)' : 'var(--border)'}`,
                    background: form.feeAbsorbedByStore ? 'var(--primary)' : 'transparent',
                    color: '#fff', fontSize: '.7rem', fontWeight: 800,
                  }}>{form.feeAbsorbedByStore ? '✓' : ''}</span>
                  <span>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '.84rem' }}>
                      Transaction fee on us
                    </span>
                    <span style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                      {form.feeAbsorbedByStore
                        ? 'You pay the 3% — the buyer pays exactly your listed price.'
                        : 'The buyer pays 3% on top at checkout (online payments only).'}
                    </span>
                  </span>
                </button>
              </div>

              {/* Wholesale bulk pricing — cheaper per unit at higher quantities */}
              <div className="form-group">
                <label className="form-label">Bulk pricing (optional)</label>
                <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                  Cheaper per-unit price at higher quantities. Leave “To” empty for “and above”.
                </div>

                {form.priceTiers.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 32px', gap: 6, fontSize: '.66rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                      <span>From qty</span><span>To qty</span><span>Unit price</span><span />
                    </div>
                    {form.priceTiers.map((t, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 32px', gap: 6, alignItems: 'center' }}>
                        <input
                          className="form-input" type="number" min="1" placeholder="100"
                          value={t.minQty}
                          onChange={e => setTier(i, 'minQty', e.target.value)}
                          style={{ padding: '6px 8px', fontSize: '.82rem' }}
                        />
                        <input
                          className="form-input" type="number" min="1" placeholder="∞"
                          value={t.maxQty}
                          onChange={e => setTier(i, 'maxQty', e.target.value)}
                          style={{ padding: '6px 8px', fontSize: '.82rem' }}
                        />
                        <input
                          className="form-input" type="number" min="0" step="0.01" placeholder="1.70"
                          value={t.price}
                          onChange={e => setTier(i, 'price', e.target.value)}
                          style={{ padding: '6px 8px', fontSize: '.82rem' }}
                        />
                        <button
                          type="button"
                          onClick={() => setForm(f => ({ ...f, priceTiers: f.priceTiers.filter((_, j) => j !== i) }))}
                          title="Remove this tier"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--danger)' }}
                        >✕</button>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setForm(f => ({
                    ...f,
                    // Start the next tier where the previous one left off.
                    priceTiers: [...f.priceTiers, { minQty: '', maxQty: '', price: '' }],
                  }))}
                >+ Add tier</button>
              </div>

              {/* Barcode field + camera scan */}
              <div className="form-group">
                <label className="form-label">Barcode</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="form-input"
                    placeholder="EAN-13, UPC-A, Code-128…"
                    value={form.barcode}
                    onChange={e => pf('barcode', e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    title="Scan with camera"
                    onClick={() => setScanOpen(true)}
                    style={{ flexShrink: 0 }}
                  >
                    📷
                  </button>
                </div>
              </div>
            </>
          )}

          <div className="form-group">
            <label className="form-label">Description</label>
            <textarea className="form-input" rows={3} style={{ resize: 'vertical', fontFamily: 'inherit' }} placeholder="Product details…" value={form.description} onChange={e => pf('description', e.target.value)} maxLength={500} />
          </div>

          {editingClaim && (
            <p style={{ fontSize: '.72rem', color: 'var(--text-muted)', margin: '0 0 10px' }}>
              Barcode and reviews stay shared with the catalog — they identify the product itself.
            </p>
          )}

          <button className="btn btn-primary btn-full btn-lg" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : editingClaim ? 'Update Listing' : editingId ? 'Update Product' : 'Add Product'}
          </button>
        </div>
      </div>

      {/* Camera scanner for the Barcode field (any symbology). */}
      {scanOpen && (
        <BarcodeScanner
          title="Scan product barcode"
          allowAnyFormat
          onDetected={code => pf('barcode', code)}
          onClose={() => setScanOpen(false)}
        />
      )}
    </div>
  );
}
