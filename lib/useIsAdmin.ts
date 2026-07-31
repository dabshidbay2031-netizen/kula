'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { authHeaders } from '@/lib/clientAuth';

export type AdminRole = 'admin' | 'semi_admin' | null;

/**
 * Resolve whether the signed-in user is a platform admin.
 *
 * Admin status lives in the `admins` table, separate from the account type
 * (business / supplier / customer). It's resolved asynchronously via
 * /api/admin/check, so callers get a `loading` flag to avoid flashing
 * gated content before the answer arrives.
 *
 * Used to gate the GLOBAL (all-businesses) dashboard, which non-admin
 * businesses must not see — they get their own scoped dashboard instead.
 */
export function useIsAdmin(): { role: AdminRole; isAdmin: boolean; loading: boolean } {
  const { user } = useAuth();
  const [role, setRole]       = useState<AdminRole>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) { setRole(null); setLoading(false); return; }
    setLoading(true);
    // Identity comes from the JWT, not from a uid in the query string — the
    // route deliberately refuses to answer about anyone but the caller.
    (async () => {
      try {
        const r = await fetch('/api/admin/check', { headers: await authHeaders() });
        const d = await r.json();
        if (!cancelled) setRole((d?.role as AdminRole) ?? null);
      } catch {
        if (!cancelled) setRole(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  return { role, isAdmin: role === 'admin' || role === 'semi_admin', loading };
}
