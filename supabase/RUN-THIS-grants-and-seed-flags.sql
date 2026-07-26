-- ============================================================
-- RUN-THIS-grants-and-seed-flags.sql
--
-- Paste into the Supabase SQL editor and run. Two independent jobs:
--
--   PART 1  Make the grandfathered free month AUDITABLE.
--           17 sellers currently have subscription_paid_at set with zero
--           ledger rows, which reads as "paid" while no money ever moved.
--           We record them as explicit GRANTS rather than inventing payments,
--           so the ledger never asserts a charge that did not happen.
--
--   PART 2  Flag seed/test rows so platform KPIs stop counting them.
--           455 of 491 orders ($196,740 of $229,893 GMV) have NO supplier_id:
--           they belong to no store and appear on no seller dashboard, yet
--           they dominate every aggregate.
--
-- Idempotent: safe to run more than once. Nothing is deleted.
-- ============================================================

-- ── PART 1 — grants ─────────────────────────────────────────

-- The ledger only allowed 'payment' | 'refund'. A comped month is neither.
ALTER TABLE subscription_events DROP CONSTRAINT IF EXISTS subscription_events_kind_check;
ALTER TABLE subscription_events
  ADD CONSTRAINT subscription_events_kind_check
  CHECK (kind IN ('payment', 'refund', 'grant'));

-- One grant row per grandfathered seller: amount 0.00 because no money moved.
-- Only for sellers that have NO ledger history at all, so a store that has
-- genuinely paid since is never touched, and re-running adds nothing.
INSERT INTO subscription_events (supplier_id, kind, amount, plan, method, note)
SELECT s.id,
       'grant',
       0.00,
       s.account_type,
       'grandfathered',
       'Free month granted when billing was switched on — no charge was made. Period ends '
         || to_char(s.subscription_period_end, 'YYYY-MM-DD') || '.'
  FROM suppliers s
 WHERE s.account_type IN ('business', 'supplier')
   AND s.subscription_paid_at IS NOT NULL
   AND s.subscription_refunded_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM subscription_events e WHERE e.supplier_id = s.id);

-- ── PART 2 — seed flags ─────────────────────────────────────

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders    ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT FALSE;

-- Test stores: the QA harness names ("Test Business Store", "Test Wholesale
-- Co", "Test Field Agent", "Flow Test Store") plus the two placeholder rows.
UPDATE suppliers
   SET is_seed = TRUE
 WHERE name ~* '^(test |flow test|the customer$|the  ?business$)'
    OR name ILIKE 'Test %';

-- Unattributed orders. A real order always carries the store it was placed
-- with (per-shop checkout sets supplier_id); these do not, so they cannot be
-- anyone's revenue. This is the bulk of the seeded volume.
UPDATE orders
   SET is_seed = TRUE
 WHERE supplier_id IS NULL;

-- Orders belonging to a flagged test store.
UPDATE orders o
   SET is_seed = TRUE
  FROM suppliers s
 WHERE o.supplier_id = s.id
   AND s.is_seed
   AND NOT o.is_seed;

CREATE INDEX IF NOT EXISTS orders_is_seed_idx    ON orders(is_seed)    WHERE NOT is_seed;
CREATE INDEX IF NOT EXISTS suppliers_is_seed_idx ON suppliers(is_seed) WHERE NOT is_seed;

-- ── Check it worked ──
SELECT 'grants recorded'  AS metric, COUNT(*)::text AS value FROM subscription_events WHERE kind = 'grant'
UNION ALL
SELECT 'seed sellers',     COUNT(*)::text FROM suppliers WHERE is_seed
UNION ALL
SELECT 'real sellers',     COUNT(*)::text FROM suppliers WHERE NOT is_seed
UNION ALL
SELECT 'seed orders',      COUNT(*)::text FROM orders WHERE is_seed
UNION ALL
SELECT 'real orders',      COUNT(*)::text FROM orders WHERE NOT is_seed
UNION ALL
SELECT 'real GMV',   '$' || COALESCE(SUM(total), 0)::text FROM orders
 WHERE NOT is_seed AND status NOT IN ('deleted', 'cancelled', 'refunded');
