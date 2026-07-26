'use client';

import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

/**
 * OAuth lands on the REAL path /auth/callback (with provider tokens in the
 * URL hash), so leaving must replace the whole URL — a hash-only push would
 * keep the /auth/callback pathname and the shell would re-render this view.
 */
function leaveTo(hashPath: string) {
  window.location.replace(`${window.location.origin}/#${hashPath}`);
}

/**
 * OAuth callback handler.
 * After Google redirects back here, Supabase JS automatically detects
 * the session from the URL hash/code. We then:
 *  1. Wait for the session to be established
 *  2. Create the Supabase supplier / profile record if it's a new signup
 *  3. Redirect to /profile
 */
export default function AuthCallbackPage() {
  const [status, setStatus] = useState('Completing sign-in…');

  useEffect(() => {
    // A password-reset link lands here as `#…&type=recovery`. Capture it before
    // the Supabase client consumes the hash, so we can route to the
    // set-new-password screen instead of straight into the app.
    const isRecovery = typeof window !== 'undefined' && /[#&?]type=recovery(&|$)/.test(window.location.hash);

    const handle = async () => {
      // Poll for the session — Supabase client auto-processes the URL
      let session = null;
      for (let i = 0; i < 10; i++) {
        const { data } = await getSupabase().auth.getSession();
        if (data.session) { session = data.session; break; }
        await new Promise(r => setTimeout(r, 400));
      }

      if (!session) {
        setStatus('Sign-in failed. Redirecting…');
        setTimeout(() => leaveTo('/auth/login'), 2000);
        return;
      }

      // Password recovery → let the user set a new password.
      if (isRecovery) {
        setStatus('Opening password reset…');
        leaveTo('/auth/reset');
        return;
      }

      const uid = session.user.id;

      /* ── Handle pending OAuth signup ─────────────────────────────
         The account type comes from the RETURN URL first: it is the only
         copy guaranteed to survive the trip to Google (localStorage is lost
         whenever the callback lands on a different origin than the signup
         page, which silently turned "Business" into a customer account).
         localStorage stays as a fallback for links made before this change. */
      const qs        = new URLSearchParams(window.location.search);
      const urlType   = qs.get('type');
      const urlName   = qs.get('name');
      let accountType = urlType as 'user' | 'business' | 'supplier' | 'agent' | null;
      let name        = urlName ?? '';
      let gender      = qs.get('gender') ?? '';
      let birthYear   = qs.get('birthYear') ?? '';

      if (!accountType) {
        try {
          const raw = localStorage.getItem('mogarenta_pending_oauth');
          if (raw) {
            const p = JSON.parse(raw) as {
              accountType?: typeof accountType; name?: string;
              gender?: string; birthYear?: string;
            };
            accountType = p.accountType ?? null;
            name        = p.name ?? '';
            gender      = p.gender ?? '';
            birthYear   = p.birthYear ?? '';
          }
        } catch { /* malformed — treat as no pending signup */ }
      }

      if (accountType) {
        localStorage.removeItem('mogarenta_pending_oauth');
        setStatus('Setting up your account…');

        const isSeller = accountType === 'business' || accountType === 'supplier' || accountType === 'agent';
        const req: [string, Record<string, unknown>] = isSeller
          ? ['/api/suppliers', { name: name || 'My Business', authUserId: uid, accountType }]
          : ['/api/profile', {
              id:       uid,
              fullName: name || (session.user.user_metadata?.full_name as string | undefined) || '',
              phone:    session.user.phone ?? '',
              avatar:   '👤',
              // Optional demographics carried through the OAuth round trip.
              gender,
              birthYear: birthYear ? Number(birthYear) : null,
            }];

        // A failure here used to be swallowed, leaving the user with a Google
        // login and no store — which AuthContext then "helpfully" turned into a
        // customer account. Check the response and retry once before giving up.
        let created = false;
        for (let attempt = 0; attempt < 2 && !created; attempt++) {
          try {
            const res = await fetch(req[0], {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify(req[1]),
            });
            created = res.ok;
          } catch { /* network — retry below */ }
          if (!created && attempt === 0) await new Promise(r => setTimeout(r, 800));
        }

        // While the record above was being created, AuthContext may have
        // already resolved (and cached) this brand-new user as a plain
        // customer. Drop that cache so the next page load resolves the real
        // account type instead of flashing/sticking on the customer UI.
        try { localStorage.removeItem('mg_c_account'); } catch { /* ignore */ }

        if (!created) {
          setStatus('We could not finish setting up your store. Taking you to your profile…');
          setTimeout(() => leaveTo('/profile?setup=failed'), 2500);
          return;
        }

        // A new seller's next step is paying for the store, so land them on
        // Billing rather than a profile page they have no reason to visit yet.
        if (isSeller && accountType !== 'agent') { leaveTo('/billing'); return; }
      }

      leaveTo('/profile');
    };

    handle();
  }, []);

  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      minHeight:      '100dvh',
      gap:            16,
      background:     'var(--bg)',
    }}>
      <div style={{ fontSize: '2.5rem' }}>🏪</div>
      <div style={{ fontWeight: 800, fontSize: '1.3rem', color: 'var(--text)' }}>Hamar Mall</div>
      <div style={{ color: 'var(--text-muted)', fontSize: '.9rem' }}>{status}</div>
      <div className="spinner" style={{ width: 28, height: 28, marginTop: 8 }} />
    </div>
  );
}
