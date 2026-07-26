'use client';

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { User as SbUser } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';
import { useRealtimePing } from '@/lib/useRealtimePing';
import type { Supplier, UserProfile, AccountType } from '@/lib/types';

/* ── Unified user shape ──────────────────────────────────────────── */
export interface AuthUser {
  id:           string;
  uid:          string;
  phoneNumber:  string | null;
  displayName:  string | null;
  email:        string | null;
  authProvider: 'supabase';
}

interface AuthContextValue {
  user:            AuthUser | null;
  loading:         boolean;
  accountType:     AccountType | null;
  currentSupplier: Supplier | null;
  currentProfile:  UserProfile | null;
  signOut:         () => Promise<void>;
  refreshAccount:  () => Promise<void>;
  updateProfile:   (data: Partial<Pick<UserProfile, 'fullName' | 'phone' | 'avatar' | 'avatarUrl' | 'bio'>>) => Promise<void>;
  /* ── Field-agent "acting as store" ──────────────────────────────
     When a field agent is setting up a store they registered, they select it
     here. While set, `currentSupplier` + `accountType` reflect that STORE, so
     the whole business UI (profile edit, inventory, POS) scopes to it — the
     server still authorizes every write via agentManagesStore. `agentSelf` is
     the agent's OWN store row, kept so the agent dashboard still works. */
  actingStore:     Supplier | null;
  setActingStore:  (s: Supplier | null) => void;
  agentSelf:       Supplier | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/* ── Account-type cache ──────────────────────────────────────────────
   Resolving the account type needs a network round-trip. Caching the last
   resolved type per uid lets a refresh render the correct audience (business
   vs customer nav, dashboards) *immediately* instead of flashing the default
   'customer' role for a second while the fetch runs. */
const ACCOUNT_CACHE = 'mg_c_account';
function readCachedAccount(): { uid: string; accountType: AccountType } | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_CACHE);
    return raw ? (JSON.parse(raw) as { uid: string; accountType: AccountType }) : null;
  } catch { return null; }
}
function writeCachedAccount(uid: string, accountType: AccountType) {
  try { localStorage.setItem(ACCOUNT_CACHE, JSON.stringify({ uid, accountType })); } catch { /* storage full */ }
}
function clearCachedAccount() {
  try { localStorage.removeItem(ACCOUNT_CACHE); } catch { /* ignore */ }
}

/**
 * Is an OAuth signup still creating its store/profile right now?
 *
 * True while we're sitting on /auth/callback, or while a pending-signup marker
 * is present. During that window "this user has no store" means "the callback
 * hasn't finished POSTing it", so nothing here may conclude they're a customer.
 */
function oauthSignupInFlight(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.pathname.startsWith('/auth/callback')) return true;
  try { return localStorage.getItem('mogarenta_pending_oauth') != null; } catch { return false; }
}

