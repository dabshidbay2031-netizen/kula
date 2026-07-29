-- ============================================================
-- migration_v4_7.sql — opt-in 14-day free trial
--
-- A new seller must CHOOSE: start the 14-day free trial, or pay now. Until
-- they pick one the store dashboard stays locked.
--
-- Why a new column rather than reusing trial_started_at: that one is
-- `NOT NULL DEFAULT NOW()`, so every store row is born with it set. It can
-- record when an account was created, but it can never express "this seller
-- has not chosen yet" — which is the whole point here.
--
-- self_trial_started_at is NULL until the seller clicks. Once set it stays
-- set, so the trial can be taken exactly once. And once subscription_paid_at
-- exists the offer is gone for good, so nobody can pay, cancel, and trial
-- again.
--
-- Idempotent: safe to run more than once.
-- ============================================================

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS self_trial_started_at TIMESTAMPTZ;

-- Sellers who ALREADY paid must never be offered a trial. Stamping them here
-- closes that door explicitly rather than relying on the paid check alone.
UPDATE suppliers
   SET self_trial_started_at = COALESCE(self_trial_started_at, subscription_paid_at)
 WHERE account_type IN ('business', 'supplier')
   AND subscription_paid_at IS NOT NULL
   AND self_trial_started_at IS NULL;

CREATE INDEX IF NOT EXISTS suppliers_self_trial_idx
  ON suppliers(self_trial_started_at) WHERE self_trial_started_at IS NOT NULL;

-- ── Check it worked ──
SELECT COUNT(*) FILTER (WHERE self_trial_started_at IS NULL)     AS can_still_trial,
       COUNT(*) FILTER (WHERE self_trial_started_at IS NOT NULL) AS trial_used_or_paid,
       COUNT(*)                                                  AS sellers
  FROM suppliers
 WHERE account_type IN ('business', 'supplier');
