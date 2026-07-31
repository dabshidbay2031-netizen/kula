# Feed Controls — Explore ranking + store-diversification

## What this delivers
A new **Feed Controls** section in the admin panel where you set priority tiers (**Normal / Reduced / Low / Hidden**) for **stores, categories/subcategories, and individual products**, plus a ranking+diversification engine that makes cheap/bulk products sink and priority products surface — while a hard "max 3 of any 10 cards from one store" cap stops any single store from dominating the Explore grid.

**Scope guarantee:** Only **Explore** changes. **Search, the store's own profile, and similar-products stay 100% untouched** (confirmed isolated — they use separate code paths and deliberately ignore tiers). "Hidden" means *excluded from Explore discovery only* — the product is still searchable and still on the store's page.

---

## Part 1 — Data model (no new table needed)

Reuse the existing **`site_settings`** JSONB key/value table (`supabase/migration_v3_4.sql`, already deployed for the hero banner). One new key:

```
key: 'feed_tiers'
value: {
  stores:     { "<supplierId>": "normal"|"reduced"|"low"|"hidden", ... },
  categories: { "<categoryId>":  "...", ... },
  subs:       { "<subCategoryId>": "...", ... },   // takes precedence over category
  products:   { "<productId>":   "...", ... },      // override — wins over everything
  capPer10:   3,   // global "max cards from one store per 10" (default 3)
  updatedAt:  "iso"
}
```

- **No migration required** if `site_settings` already exists (it does — hero uses it). I'll still ship a tiny `migration_v4_8.sql` for documentation/safety, idempotent, matching the existing migration style.
- Missing/empty config → everything Normal → feed behaves exactly as today. **Nothing breaks if admin does nothing.**

---

## Part 2 — Ranking engine: `lib/feedRanking.ts` (new, pure, fully unit-tested)

Two pure functions:

### `weightFor(product, tiers, verifiedMap) → { tier, weight, hidden }`
1. Start with `product.productOverride ?? subs[subCategory] ?? categories[category] ?? stores[supplierId] ?? 'normal'`
   - **Override precedence:** product > subcategory > category > store > normal (exactly your hierarchy).
2. Map tier → weight: `normal=1.0, reduced=0.5, low=0.15, hidden=0.0`.
3. `hidden: true` when resolved tier is `'hidden'`.

### `rankAndDiversify(items, tiers, verifiedMap, seed) → Product[]`
1. **Drop hidden** (Explore pool only).
2. **Soft-rank** the rest: keep the per-visit shuffle (existing `shuffleStable` seed) but bias each item's draw by its weight — `key = lerp(randomKey, weightKey, 0.5)`. Quality stays a mild bias; feed still varies each visit, never stale.
3. **Per-store cap (sliding window)** — greedy least-recently-used draw across stores:
   - Maintain a count of how many of the last 9 placed cards came from each store.
   - When drawing the next card, **skip** any store already at `capPer10` in the last 9.
   - Among eligible stores, draw by weighted priority (so a Normal store is picked before a Low one when both are eligible).
   - This guarantees the invariant: **any 10 consecutive cards contain ≤3 from one store** — including across the page boundary, where a naive per-page cap fails.
4. Returns the fully-ordered, capped list.

**Why this satisfies your goal:** cheap stuff (Low/Reduced tier) is drawn later and less often → seen last. Priority products (Normal) drawn first → seen more. The cap is a hard backstop independent of weights — it works even if weights are misconfigured.

---

## Part 3 — Feed integration (one-line insertion in ExploreView)

**`views/ExploreView.tsx`** — insert between line 85 and 87 (after `personalizeMix`, before filters):
```ts
const base = personalizeMix(products, affinity, shuffleSeed);
const ranked = rankAndDiversify(base, feedTiers, verifiedBySupplier, shuffleSeed);  // NEW
let list = ranked.filter(p => !p.isB2b || accountType === 'business' || accountType === 'supplier');
```
- Add `feedTiers` to the useMemo dep array.
- `feedTiers` comes from a new tiny hook `lib/useFeedTiers.ts` (fetches `/api/settings/feed-tiers`, subscribes to the `settings` realtime channel so an admin change propagates instantly — copying `lib/useHeroBanner.ts` exactly).
- **No other view changes.** Search, SupplierProfile, and similar-products are untouched and confirmed isolated.

