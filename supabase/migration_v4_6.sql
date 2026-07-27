-- ============================================================
-- migration_v4_6.sql — admin free trials + agent approval + 3-month commission
--
-- Three things:
--
--   1. TRIALS. An admin can give a store N free days. The dashboard unlocks
--      without payment, but a trial is NOT a payment: it earns an agent
--      nothing and does not advance the commission clock.
--
--   2. AGENT APPROVAL. A field agent who signs up is 'pending' and can do
--      nothing until an admin approves them, so no unvetted stranger can
--      touch a real store or earn a payout.
--
--   3. COMMISSION LEDGER. $6 per store per paid month, for 3 months. One row
--      per (store, instalment) so a payout can never be double-counted — the
--      primary key makes a duplicate physically impossible.
--
-- Requires migration_v3_9 (agent columns) and migration_subscriptions.
-- Idempotent: safe to run more than once.
-- ============================================================

-- ── 1. Admin-granted free trial ─────────────────────────────
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS trial_ends_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_granted_by TEXT,          -- admin auth uid, for the audit trail
  ADD COLUMN IF NOT EXISTS trial_granted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS suppliers_trial_ends_at_idx
  ON suppliers(trial_ends_at) WHERE trial_ends_at IS NOT NULL;

-- ── 2. Agent approval gate ──────────────────────────────────
-- Existing agent accounts are grandfathered as approved: they are already
-- working, and silently cutting them off would break live relationships.
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS agent_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_rejected_at TIMESTAMPTZ;

UPDATE suppliers
   SET agent_approved_at = COALESCE(agent_approved_at, created_at)
 WHERE account_type = 'agent'
   AND agent_approved_at IS NULL
   AND agent_rejected_at IS NULL;

-- ── 3. Commission ledger ────────────────────────────────────
-- PRIMARY KEY (supplier_id, instalment) is the safety rail: the same store
-- can never earn instalment 2 twice, however many times the accrual runs.
CREATE TABLE IF NOT EXISTS agent_commissions (
  supplier_id BIGINT       NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  instalment  SMALLINT     NOT NULL CHECK (instalment BETWEEN 1 AND 3),
  agent_id    BIGINT       NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  amount      NUMERIC(10,2) NOT NULL DEFAULT 6.00,
  status      TEXT         NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid')),
  earned_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  paid_at     TIMESTAMPTZ,
  note        TEXT,
  PRIMARY KEY (supplier_id, instalment)
);

CREATE INDEX IF NOT EXISTS agent_commissions_agent_idx  ON agent_commissions(agent_id);
CREATE INDEX IF NOT EXISTS agent_commissions_status_idx ON agent_commissions(status) WHERE status = 'due';

-- ── Payout summary per agent ────────────────────────────────
CREATE OR REPLACE VIEW agent_commission_summary AS
SELECT a.id                                                        AS agent_id,
       a.name                                                      AS agent_name,
       COUNT(DISTINCT c.supplier_id)                               AS stores,
       COUNT(*) FILTER (WHERE c.status = 'due')                    AS instalments_due,
       COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'due'),  0) AS amount_due,
       COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'paid'), 0) AS amount_paid
  FROM agent_commissions c
  JOIN suppliers a ON a.id = c.agent_id
 GROUP BY a.id, a.name
 ORDER BY amount_due DESC;

-- ── Check it worked ──
SELECT 'trial column'      AS item, EXISTS (SELECT 1 FROM information_schema.columns
                                             WHERE table_name='suppliers' AND column_name='trial_ends_at')::text AS ok
UNION ALL
SELECT 'agent_approved_at',        EXISTS (SELECT 1 FROM information_schema.columns
                                             WHERE table_name='suppliers' AND column_name='agent_approved_at')::text
UNION ALL
SELECT 'agent_commissions',        EXISTS (SELECT 1 FROM information_schema.tables
                                             WHERE table_name='agent_commissions')::text
UNION ALL
SELECT 'agents grandfathered',     COUNT(*)::text FROM suppliers
                                    WHERE account_type='agent' AND agent_approved_at IS NOT NULL;
