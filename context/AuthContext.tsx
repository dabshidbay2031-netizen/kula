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
  /** True while the account type is optimistic (from cache) and not yet
   *  confirmed against the server — views can show a skeleton instead of an
   *  empty business page. */
  accountResolving: boolean;
  /** Set when every lookup attempt failed. The role we're showing came from
   *  cache, so a business page may be missing its store: views surface a
   *  "couldn't load your store — retry" state instead of blank fields. */
  accountError:    boolean;
  updateProfile:   (data: Partial<Pick<UserProfile, 'fullName' | 'phone' | 'avatar' | 'avatarUrl' | 'bio' | 'gender' | 'birthYear'>>) => Promise<void>;
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

/* ── Account cache ───────────────────────────────────────────────────
   Resolving the account needs a network round-trip. We cache the last resolved
   ROW (not just the type) per uid so a reload renders the real store — name,
   logo, location — immediately, then revalidates.

   Caching only the *type* was a bug: a reloading business owner got
   accountType 'business' with `currentSupplier` still null, so the Profile and
   Settings screens rendered the business layout with every field blank ("I see
   no business in my profile settings"), and stayed that way for good if the
   revalidating fetch then failed. */
const ACCOUNT_CACHE = 'mg_c_account';
interface CachedAccount {
  uid:         string;
  accountType: AccountType;
  supplier?:   Supplier | null;
  profile?:    UserProfile | null;
}
function readCachedAccount(): CachedAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_CACHE);
    return raw ? (JSON.parse(raw) as CachedAccount) : null;
  } catch { return null; }
}
function writeCachedAccount(entry: CachedAccount) {
  try { localStorage.setItem(ACCOUNT_CACHE, JSON.stringify(entry)); } catch { /* storage full */ }
}
function clearCachedAccount() {
  try { localStorage.removeItem(ACCOUNT_CACHE); } catch { /* ignore */ }
}

/* Set by BOTH signup flows for as long as the account's store/profile row is
   being created. See signupInFlight(). */
export const SIGNUP_IN_FLIGHT_KEY = 'mogarenta_signup_in_flight';
/** Legacy key, still written by the Google flow so old links keep working. */
const OAUTH_PENDING_KEY = 'mogarenta_pending_oauth';

/**
 * Is a signup still creating its store/profile row right now?
 *
 * True while we're sitting on /auth/callback, or while either signup marker is
 * present. During that window "this user has no store" means "signup hasn't
 * finished POSTing it", so nothing here may conclude they're a customer.
 *
 * The EMAIL flow used to set no marker at all, so the auto-create step below
 * raced it: a brand-new Business signup was frequently stamped as a plain
 * customer profile before its store row existed. That is the "I chose Business
 * but got a personal account, with no error" report.
 */
function signupInFlight(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.pathname.startsWith('/auth/callback')) return true;
  try {
    return isFreshMarker(localStorage.getItem(SIGNUP_IN_FLIGHT_KEY), SIGNUP_IN_FLIGHT_KEY)
        || isFreshMarker(localStorage.getItem(OAUTH_PENDING_KEY),   OAUTH_PENDING_KEY);
  } catch { return false; }
}

/** How long a signup marker may block the auto-create step. Long enough for a
 *  slow round trip to Google, short enough that an ABANDONED signup (tab closed
 *  mid-flow) can't leave this browser permanently unable to create a profile. */
const SIGNUP_MARKER_TTL_MS = 10 * 60 * 1000;

