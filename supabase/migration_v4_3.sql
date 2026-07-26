-- ============================================================
-- migration_v4_3.sql — make the seller subscription actually MONTHLY
--
-- migration_subscriptions.sql charged $14.99 / $24.99 "per month" but stored
-- only subscription_paid_at, so a single payment unlocked the dashboard
-- forever. This adds the billing period the price already promised:
--
--   • subscription_period_end — when the paid month runs out
--   • past that date the store is locked until it renews (one more charge
--     buys another 30 days; renewing early EXTENDS, it never resets)
--
-- Requires migration_subscriptions.sql. Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMPTZ;

-- Give every currently-paid store a full month from TODAY.
--
-- Do NOT derive this from subscription_paid_at: migration_subscriptions.sql
-- grandfathered existing sellers with paid_at = created_at, so a derived
-- period would already be months overdue and would lock out every live store
-- the moment this deploys. Stores that never paid (NULL paid_at) or were
-- refunded stay NULL — they are locked until they pay, as before.
UPDATE suppliers
   SET subscription_period_end = NOW() + INTERVAL '30 days'
 WHERE account_type IN ('business', 'supplier')
   AND subscription_paid_at IS NOT NULL
   AND subscription_refunded_at IS NULL
   AND subscription_period_end IS NULL;

-- Renewals due soonest first — what an admin/reminder job wants to read.
CREATE INDEX IF NOT EXISTS suppliers_subscription_period_end_idx
  ON suppliers(subscription_period_end)
  WHERE subscription_period_end IS NOT NULL;
