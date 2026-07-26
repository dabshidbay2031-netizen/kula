-- ============================================================
-- RUN-THIS-enable-billing.sql
--
-- Paste this whole file into the Supabase SQL editor and run it.
-- Until it runs, the subscription payment CANNOT appear: the API returns
-- 501 "Billing not enabled", `billingEnabled` is false, and every seller is
-- treated as not-required-to-pay.
--
-- It is migration_subscriptions.sql + migration_v4_3.sql back to back, so
-- after this the monthly cycle is live end to end. Both halves are
-- idempotent — safe to run more than once.
-- ============================================================

-- ── PART 1 — the paid-access model (was migration_subscriptions.sql) ──
--   • $14.99 / month  business
--   • $24.99 / month  supplier
--   • 7-day money-back guarantee (full self-service refund inside the window)

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS subscription_paid_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_plan        TEXT,
  ADD COLUMN IF NOT EXISTS subscription_amount      NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS subscription_sid         TEXT;

-- Grandfather EXISTING seller accounts. Stores that joined before billing
-- existed must not be locked out by the new paywall, so they count as paid
-- long ago. New sign-ups keep NULL subscription_paid_at → locked until they pay.
UPDATE suppliers
   SET subscription_paid_at = COALESCE(subscription_paid_at, created_at),
       subscription_plan    = COALESCE(subscription_plan, account_type),
       subscription_amount  = COALESCE(
         subscription_amount,
         CASE account_type WHEN 'supplier' THEN 24.99
                           WHEN 'business' THEN 14.99
                           ELSE NULL END)
 WHERE account_type IN ('business', 'supplier');

-- Audit ledger: one row per payment / refund (receipts + reconciliation).
CREATE TABLE IF NOT EXISTS subscription_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_id  BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  kind         TEXT   NOT NULL CHECK (kind IN ('payment', 'refund')),
  amount       NUMERIC(10,2) NOT NULL,
  plan         TEXT,
  method       TEXT,        -- sifalo gateway (waafi / edahab / pbwallet) or 'admin'
  sid          TEXT,        -- Sifalo transaction id (or MOCK-… in mock mode)
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscription_events_supplier_idx
  ON subscription_events(supplier_id);

-- ── PART 2 — make it genuinely MONTHLY (was migration_v4_3.sql) ──
-- Without this a single payment unlocks the dashboard forever, while the UI
-- advertises a monthly fee.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMPTZ;

-- Give every currently-paid store a full month from TODAY.
--
-- Do NOT derive this from subscription_paid_at: Part 1 grandfathered existing
-- sellers with paid_at = created_at, so a derived period would already be
-- months overdue and would lock out every live store the moment this runs.
UPDATE suppliers
   SET subscription_period_end = NOW() + INTERVAL '30 days'
 WHERE account_type IN ('business', 'supplier')
   AND subscription_paid_at IS NOT NULL
   AND subscription_refunded_at IS NULL
   AND subscription_period_end IS NULL;

CREATE INDEX IF NOT EXISTS suppliers_subscription_period_end_idx
  ON suppliers(subscription_period_end)
  WHERE subscription_period_end IS NOT NULL;

-- ── Check it worked ──
SELECT COUNT(*) FILTER (WHERE subscription_paid_at    IS NOT NULL) AS paid_stores,
       COUNT(*) FILTER (WHERE subscription_period_end IS NOT NULL) AS with_period,
       COUNT(*)                                                    AS total_sellers
  FROM suppliers
 WHERE account_type IN ('business', 'supplier');