---

## Part 4 — API: `app/api/settings/feed-tiers/route.ts` (new)

Model it precisely on `app/api/settings/hero/route.ts`:
- **`GET`** — public read; returns sanitized tiers (or empty defaults on any error — never breaks the feed).
- **`PUT`** — `requireAdmin(req, { role: 'admin' })` (full-admin only, matching hero); sanitize/validate tier values against the 4 allowed; `upsert` into `site_settings`; `pingRealtime(['settings','catalog'])` so open Explore pages re-sort immediately.
- All four tier maps are optional; missing keys = Normal.

---

## Part 5 — Admin UI: new "Feed" tab in AdminDashboard

Following the exact patterns the agent mapped (the storefront/team tab structures):
- Add `'feed'` to the `Tab` union + the admin-only `TABS` spread in `components/AdminDashboard.tsx`.
- **Three sections** in the tab, each a surface-card table with inline tier dropdowns (`.chip`-style or `<select>`):
  1. **Stores** — list from `state.suppliers` (id, name, verified badge) + a tier selector per row.
  2. **Categories & Subcategories** — from the static `CATEGORIES`/`SUBCATEGORIES` in `lib/data.ts`, grouped; tier selector per category and per subcategory. *(This is the "cheap seasonings" control — one setting on the `seasonings` sub, not 400 product edits.)*
  3. **Products** — searchable pick (by name/SKU) to set per-product overrides; shows current tier.
- Plus a global **cap setting** (`capPer10`, default 3) at the top.
- A single **Save** button does `PUT /api/settings/feed-tiers` with the whole blob; `toast()` success/error matching `grantTrial`/`setBounty` conventions; `busyId` lock during save.
- Visual tier badge reuses the translucent-tint `StatusBadge` style (Normal=green, Reduced=amber, Low=orange, Hidden=red).

---

## Part 6 — Tests (zero mess; matching existing vitest patterns)

New test files, same style as `tests/api-routes.test.ts` / `tests/admin-auth.test.ts`:
1. **`tests/feedRanking.test.ts`** — pure-engine tests:
   - weight precedence (product > sub > category > store > normal).
   - hidden products dropped from Explore only.
   - **cap invariant**: assert that in the output, every window of 10 has ≤3 from any store (programmatically scan the result). Include the adversarial case: one store with 500 products still gets ≤3-in-10.
   - low-tier products sink below normal-tier on average.
   - empty tiers → identical to a plain shuffle (no behavior change).
2. **`tests/feed-tiers-api.test.ts`** — route tests:
   - GET is public and returns defaults when table missing.
   - PUT rejects non-admin (401) and semi_admin (403); full admin (200).
   - PUT rejects invalid tier values (400); persists valid ones.

Plus a full-suite run to confirm zero regressions (currently 511 passing).

---

## Files touched / created

| File | Action |
|---|---|
| `lib/feedRanking.ts` | **new** — ranking + cap engine (pure) |
| `lib/useFeedTiers.ts` | **new** — fetch + realtime hook (copy of useHeroBanner) |
| `app/api/settings/feed-tiers/route.ts` | **new** — GET/PUT, modeled on hero/route.ts |
| `supabase/migration_v4_8.sql` | **new** — doc/optional; site_settings already exists |
| `views/ExploreView.tsx` | **edit** — one insertion at line 85 + dep array + import |
| `components/AdminDashboard.tsx` | **edit** — add 'feed' tab + section UI |
| `tests/feedRanking.test.ts` | **new** |
| `tests/feed-tiers-api.test.ts` | **new** |

**Explicitly NOT touched:** `views/SearchView.tsx`, `views/SupplierProfileView.tsx`, `lib/similarity.ts` (similar-products), `lib/affinity.ts` (personalization runs before, unchanged).

---

## Execution order
1. `lib/feedRanking.ts` + `tests/feedRanking.test.ts` (engine first, fully tested in isolation).
2. `app/api/settings/feed-tiers/route.ts` + `tests/feed-tiers-api.test.ts`.
3. `lib/useFeedTiers.ts`.
4. One-line `ExploreView.tsx` insertion.
5. Admin "Feed" tab UI.
6. Full `npm test` + `tsc --noEmit` — green before done.

This keeps each step independently verifiable and testable, so nothing compounds into a mess.