/** True while the marker exists and is recent; a stale one is swept away. */
function isFreshMarker(raw: string | null, key: string): boolean {
  if (raw == null) return false;
  // Markers carry `startedAt` (ms). Anything without one predates this change
  // — honour it once, then let the TTL apply on the next write.
  let startedAt = 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'number') startedAt = parsed;
    else if (parsed && typeof parsed === 'object') {
      startedAt = Number((parsed as { startedAt?: number }).startedAt) || 0;
    }
  } catch { /* plain string — no timestamp */ }

  if (startedAt && Date.now() - startedAt > SIGNUP_MARKER_TTL_MS) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return false;
  }
  return true;
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
  // The role on screen is optimistic (cache) until a lookup confirms it.
  const [accountResolving, setAccountResolving] = useState(false);
  const [accountError,     setAccountError]     = useState(false);
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
  // Monotonic token for resolve attempts. Every await inside resolveAccount is
  // a window in which a NEWER resolve (refreshAccount right after signup, a new
  // auth event) can start and finish first. Without this, the older attempt
  // came back later and overwrote the newer, correct answer — which is how a
  // just-created business ended up displayed as a customer. An attempt only
  // writes state while it is still the newest one.
  const resolveGen      = useRef(0);
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
  async function resolveAccount(uid: string, sbUser?: SbUser, attempt = 0, gen?: number) {
    // Skip when we already have a DEFINITIVE resolution for this uid (a prior
    // call — or a parallel auth event — already settled it). `refreshAccount`
    // clears lastResolvedUid to force a fresh read past this guard.
    if (lastResolvedUid.current === uid && accountTypeRef.current) return;

    // Retries stay on the generation they were scheduled with; a fresh call
    // claims a new one and thereby invalidates everything older.
    const myGen = gen ?? ++resolveGen.current;
    /** Has a newer resolve (or a different user) superseded this attempt? */
    const superseded = () => resolveGen.current !== myGen || activeUidRef.current !== uid;

    setAccountResolving(true);

    /** Commit a definitive answer — but only if we're still the newest attempt. */
    const settle = (t: AccountType, supplier: Supplier | null, profile: UserProfile | null) => {
      if (superseded()) return true;          // newer answer already on screen; we're done
      setCurrentSupplier(supplier);
      setCurrentProfile(profile);
      applyAccountType(t);
      writeCachedAccount({ uid, accountType: t, supplier, profile });
      lastResolvedUid.current = uid;
      cancelResolveRetry();
      setAccountResolving(false);
      setAccountError(false);
      return true;
    };

    // ── 1) Supplier lookup — authoritative for business / supplier / agent ──
    let supplierConclusive = false; // 200 response we can trust (row or empty)
    try {
      const res = await fetch(`/api/suppliers?authUserId=${encodeURIComponent(uid)}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const sup  = Array.isArray(data) ? (data[0] as Supplier | undefined) ?? null : null;
        if (sup) {
          const t: AccountType = sup.accountType === 'supplier' ? 'supplier'
                               : sup.accountType === 'agent'    ? 'agent'
                               :                                  'business';
          settle(t, sup, null);
          return;
        }
        supplierConclusive = true;            // 200 + no row ⇒ genuinely not a store
      }
      // non-2xx ⇒ inconclusive; fall through to the retry path below
    } catch { /* network / timeout ⇒ inconclusive */ }

    if (superseded()) return;

    // ── 2) Profile lookup — only meaningful once we KNOW there's no store row ──
    if (supplierConclusive) {
      let profileConclusive = false;
      try {
        const res = await fetch(`/api/profile?userId=${encodeURIComponent(uid)}`, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data?.id) {
            settle('user', null, data as UserProfile);
            return;
          }
          profileConclusive = true;           // 200 + no row ⇒ brand-new user
        }
      } catch { /* inconclusive */ }

      if (superseded()) return;

      // ── 3) Genuinely new account (no store, no profile) — create a customer
      //    profile so signup lands somewhere. Reached ONLY when BOTH lookups
      //    returned a conclusive "nothing", so a blip can never trigger it. ──
      //
      //    NOT while a signup is still in flight: the signup screen (email) or
      //    the callback view (Google) is POSTing the store row this very
      //    moment, so "no store" means "not yet", not "customer". Racing it
      //    here is what turned sign-ups that chose Business into customers.
      if (profileConclusive && sbUser && !signupInFlight()) {
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
            settle('user', null, profile as UserProfile);
            return;
          }
        } catch { /* fall through to retry */ }
      }
    }

    if (superseded()) return;

    // ── Inconclusive: a lookup failed. Keep the current role (never downgrade)
    //    and retry a few times so a momentary blip can't flip the profile. We
    //    deliberately DON'T set lastResolvedUid, so a later auth event resolves
    //    too. ──
    cancelResolveRetry();
    if (attempt < 3) {
      resolveTimer.current = setTimeout(() => {
        if (!superseded()) resolveAccount(uid, sbUser, attempt + 1, myGen);
      }, 1200 * (attempt + 1));
      return;
    }

    // Out of retries. The role on screen (if any) came from cache and may be
    // missing its store row — say so instead of rendering blank fields.
    setAccountResolving(false);
    setAccountError(true);
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
      // Optimistic role AND row from the last resolved value for this uid → nav
      // and role-gated views render the right audience *with real data* at once,
      // then resolveAccount confirms/corrects it. Only when we don't already
      // have a type.
      if (!accountTypeRef.current) {
        const cached = readCachedAccount();
        if (cached && cached.uid === effective.id) {
          applyAccountType(cached.accountType);
          // Hydrating the row is what keeps a reloading business owner from
          // seeing their own profile page with every field empty.
          if (cached.supplier) setCurrentSupplier(cached.supplier);
          if (cached.profile)  setCurrentProfile(cached.profile);
        }
      }
      resolveAccount(effective.id, sbUser ?? undefined);
    } else {
      lastResolvedUid.current = null;
      setCurrentSupplier(null);
      setCurrentProfile(null);
      applyAccountType(null);
      setAccountResolving(false);
      setAccountError(false);
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
    resolveGen.current++;           // abandon any in-flight resolve
    lastResolvedUid.current = null;
    activeUidRef.current    = null;
    setActingStore(null);
    setUser(null); setCurrentSupplier(null); setCurrentProfile(null); applyAccountType(null);
    setAccountResolving(false); setAccountError(false);
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
    cancelResolveRetry();
    // Read the session from Supabase rather than this component's `user`
    // state. Signup calls refreshAccount the instant the store row is created,
    // and at that point the auth event hasn't re-rendered the provider yet —
    // so `user` is still null and an `if (!user) return` guard made the call a
    // no-op. The account then stayed 'customer' and the new seller saw the
    // shopper nav until they manually reloaded the page.
    const { data: { user: sbUser } } = await getSupabase().auth.getUser();
    if (!sbUser) return;
    activeUidRef.current   = sbUser.id;
    lastResolvedUid.current = null;   // force a re-resolve
    setAccountError(false);
    await resolveAccount(sbUser.id, sbUser);
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
  const updateProfile = async (updates: Partial<Pick<UserProfile, 'fullName' | 'phone' | 'avatar' | 'avatarUrl' | 'bio' | 'gender' | 'birthYear'>>) => {
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
      accountResolving, accountError,
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
