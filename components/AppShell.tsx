'use client';

/**
 * SPA shell — the interactive application.
 *
 * All real navigation happens in the URL hash (e.g. /#/dashboard) via
 * lib/hashRouter; this shell:
 *   1. Serves /auth/callback as a real path (OAuth providers redirect there
 *      with tokens in the URL hash, which the hash router ignores).
 *   2. Redirects legacy deep links (/dashboard?x=1 → /#/dashboard?x=1).
 *   3. Renders the matched hash route client-side after mount — the server
 *      always renders the splash, so hydration can never mismatch.
 */

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { RouterView, usePathname, Link } from '@/lib/hashRouter';
import { ROUTES, NotFound } from '@/views/routes';
import { roleFor, canAccess } from '@/lib/roles';
import { useAuth } from '@/context/AuthContext';
import { useCashier } from '@/context/CashierContext';
import { cashierCanAccess } from '@/lib/cashierPrivileges';
import TrialGate from '@/components/TrialGate';
import ErrorBoundary from '@/components/ErrorBoundary';
/* First URL segments that are real app routes — everything else is treated as
   a clean storefront slug (localhost/storename). Shared with slug validation
   so a store can never register a link that shadows an app route. */
import { RESERVED_ROUTE_SEGMENTS as RESERVED_SEGMENTS } from '@/lib/slug';

const AuthCallbackView = dynamic(() => import('@/views/AuthCallbackView'), { ssr: false });
const RestrictedView   = dynamic(() => import('@/views/RestrictedView'),   { ssr: false });
const StorefrontView   = dynamic(() => import('@/views/SupplierProfileView'), { ssr: false });

function Splash() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '100dvh', gap: 14,
    }}>
      <div style={{ fontSize: '2.5rem' }}>🏪</div>
      <div style={{ fontWeight: 800, fontSize: '1.3rem' }}>Hamar Mall</div>
      <div className="spinner" style={{ width: 26, height: 26 }} />
    </div>
  );
}

/** Blocks business-only routes for guests, customers, and suppliers. */
function GuardedApp() {
  const path = usePathname();
  const { user, accountType, loading } = useAuth();
  const { cashier, cashierLoading } = useCashier();

  // A cashier session, once active, always governs access — even if a
  // business-owner Supabase session is also lingering in this browser.
  // (Otherwise an owner who forgets to log out before handing the device to
  // staff would give that cashier full owner access.)
  if (cashier) {
    if (cashierLoading) return <Splash />;
    if (!cashierCanAccess(path, cashier.privileges)) {
      const firstRoute = cashier.privileges.includes('pos') ? '/pos' : '/';
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60dvh', padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔒</div>
          <div style={{ fontWeight: 700, marginBottom: 8, fontSize: '1.1rem' }}>Access restricted</div>
          <div style={{ color: 'var(--text-light)', marginBottom: 20 }}>
            Your cashier account doesn&apos;t have permission for this page.
          </div>
          <Link href={firstRoute} className="btn btn-primary">
            {cashier.privileges.includes('pos') ? 'Go to POS' : 'Go to Explore'}
          </Link>
        </div>
      );
    }
    return (
      <ErrorBoundary resetKey={path}>
        <RouterView routes={ROUTES} fallback={NotFound} />
      </ErrorBoundary>
    );
  }

  const role = roleFor(!!user, accountType);
  if (!canAccess(role, path)) {
    // Don't flash the lock screen while auth is still restoring a session
    if (loading) return <Splash />;
    return <RestrictedView role={role} />;
  }
  return (
    <ErrorBoundary resetKey={path}>
      <TrialGate>
        <RouterView routes={ROUTES} fallback={NotFound} />
      </TrialGate>
    </ErrorBoundary>
  );
}

export default function AppShell() {
  const [boot, setBoot]           = useState<'pending' | 'app' | 'oauth-callback' | 'storefront'>('pending');
  const [storeSlug, setStoreSlug] = useState('');

  useEffect(() => {
    // React is running — stand the pre-hydration boot watchdog down.
    (window as unknown as { __hmBoot?: () => void }).__hmBoot?.();

    const path = window.location.pathname.replace(/\/+$/, '') || '/';

    if (path === '/auth/callback') {
      // Do NOT touch the URL here — Supabase still needs to consume the
      // #access_token / ?code it appended to this exact address.
      setBoot('oauth-callback');
      return;
    }

    if (path === '/') { setBoot('app'); return; }

    const segs = path.split('/').filter(Boolean);

    // Clean storefront URL: /storename — render the store in place, keep the URL.
    if (segs.length === 1 && !RESERVED_SEGMENTS.has(segs[0].toLowerCase())) {
      setStoreSlug(segs[0].toLowerCase());
      setBoot('storefront');
      return;
    }

    // A real app deep link (e.g. /dashboard, /orders/123): move it into the
    // hash and let the SPA router take over.
    const search = window.location.search;
    window.location.replace(`${window.location.origin}/#${path}${search}`);
  }, []);

  // On a storefront landing, the moment the user navigates anywhere (which sets
  // a #/ hash), hand control to the full hash-routed app so every link works.
  useEffect(() => {
    if (boot !== 'storefront') return;
    const onHash = () => { if (window.location.hash.startsWith('#/')) setBoot('app'); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [boot]);

  if (boot === 'pending')        return <Splash />;
  if (boot === 'oauth-callback') return <AuthCallbackView />;
  if (boot === 'storefront') {
    return (
      <ErrorBoundary resetKey={storeSlug}>
        <StorefrontView slug={storeSlug} />
      </ErrorBoundary>
    );
  }
  return <GuardedApp />;
}
