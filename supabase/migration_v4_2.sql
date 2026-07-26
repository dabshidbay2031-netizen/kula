-- ═══════════════════════════════════════════════════════════════════════════
-- migration_v4_2.sql — 3% platform transaction fee
--
-- The fee is added to the BUYER's total on online-paid orders (Sifalo/Waafi/
-- EVC/eDahab). A store may absorb it per-product ("transaction fee on us"),
-- in which case the buyer pays the listed price and the fee is deducted from
-- the store's payout instead.
--
-- Either way the fee is PLATFORM revenue — the payout wallet subtracts the
-- absorbed portion so a store is never paid money that isn't theirs.
--
-- Safe to re-run. Cash / POS sales are unaffected.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Per-product opt-in: the store pays this product's fee instead of the buyer.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS fee_absorbed_by_store BOOLEAN NOT NULL DEFAULT false;

-- What was actually charged, frozen at sale time so history stays accurate
-- even if the rate or a product's absorb setting changes later.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS platform_fee      DECIMAL(10,2) NOT NULL DEFAULT 0;  -- paid by the buyer
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fee_paid_by_store DECIMAL(10,2) NOT NULL DEFAULT 0;  -- absorbed by the store

COMMIT;

-- ── Verify ─────────────────────────────────────────────────────────────────
-- SELECT COUNT(*) FILTER (WHERE fee_absorbed_by_store) AS absorbing_products FROM products;
-- SELECT id, subtotal, platform_fee, fee_paid_by_store, total, payment_method
--   FROM orders WHERE platform_fee > 0 OR fee_paid_by_store > 0
--   ORDER BY created_at DESC LIMIT 20;
