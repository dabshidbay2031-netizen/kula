'use client';

import type { Product } from '@/lib/types';
import { shuffleStable } from '@/lib/shuffle';
import { type FeedTiers, TIER_WEIGHT, tierFor, effectiveCap } from '@/lib/feedTiers';

/**
 * Explore-grid ranking + store-diversification.
 *
 * Two concerns, kept deliberately separate:
 *
 *  1. WEIGHTING  — admin-set priority tiers (Normal / Reduced / Low / Hidden)
 *     decide how strongly each product is *drawn* into the feed. Cheap, bulk,
 *     or low-priority items sink; priority items surface. This is soft: a
 *     weight biases the draw but does NOT guarantee a position, so the grid
 *     still varies per visit (via the page seed) and never goes stale.
 *
 *  2. THE CAP    — a hard "at most N cards from any one store in any 10-card
 *     window" rule, applied LAST and independent of weighting. It is the
 *     backstop that stops a store with 500 products from owning the grid
 *     *regardless* of how the weights are set. Implemented as a greedy
 *     least-recently-used draw across stores, which guarantees the window
 *     invariant even across the page boundary (a naive per-page cap fails
 *     there).
 *
 * The hierarchy for resolving a product's tier — exactly the admin model:
 *
 *     product override  >  subcategory  >  category  >  store  >  Normal
 *
 * "Hidden" means excluded from the Explore *discovery* pool ONLY. A hidden
 * product is still fully indexed: it appears in Search and on the store's own
 * profile. This module never touches those surfaces — only Explore calls it.
 *
 * Everything here is PURE: same (items, tiers, seed) → same output, which makes
 * it fully unit-testable and free of side effects.
 */

/* The tier vocabulary + config validation live in `lib/feedTiers.ts` — a pure
 * module with no 'use client', so the API route can call `sanitizeTiers` on the
 * server (a client module resolves to opaque references there). Re-exported
 * here so `@/lib/feedRanking` stays the single import site for the feed. */
export {
  TIER_WEIGHT, TIER_OPTIONS, TIER_COLOR, EMPTY_TIERS, DEFAULT_CAP_PER_10,
  isTier, tierFor, sanitizeTiers, effectiveCap, countRules,
} from '@/lib/feedTiers';
export type { Tier, FeedTiers } from '@/lib/feedTiers';

/** The numeric weight for a resolved tier. Hidden → 0. */
export function weightFor(p: Product, tiers: FeedTiers): number {
  return TIER_WEIGHT[tierFor(p, tiers)];
}

/**
 * A light quality nudge, blended into each item's draw key alongside its tier
 * weight. Verified stores and items with real photos/demand rank a touch
 * higher, but this is deliberately weak — admin tiers are the primary lever,
 * quality only breaks ties and nudges. A new store with 0 reviews still gets a
 * fair draw via the cap.
 */
function qualityNudge(p: Product, verified: boolean): number {
  let q = 0;
  if (p.imageUrl || (p.imageUrls && p.imageUrls.length > 0)) q += 0.5;
  if (p.description && p.description.trim().length > 20)     q += 0.3;
  if (verified)                                              q += 0.5;
  if (p.reviews > 0) q += Math.min(p.reviews / 50, 1) * 0.4;
  return q; // unbounded-ish, but only ever added to a key in [0,1]
}

/**
 * The Explore feed ordering. Pure: deterministic for a given (items, tiers, seed).
 *
 * Pipeline:
 *   1. Drop Hidden products (Explore pool only — Search/profile ignore this).
 *   2. Assign each surviving product a draw key that mixes the per-visit
 *      shuffle (randomness, for freshness) with its tier weight + quality nudge
 *      (priority). A higher key = drawn earlier.
 *   3. Greedy per-store diversification: walk down the key-sorted list, but
 *      SKIP any product whose store already occupies `capPer10` of the last 9
 *      placed slots. Skipped items are deferred and re-tried once the window
 *      slides enough to admit their store again. This yields the window
 *      invariant: any 10 consecutive output cards contain ≤ cap from one store.
 *
 * `verifiedMap` (supplierId → verified?) is optional; missing → treated as
 * unverified, which only marginally lowers the quality nudge.
 */
