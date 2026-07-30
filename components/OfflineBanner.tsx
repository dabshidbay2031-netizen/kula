'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Thin fixed banner shown whenever the app can't reach the server, so a failed
 * action reads as "you're offline" instead of "the app is broken".
 *
 * It used to trust `navigator.onLine` alone. That flag only reports whether the
 * device has *a network interface* — on Android it stays `true` on a dead
 * mobile-data connection, on a Wi-Fi network with no upstream, and behind a
 * captive portal. So the exact situations users hit in the field were the ones
 * it stayed silent for. `false` is still trustworthy (definitely offline), so
 * we short-circuit on it and otherwise verify with a real request.
 */

/** How often to re-check while everything looks fine. */
const PROBE_INTERVAL_MS = 45_000;
/** Faster re-checks once we believe we're down, so recovery feels immediate. */
const RECHECK_INTERVAL_MS = 8_000;
/** A probe slower than this counts as unreachable. */
const PROBE_TIMEOUT_MS = 6_000;

export default function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  // One bad request is a blip; two in a row is a connection problem. Requiring
  // two keeps the banner from flickering on every transient hiccup.
  const failures = useRef(0);

  const probe = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      failures.current = 2;
      setOffline(true);
      return;
    }
    try {
      const res = await fetch('/api/health', {
        method: 'GET',
        cache:  'no-store',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // Any answer at all — even a 500 — proves the network path works.
      if (res) { failures.current = 0; setOffline(false); return; }
    } catch { /* timeout, DNS failure, no route */ }
    failures.current += 1;
    if (failures.current >= 2) setOffline(true);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(run, offline ? RECHECK_INTERVAL_MS : PROBE_INTERVAL_MS);
    };
    const run = async () => {
      // Don't burn a background tab's data/battery on probes nobody will see.
      if (document.visibilityState === 'visible') await probe();
      schedule();
    };

    // Immediate reactions to the browser's own signals, then verify.
    const onOffline = () => { failures.current = 2; setOffline(true); };
    const onOnline  = () => { failures.current = 0; probe(); };
    const onVisible = () => { if (document.visibilityState === 'visible') probe(); };

    window.addEventListener('offline', onOffline);
    window.addEventListener('online',  onOnline);
    document.addEventListener('visibilitychange', onVisible);

    run();

    return () => {
      clearTimeout(timer);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online',  onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [probe, offline]);

  if (!offline) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
        background: '#dc2626', color: '#fff',
        textAlign: 'center', padding: '6px 12px',
        paddingTop: 'calc(6px + env(safe-area-inset-top))',
        fontSize: '.82rem', fontWeight: 600,
        boxShadow: '0 1px 4px rgba(0,0,0,.2)',
      }}
    >
      ⚠️ No internet connection — changes won&apos;t save until you reconnect.
    </div>
  );
}
