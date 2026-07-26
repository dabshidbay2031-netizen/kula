-- ============================================================
-- migration_v4_5.sql — shopper demographics (gender + age)
--
-- migration_customer_gender.sql added `gender` to the per-store CUSTOMER BOOK
-- (customers) — the contacts a shop keeps for its own invoicing. This is the
-- other thing: the people who sign up on the website to buy, whose accounts
-- live in `profiles`. Those had no demographics at all, so audience
-- segmentation for ads had nothing to work with.
--
-- Stores BIRTH YEAR, not age. An age column is stale the day after it's
-- written; birth year keeps implying the right age forever.
--
-- Both columns are OPTIONAL ('' / NULL = declined). Forcing the question
-- costs signups and makes people lie, which corrupts the segmentation it was
-- collected for.
--
-- Idempotent: safe to run more than once.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gender     TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS birth_year INTEGER;

-- '' means "prefer not to say" and is the default, so existing rows are valid.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_gender_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_gender_check
  CHECK (gender IN ('', 'male', 'female', 'other'));

-- 13 is the floor for ad profiling; anything outside a plausible human range
-- is a typo or a bot, and would skew every bracket it lands in.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_birth_year_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_birth_year_check
  CHECK (
    birth_year IS NULL
    OR birth_year BETWEEN (EXTRACT(YEAR FROM NOW())::INT - 110)
                      AND (EXTRACT(YEAR FROM NOW())::INT - 13)
  );

-- Partial indexes: campaign queries only ever look at people who answered.
CREATE INDEX IF NOT EXISTS profiles_gender_idx
  ON profiles(gender) WHERE gender <> '';
CREATE INDEX IF NOT EXISTS profiles_birth_year_idx
  ON profiles(birth_year) WHERE birth_year IS NOT NULL;

-- ── Audience summary for campaign planning ──────────────────
-- Aggregate only: no row here identifies anyone, so it can back a dashboard
-- without exposing individual shoppers.
CREATE OR REPLACE VIEW audience_segments AS
SELECT
  CASE WHEN gender = '' THEN 'unspecified' ELSE gender END AS gender,
  CASE
    WHEN birth_year IS NULL THEN 'unknown'
    WHEN EXTRACT(YEAR FROM NOW())::INT - birth_year <= 17 THEN '13-17'
    WHEN EXTRACT(YEAR FROM NOW())::INT - birth_year <= 24 THEN '18-24'
    WHEN EXTRACT(YEAR FROM NOW())::INT - birth_year <= 34 THEN '25-34'
    WHEN EXTRACT(YEAR FROM NOW())::INT - birth_year <= 44 THEN '35-44'
    WHEN EXTRACT(YEAR FROM NOW())::INT - birth_year <= 54 THEN '45-54'
    WHEN EXTRACT(YEAR FROM NOW())::INT - birth_year <= 64 THEN '55-64'
    ELSE '65+'
  END AS age_bracket,
  COUNT(*) AS shoppers
FROM profiles
GROUP BY 1, 2
ORDER BY 1, 2;

-- ── Check it worked ──
SELECT 'gender'     AS column, COUNT(*) FILTER (WHERE gender <> '')      AS answered, COUNT(*) AS total FROM profiles
UNION ALL
SELECT 'birth_year',           COUNT(*) FILTER (WHERE birth_year IS NOT NULL),        COUNT(*) FROM profiles;
