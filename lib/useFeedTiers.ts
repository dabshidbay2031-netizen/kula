'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRealtimePing } from '@/lib/useRealtimePing';
import { EMPTY_TIERS, sanitizeTiers, type FeedTiers } from '@/lib/feedTiers';

const CACHE_KEY = 'mg_c_feed_tiers';

function readCached(): FeedTiers | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? sanitizeTiers(JSON.parse(raw)) : null;
  } catch { return null; }
}

/**
 * Read-only hook for the Explore grid: the admin-configured feed tiers.
 *
 * Starts from the last config THIS browser saw (cached) rather than empty, so a
 * refresh doesn't briefly render the *unweighted* grid — which would flash
 * hidden products into view before the fetch resolves — then revalidates.
 *
 * Any failure resolves to EMPTY_TIERS, and empty tiers mean "rank exactly as
 * before": the feed degrades to a plain shuffle rather than breaking.
 */
export function useFeedTiers(): FeedTiers {
  const [tiers, setTiers] = useState<FeedTiers>(EMPTY_TIERS);

  // Swap in the cached config as early as possible (before the fetch resolves).
  useEffect(() => { const c = readCached(); if (c) setTiers(c); }, []);

  const load = useCallback(() => {
    fetch('/api/settings/feed-tiers')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return;
        const clean = sanitizeTiers(d);
        setTiers(clean);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(clean)); } catch { /* storage full */ }
      })
      .catch(() => { /* keep last-known / empty */ });
  }, []);

  useEffect(() => { load(); }, [load]);
  // Admin saved new tiers → every open Explore page re-sorts live.
  useRealtimePing(['settings'], load);

  return tiers;
}
