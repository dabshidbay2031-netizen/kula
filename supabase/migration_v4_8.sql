-- Migration v4.8 — Explore feed tiers (Admin → Feed Controls)
-- Run this in your Supabase project SQL editor (knnrmdkzoicjuuaaownb).
--
-- Adds the `feed_tiers` row to the existing `site_settings` key/value table
-- (created by migration_v3_4.sql for the hero banner). It holds the admin's
-- Explore ranking config as one JSONB blob:
--
--   stores     { "<supplierId>":    "normal"|"reduced"|"low"|"hidden" }
--   categories { "<categoryId>":    ... }
--   subs       { "<subCategoryId>": ... }   -- beats its parent category
--   products   { "<productId>":     ... }   -- beats everything
--   capPer10   3                            -- max cards from one store per 10
--
-- NOTHING BREAKS IF YOU SKIP THIS. The API returns empty tiers when the row (or
-- the whole table) is missing, and empty tiers rank the feed exactly as before.
-- Running it is what lets the Admin → Feed tab SAVE; it is otherwise read-only.
--
-- Idempotent: safe to run more than once.

-- Safety net in case v3_4 was never applied on this database.
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- Seed the row EMPTY (no tier assignments) with only the default cap, so the
-- feed's behaviour is unchanged on day one and an admin opts into weighting.
INSERT INTO site_settings (key, value)
VALUES ('feed_tiers', '{ "capPer10": 3 }'::jsonb)
ON CONFLICT (key) DO NOTHING;
