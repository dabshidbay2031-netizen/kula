'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { useCashier } from '@/context/CashierContext';
import { authHeaders } from '@/lib/clientAuth';
import type { ClaimRow, OverridableField } from '@/lib/listings';

/** A claimed product's business-specific record — what THIS store, not the
 *  wholesaler, actually charges/stocks it at. */
export interface ClaimRecord {
  bpId:        number;  // business_products.id — target for unclaim/PATCH
  customPrice: number;
  stockQty:    number;
  moq:         number;
  isActive:    boolean;
  /** This store's own edits to the catalog row (photos, name, …). A NULL field
   *  means "inherit from the catalog" — see lib/listings. Needed so the edit
   *  form shows what the STORE saved, not the wholesaler's original. */
  overrides:   Partial<Record<OverridableField, unknown>>;
  customized:  boolean;
}

/**
 * The set of product ids the current store actually sells:
 *   • OWNED   — catalog rows where products.supplier_id === my store
 *   • CLAIMED — business_products rows (a business sourcing from a wholesaler)
 *
 * Works for both an owner's Supabase session AND a cashier session — a cashier
 * has no Supabase user, so we resolve the store from `cashier.businessId`
 * (the owner's auth id) against the supplier list. Without this a cashier would
 * fall through to `scoped === false` and see the whole catalog.
 *
 * `scoped` is true once we know which store this is; when false (e.g. an admin
 * or plain customer) callers should show everything. Used to keep POS +
 * Inventory to a store's own products instead of the whole catalog.
 */
export function useMyProductIds(): {
  ids: Set<number>;
  scoped: boolean;
  ready: boolean;
  /** My own store's supplier id, or null when not scoped to a store. */
  supplierId: number | null;
  /** productId → this store's OWN claim record (custom price/stock/moq), for
   *  products CLAIMED from a wholesaler. A product NOT in this map (but still
   *  in `ids`) is one this store OWNS directly — "edit"/"delete" mean
   *  different things for each (adjust the claim vs. edit/delete the shared
   *  catalog row), so callers must branch on this. */
  claimed: Map<number, ClaimRecord>;
  /** Source ids this store has COPIED (products.copied_from_product_id). Lets
   *  the catalog show "In your store" on the ORIGINAL row a store copied from,
   *  whose own id is naturally absent from `ids`. */
  copiedSources: Set<number>;
  /** Re-fetch the claim records (call after PATCHing/DELETEing a claim so the
   *  in-memory map isn't stale until the next full mount). */
  refresh: () => void;
} {
  const { currentSupplier } = useAuth();
  const { cashier } = useCashier();
  const { state } = useApp();

  const supplierId = useMemo(() => {
    if (currentSupplier?.id != null) return currentSupplier.id;
    if (cashier) return state.suppliers.find(s => s.authUserId === cashier.businessId)?.id ?? null;
    return null;
  }, [currentSupplier, cashier, state.suppliers]);

  const [claimed, setClaimed] = useState<Map<number, ClaimRecord>>(new Map());
  const [ready,   setReady]   = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick(t => t + 1), []);

  useEffect(() => {
    if (supplierId == null) { setClaimed(new Map()); setReady(true); return; }
    let cancelled = false;
    setReady(false);
    (async () => {
      try {
        const r = await fetch(`/api/business-products?supplierId=${supplierId}`, {
          headers: await authHeaders(),
        });
        const bp = await r.json();
        if (cancelled) return;
        const map = new Map<number, ClaimRecord>();
        if (Array.isArray(bp)) {
          for (const row of bp as ClaimRow[]) {
            map.set(row.productId, {
              bpId: row.id, customPrice: Number(row.customPrice ?? 0), stockQty: Number(row.stockQty ?? 0),
              moq: row.moq ?? 1, isActive: row.isActive,
              overrides: row.overrides ?? {},
              customized: Boolean(row.customizedAt),
            });
          }
        }
        setClaimed(map);
      } catch {
        if (!cancelled) setClaimed(new Map());
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [supplierId, refreshTick]);

  const ids = useMemo(() => {
    const s = new Set<number>(claimed.keys());
    if (supplierId != null) {
      for (const p of state.products) if (p.supplierId === supplierId) s.add(p.id);
    }
    return s;
  }, [claimed, state.products, supplierId]);

  // Which catalog rows this store already copied. A copy is its own product, so
  // the SOURCE id never lands in `ids` — without this the original would still
  // offer "Add to Store" after the store had already copied it.
  const copiedSources = useMemo(() => {
    const s = new Set<number>();
    if (supplierId != null) {
      for (const p of state.products) {
        if (p.supplierId === supplierId && p.copiedFromProductId != null) s.add(p.copiedFromProductId);
      }
    }
    return s;
  }, [state.products, supplierId]);

  return { ids, copiedSources, scoped: supplierId != null, ready, supplierId, claimed, refresh };
}