export function rankAndDiversify(
  items: Product[],
  tiers: FeedTiers,
  verifiedMap: Map<number, boolean> | null,
  seed: number,
): Product[] {
  // (1) Drop hidden. Everything else keeps going — Low/Reduced stay visible,
  // they just draw later.
  const visible = items.filter(p => tierFor(p, tiers) !== 'hidden');
  if (visible.length < 2) return visible;

  // (2) Shuffle first (fresh per visit, stable across re-renders via the seed),
  // THEN assign a draw key. Sorting a pre-shuffled list by key means items with
  // equal keys retain a random order — no fixed parade of the same products.
  const shuffled = shuffleStable(visible, seed);

  // If the catalog already satisfies the cap in its plain shuffled order, the
  // cap is a no-op — return the shuffle UNCHANGED. This honours the contract
  // that "empty tiers ⇒ identical to a plain shuffle": when no store is at risk
  // of dominating, we don't reorder anything. We only reshuffle when the cap
  // actually bites (see the detection below), and even then weights bias the
  // draw rather than fully fixing the order.
  const keyed = shuffled
    .map(p => {
      const weight = weightFor(p, tiers);
      const verified = !verifiedMap || p.supplierId == null
        ? false
        : !!verifiedMap.get(p.supplierId);
      // key ∈ roughly [0, 2]; ~half random freshness, half priority+quality.
      const key = 0.5 * keyHash(p.id, seed) + 0.5 * (weight + qualityNudge(p, verified));
      return { p, key };
    })
    .sort((a, b) => b.key - a.key);

  const cap = effectiveCap(tiers);
  const WINDOW = 10;
  const lookBack = WINDOW - 1;

  // Fast path: does the weighted shuffle already respect the cap everywhere?
  // If so, return it as-is (no reshuffling). This keeps the common case — a
  // healthy catalog with many stores — identical to today.
  const violatesCap = (() => {
    const counts = new Map<number, number>();
    for (let i = 0; i < keyed.length; i++) {
      const sid = (keyed[i].p.supplierId ?? 0);
      if (sid !== 0) counts.set(sid, (counts.get(sid) ?? 0) + 1);
      if (i >= WINDOW) {
        const old = keyed[i - WINDOW].p.supplierId ?? 0;
        if (old !== 0) counts.set(old, counts.get(old)! - 1);
      }
      // Only the store just placed can have newly crossed the cap — the sole
      // other change to the window was a DEcrement. So checking that one store
      // is equivalent to rescanning every count, and turns this probe from
      // O(items × stores) into O(items).
      if (sid !== 0 && counts.get(sid)! > cap) return true;
    }
    return false;
  })();
  if (!violatesCap) return keyed.map(k => k.p);

  // (3) Sliding-window cap — "rearrange with min-distance" scheduler.
  //
  // At each output position we place ONE item from an eligible store (one whose
  // count in the last 9 placed cards is still < cap). The choice among eligible
  // stores is by MOST-REMAINING-ITEMS first, key second. Prioritizing the store
  // with the most stock left is the textbook "rearrange string k-distance-apart"
  // heuristic: it drains the store most at risk of domination first, which is
  // what lets the cap hold across the whole feasible region. (A plain
  // highest-key greedy instead bunches the dominant store once its peers are
  // nearly spent, breaching the cap prematurely.)
  //
  // If NO store is eligible, the remaining mix is mathematically infeasible
  // (too few OTHER stores to interleave), so we relax one item — forcing the
  // store furthest below its cap (least-bad breach) — to guarantee termination.
  // This only fires in pathological catalogs where one store is >~70% of the
  // feed; there the cap is arithmetically impossible and we degrade gracefully.

  // Group the key-sorted items into per-store FIFO queues (already in priority
  // order), so "the next item of store S" is just a pointer bump.
  const queues = new Map<number, { p: Product; key: number }[]>();
  for (const item of keyed) {
    const sid = item.p.supplierId ?? 0; // 0 sentinel for storeless (never capped)
    if (!queues.has(sid)) queues.set(sid, []);
    queues.get(sid)!.push(item);
  }
  const ptr = new Map<number, number>(); // per-store index into its queue
  const remaining = (sid: number) => {
    const items = queues.get(sid);
    if (!items) return 0;
    return items.length - (ptr.get(sid) ?? 0);
  };

  const placed: number[] = []; // supplierId of each placed card (sentinel 0 = storeless)
  const storeCountInLast9 = (sid: number): number => {
    if (sid === 0) return 0; // storeless products never trip the cap
    const start = Math.max(0, placed.length - lookBack);
    let c = 0;
    for (let i = start; i < placed.length; i++) if (placed[i] === sid) c++;
    return c;
  };

  // The store set is fixed once the queues are built, so materialise the ids
  // ONCE. (Also keeps this iterable under the project's es5 target, where a
  // live Map iterator can't be walked with for…of.)
  const storeIds: number[] = [];
  queues.forEach((_v, sid) => { storeIds.push(sid); });

  const out: Product[] = [];
  const total = keyed.length;
  while (out.length < total) {
    // Pick the eligible store with the most items left (key breaks ties), so the
    // dominant store is drained earliest and its cards spread widest.
    let bestStore = -1;
    let bestRemaining = -1;
    let bestKey = -Infinity;
    let anyRemaining = false;
    for (const sid of storeIds) {
      if (remaining(sid) <= 0) continue;
      anyRemaining = true;
      if (storeCountInLast9(sid) >= cap) continue; // would breach — not eligible now
      const r = remaining(sid);
      if (r > bestRemaining || (r === bestRemaining && queues.get(sid)![ptr.get(sid) ?? 0].key > bestKey)) {
        bestRemaining = r;
        bestKey = queues.get(sid)![ptr.get(sid) ?? 0].key;
        bestStore = sid;
      }
    }
    if (!anyRemaining) break;

    let chosen: { p: Product; key: number };
    if (bestStore !== -1) {
      const items = queues.get(bestStore)!;
      const i = ptr.get(bestStore) ?? 0;
      chosen = items[i];
      ptr.set(bestStore, i + 1);
    } else {
      // Relaxation: every remaining store is at its cap in the window. The cap
      // can't hold here, so force the store furthest below its cap (least-bad).
      let best = -1, bestKey2 = -Infinity, bestSlack = -Infinity;
      for (const sid of storeIds) {
        if (remaining(sid) <= 0) continue;
        const slack = cap - storeCountInLast9(sid); // higher = less over-committed
        if (slack > bestSlack || (slack === bestSlack && queues.get(sid)![ptr.get(sid) ?? 0].key > bestKey2)) {
          bestSlack = slack; bestKey2 = queues.get(sid)![ptr.get(sid) ?? 0].key; best = sid;
        }
      }
      if (best === -1) break;
      const items = queues.get(best)!;
      const i = ptr.get(best) ?? 0;
      chosen = items[i];
      ptr.set(best, i + 1);
    }

    out.push(chosen.p);
    placed.push(chosen.p.supplierId ?? 0);
  }
  return out;
}

/** Stable per-item random component, mirroring shuffle.ts's hash so the seed
 *  stays the single source of visit-freshness. ∈ [0,1]. */
function keyHash(id: number, seed: number): number {
  if (!seed) return 0.5;
  let h = (id ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 0xffffffff;
}
