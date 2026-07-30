/**
 * Account resolution — the path that decides whether someone is a business or
 * a customer.
 *
 * These cover the three ways a Business signup used to silently become a
 * personal account:
 *   1. a slow first lookup finishing AFTER a newer one and overwriting it
 *   2. the email signup flow racing its own store-creation POST
 *   3. a reload showing the business role with no store row behind it
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import type { User as SbUser } from '@supabase/supabase-js';

/* ── Mocks ───────────────────────────────────────────────────── */

const SB_USER = {
  id: 'uid-1',
  email: 'owner@example.com',
  phone: null,
  user_metadata: { full_name: 'Owner' },
} as unknown as SbUser;

let sessionUser: SbUser | null = SB_USER;

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getSession: async () => ({ data: { session: sessionUser ? { user: sessionUser } : null } }),
      getUser:    async () => ({ data: { user: sessionUser } }),
      signOut:    async () => ({ error: null }),
    },
  }),
}));

// Realtime pings would open a live subscription we don't need here.
vi.mock('@/lib/useRealtimePing', () => ({ useRealtimePing: () => {} }));

import { AuthProvider, useAuth, SIGNUP_IN_FLIGHT_KEY } from '@/context/AuthContext';

const STORE = {
  id: 7, name: 'TechVault Store', accountType: 'business', icon: '🏪',
};

/** A promise whose resolution we control from the test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const json = (body: unknown, ok = true) => ({
  ok, status: ok ? 200 : 500,
  json: async () => body,
}) as unknown as Response;

/* A probe component that renders what the app would render from. */
let refresh: () => Promise<void>;
function Probe() {
  const a = useAuth();
  refresh = a.refreshAccount;
  return (
    <div>
      <span data-testid="type">{a.accountType ?? 'none'}</span>
      <span data-testid="store">{a.currentSupplier?.name ?? 'no-store'}</span>
      <span data-testid="resolving">{String(a.accountResolving)}</span>
      <span data-testid="error">{String(a.accountError)}</span>
    </div>
  );
}

beforeEach(() => {
  sessionUser = SB_USER;
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* ══════════════════════════════════════════════════════════════ */

describe('a stale lookup cannot overwrite a newer one', () => {
  it('keeps the business role when the slow first lookup returns "no store" last', async () => {
    const firstLookup = deferred<Response>();
    const calls: string[] = [];

    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
      if (url.startsWith('/api/suppliers')) {
        // First lookup hangs (slow connection); every later one finds the store.
        return calls.filter(c => c.includes('/api/suppliers')).length === 1
          ? firstLookup.promise
          : Promise.resolve(json([STORE]));
      }
      if (url.startsWith('/api/profile')) return Promise.resolve(json({}));
      return Promise.resolve(json(null));
    }));

    render(<AuthProvider><Probe /></AuthProvider>);

    // A newer resolve (what signup does right after creating the store) wins.
    await act(async () => { await refresh(); });
    expect(screen.getByTestId('type')).toHaveTextContent('business');

    // Now the ORIGINAL lookup finally comes back saying "this user has no
    // store". It must be discarded — it is answering a stale question.
    await act(async () => {
      firstLookup.resolve(json([]));
      await firstLookup.promise;
    });

    expect(screen.getByTestId('type')).toHaveTextContent('business');
    expect(screen.getByTestId('store')).toHaveTextContent('TechVault Store');
    // And it must not have created a customer profile on the way out.
    expect(calls).not.toContain('POST /api/profile');
  });
});

describe('signup in flight', () => {
  it('does not auto-create a customer profile while a signup is running', async () => {
    localStorage.setItem(
      SIGNUP_IN_FLIGHT_KEY,
      JSON.stringify({ accountType: 'business', startedAt: Date.now() }),
    );
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
      if (url.startsWith('/api/suppliers')) return Promise.resolve(json([]));   // not created YET
      if (url.startsWith('/api/profile'))   return Promise.resolve(json({}));
      return Promise.resolve(json(null));
    }));

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(calls).toContain('GET /api/profile'));

    expect(calls).not.toContain('POST /api/profile');
    expect(screen.getByTestId('type')).not.toHaveTextContent('user');
  });

  it('ignores an abandoned marker so ordinary new customers still get a profile', async () => {
    localStorage.setItem(
      SIGNUP_IN_FLIGHT_KEY,
      JSON.stringify({ accountType: 'business', startedAt: Date.now() - 60 * 60 * 1000 }),
    );
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
      if (url.startsWith('/api/suppliers')) return Promise.resolve(json([]));
      if (url.startsWith('/api/profile') && init?.method === 'POST') {
        return Promise.resolve(json({ id: 'uid-1', fullName: 'Owner' }));
      }
      if (url.startsWith('/api/profile')) return Promise.resolve(json({}));
      return Promise.resolve(json(null));
    }));

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('type')).toHaveTextContent('user'));
    expect(calls).toContain('POST /api/profile');
    // The stale marker is swept away rather than left to block forever.
    expect(localStorage.getItem(SIGNUP_IN_FLIGHT_KEY)).toBeNull();
  });
});

describe('cached account', () => {
  it('restores the store row on reload, not just the role', async () => {
    localStorage.setItem('mg_c_account', JSON.stringify({
      uid: 'uid-1', accountType: 'business', supplier: STORE,
    }));
    // Lookup never answers — this is the reload-on-a-bad-connection case.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    render(<AuthProvider><Probe /></AuthProvider>);

    // The business page must have real data to render, immediately.
    await waitFor(() => expect(screen.getByTestId('type')).toHaveTextContent('business'));
    expect(screen.getByTestId('store')).toHaveTextContent('TechVault Store');
    expect(screen.getByTestId('resolving')).toHaveTextContent('true');
  });

  it('reports an error once every lookup attempt has failed', async () => {
    vi.useFakeTimers();
    localStorage.setItem('mg_c_account', JSON.stringify({
      uid: 'uid-1', accountType: 'business', supplier: null,
    }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

    render(<AuthProvider><Probe /></AuthProvider>);

    // Three backoff retries (1.2s, 2.4s, 3.6s) then give up.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByTestId('error')).toHaveTextContent('true');
    expect(screen.getByTestId('resolving')).toHaveTextContent('false');
    vi.useRealTimers();
  });
});