/* ── Mapper ──────────────────────────────────────────────────────── */
function toSupabaseUser(sb: SbUser): AuthUser {
  return {
    id: sb.id, uid: sb.id,
    phoneNumber: sb.phone ?? null,
    displayName: (sb.user_metadata?.full_name as string | undefined) ?? sb.email ?? null,
    email: sb.email ?? null,
    authProvider: 'supabase',
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,            setUser]            = useState<AuthUser | null>(null);
  const [currentSupplier, setCurrentSupplier] = useState<Supplier | null>(null);
  const [currentProfile,  setCurrentProfile]  = useState<UserProfile | null>(null);
  const [accountType,     setAccountType]     = useState<AccountType | null>(null);
  const [loading,         setLoading]         = useState(true);
  const [configError,     setConfigError]     = useState<string | null>(null);
  // A field agent's currently-selected store to set up (in-memory; a reload
  // drops back to the agent's own dashboard, which is fine).
  const [actingStore,     setActingStore]     = useState<Supplier | null>(null);

  const lastResolvedUid = useRef<string | null>(null);
  // Ref mirror of accountType: the auth listener is registered once with
  // [] deps, so reading the STATE here would always see the first render's
  // null (stale closure) and the early-exit below could never fire.
  const accountTypeRef  = useRef<AccountType | null>(null);
  // The uid we currently consider "active" — a queued retry aborts if the
  // signed-in user has changed since it was scheduled.
  const activeUidRef    = useRef<string | null>(null);
  // Pending retry timer for an inconclusive (network-failed) resolve.
  const resolveTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelResolveRetry() {
    if (resolveTimer.current) { clearTimeout(resolveTimer.current); resolveTimer.current = null; }
  }

  /** Keep the state and the ref in lockstep */
  function applyAccountType(t: AccountType | null) {
    accountTypeRef.current = t;
    setAccountType(t);
  }

  /* ── Look up Supabase profile / supplier by UID ──────────────────
     The store's `suppliers` row is the AUTHORITATIVE source of the account
     type: editing `suppliers.account_type` in Supabase (business/supplier/
     agent) must flip the profile the user sees on the next load. So we always
     re-read it fresh (`no-store`) and map it directly.

     The golden rule here is DON'T DOWNGRADE ON A NETWORK BLIP. A failed
     (timeout / 5xx / offline) supplier lookup used to fall through and
     auto-create a *customer* profile — permanently turning a business into a
     'user' and making the role flip-flop between reloads. We now only ever
     change the role from a CONCLUSIVE answer (an HTTP-200 body); an
     inconclusive lookup keeps the current role and schedules a retry. */
  async function resolveAccount(uid: string, sbUser?: SbUser, attempt = 0) {
    // Skip when we already have a DEFINITIVE resolution for this uid (a prior
    // call — or a parallel auth event — already settled it). `refreshAccount`
    // clears lastResolvedUid to force a fresh read past this guard.
    if (lastResolvedUid.current === uid && accountTypeRef.current) return;

    // ── 1) Supplier lookup — authoritative for business / supplier / agent ──
    let supplierConclusive = false; // 200 response we can trust (row or empty)
    try {
      const res = await fetch(`/api/suppliers?authUserId=${encodeURIComponent(uid)}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const sup  = Array.isArray(data) ? data[0] ?? null : null;
        if (sup) {
          const t: AccountType = sup.accountType === 'supplier' ? 'supplier'
                               : sup.accountType === 'agent'    ? 'agent'
                               :                                  'business';
          setCurrentSupplier(sup);
          setCurrentProfile(null);
          applyAccountType(t);
          writeCachedAccount(uid, t);
          lastResolvedUid.current = uid;      // definitive
          cancelResolveRetry();
          return;
        }
        supplierConclusive = true;            // 200 + no row ⇒ genuinely not a store
      }
      // non-2xx ⇒ inconclusive; fall through to the retry path below
    } catch { /* network / timeout ⇒ inconclusive */ }

    // ── 2) Profile lookup — only meaningful once we KNOW there's no store row ──
    if (supplierConclusive) {
      let profileConclusive = false;
      try {
        const res = await fetch(`/api/profile?userId=${encodeURIComponent(uid)}`, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data?.id) {
            setCurrentProfile(data);
            setCurrentSupplier(null);
            applyAccountType('user');
            writeCachedAccount(uid, 'user');
            lastResolvedUid.current = uid;    // definitive
            cancelResolveRetry();
            return;
          }
          profileConclusive = true;           // 200 + no row ⇒ brand-new user
        }
      } catch { /* inconclusive */ }

      // ── 3) Genuinely new account (no store, no profile) — create a customer
      //    profile so signup lands somewhere. Reached ONLY when BOTH lookups
      //    returned a conclusive "nothing", so a blip can never trigger it. ──
      //
      //    NOT while an OAuth signup is still in flight: on /auth/callback the
      //    callback view is creating the store this very moment, so "no store"
      //    means "not yet", not "customer". Racing it here is what turned
      //    Google sign-ups that chose Business into customer accounts.
      if (profileConclusive && sbUser && !oauthSignupInFlight()) {
        try {
          const res = await fetch('/api/profile', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id:       uid,
              fullName: (sbUser.user_metadata?.full_name as string | undefined) ?? sbUser.email ?? '',
              phone:    sbUser.phone ?? '',
              avatar:   '👤',
            }),
          });
          if (res.ok) {
            const profile = await res.json();
            setCurrentProfile(profile);
            setCurrentSupplier(null);
            applyAccountType('user');
            writeCachedAccount(uid, 'user');
            lastResolvedUid.current = uid;    // definitive
            cancelResolveRetry();
            return;
          }
        } catch { /* fall through to retry */ }
      }
    }

    // ── Inconclusive: a lookup failed. Keep the current role (never downgrade)
    //    and retry a few times so a momentary blip can't flip the profile. We
    //    deliberately DON'T set lastResolvedUid, so a later auth event resolves
    //    too. ──
    cancelResolveRetry();
    if (attempt < 3 && activeUidRef.current === uid) {
      resolveTimer.current = setTimeout(() => {
        if (activeUidRef.current === uid) resolveAccount(uid, sbUser, attempt + 1);
      }, 1200 * (attempt + 1));
    }
  }

  /* ── Apply the current Supabase session ───────────────────────── */
  function applySession(sbUser: SbUser | null) {
    const effective = sbUser ? toSupabaseUser(sbUser) : null;

    // A different (or absent) user invalidates any in-flight resolve retry and
    // the last-resolved marker — otherwise a queued retry for the old uid could
    // stamp the wrong role onto the new session.
    if (activeUidRef.current !== (effective?.id ?? null)) {
      cancelResolveRetry();
      lastResolvedUid.current = null;
      setActingStore(null); // never carry an agent's acting-store across accounts
    }
    activeUidRef.current = effective?.id ?? null;

    setUser(prev => {
      // Avoid needless re-renders / re-resolves when nothing changed
      if (prev?.id === effective?.id) return prev;
      return effective;
    });

    if (effective) {
      // Optimistic role from the last resolved value for this uid → nav and
      // role-gated views render the right audience at once, then resolveAccount
      // confirms/corrects it. Only when we don't already have a type.
      if (!accountTypeRef.current) {
        const cached = readCachedAccount();
        if (cached && cached.uid === effective.id) applyAccountType(cached.accountType);
      }
      resolveAccount(effective.id, sbUser ?? undefined);
    } else {
      lastResolvedUid.current = null;
      setCurrentSupplier(null);
      setCurrentProfile(null);
      applyAccountType(null);
      clearCachedAccount();
    }
    setLoading(false);
  }

  /* ── Auth listener ───────────────────────────────────────────── */
  useEffect(() => {
    let sb: ReturnType<typeof getSupabase>;
    try {
      sb = getSupabase();
    } catch (e) {
      // Deployment misconfiguration (NEXT_PUBLIC_SUPABASE_* not set at build
      // time). Without this guard the throw unmounts the entire app into the
      // generic global-error screen; show an actionable message instead.
      console.error('[Auth] Supabase client init failed:', e);
      setConfigError(e instanceof Error ? e.message : String(e));
      setLoading(false);
      return;
    }

    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, session) => {
      applySession(session?.user ?? null);
    });

    // Belt-and-suspenders: proactively read the persisted session on mount.
    // onAuthStateChange fires INITIAL_SESSION for this, but on a slow/flaky
    // network that event can lag — reading it directly guarantees a freshly
    // reloaded (or just-logged-in) user resolves instead of getting stranded on
    // the "Sign in required" screen. applySession de-dupes by uid, so this is
    // harmless if the event already fired.
    sb.auth.getSession()
      .then(({ data }) => applySession(data.session?.user ?? null))
      .catch(() => setLoading(false));

    // Safety: never let the UI hang on loading more than 8s
    const timeout = setTimeout(() => setLoading(false), 8000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
      cancelResolveRetry();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Sign out ────────────────────────────────────────────────── */
  const signOut = async () => {
    // Clear local state immediately so the UI reflects the sign-out at once
    cancelResolveRetry();
    lastResolvedUid.current = null;
    activeUidRef.current    = null;
    setActingStore(null);
    setUser(null); setCurrentSupplier(null); setCurrentProfile(null); applyAccountType(null);
    clearCachedAccount();
    try {
      await getSupabase().auth.signOut();
    } catch (e) {
      // The local session is cleared, but the provider session may survive
      // a refresh — surface it instead of hiding it.
      console.error('[Auth] sign-out failed; session may persist after refresh:', e);
    }
  };

  /* ── Refresh account data ────────────────────────────────────── */
  const refreshAccount = async () => {
    if (!user) return;
    cancelResolveRetry();
    lastResolvedUid.current = null; // force re-resolve
    const { data: { user: sbUser } } = await getSupabase().auth.getUser();
    await resolveAccount(user.id, sbUser ?? undefined);
  };

  /* Someone changed THIS store's row server-side (an admin ticking ✓ Verified,
     an approval decision…). Re-read it so the badge appears and the "Request
     Verification" button disappears without the owner reloading the app.
     Scoped to this one store's topic, so ordinary catalog edits don't
     re-resolve the account. */
  useRealtimePing(
    [currentSupplier ? `store:${currentSupplier.id}` : null],
    () => { refreshAccount().catch(() => { /* best-effort */ }); },
  );

  /* ── Update profile ──────────────────────────────────────────── */
  const updateProfile = async (updates: Partial<Pick<UserProfile, 'fullName' | 'phone' | 'avatar' | 'avatarUrl' | 'bio'>>) => {
    if (!user) return;
    if (!currentProfile) {
      const res = await fetch('/api/profile', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          id: user.id, fullName: updates.fullName ?? '',
          phone: updates.phone ?? user.phoneNumber ?? '', avatar: updates.avatar ?? '👤',
        }),
      });
      if (res.ok) setCurrentProfile(await res.json());
      else throw new Error('Profile create failed');
      return;
    }
    const res = await fetch(`/api/profile/${user.id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(updates),
    });
    if (res.ok) setCurrentProfile(await res.json());
    else throw new Error('Profile update failed');
  };

  if (configError) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', minHeight: '100dvh', gap: 14, padding: 24, textAlign: 'center',
      }}>
        <div style={{ fontSize: '2.5rem' }}>⚙️</div>
        <div style={{ fontWeight: 800, fontSize: '1.3rem' }}>Setup required</div>
        <div style={{ color: 'var(--text-light, #64748b)', maxWidth: 420 }}>
          The app isn&apos;t configured yet. Add the Supabase environment variables to the
          deployment and redeploy.
        </div>
        <code style={{
          fontSize: '0.8rem', background: 'rgba(100,116,139,0.12)', padding: '8px 12px',
          borderRadius: 8, maxWidth: 420, wordBreak: 'break-word',
        }}>
          {configError}
        </code>
      </div>
    );
  }

  // While a field agent is acting on a store they registered, the whole app
  // sees that STORE as the current supplier (business experience). Otherwise the
  // real resolved values pass through unchanged.
  const effectiveSupplier   = actingStore ?? currentSupplier;
  const effectiveAccountType: AccountType | null =
    actingStore ? ((actingStore.accountType as AccountType | undefined) ?? 'business') : accountType;
  const agentSelf = accountType === 'agent' ? currentSupplier : null;

  return (
    <AuthContext.Provider value={{
      user, loading,
      accountType:     effectiveAccountType,
      currentSupplier: effectiveSupplier,
      currentProfile,
      signOut, refreshAccount, updateProfile,
      actingStore, setActingStore, agentSelf,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
