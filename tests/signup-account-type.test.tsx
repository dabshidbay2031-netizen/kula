/**
 * Business signup must never fail silently.
 *
 * The email flow used to fire-and-forget the POST that creates the store row.
 * When it failed, signup carried on as if nothing happened: the user got a
 * login with no store, was resolved as a plain customer, and never saw an
 * error — "I chose Business, got a personal account, and there was no message".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const signUp = vi.fn();
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({ auth: { signUp } }) }));

const refreshAccount = vi.fn(async () => {});
const SIGNUP_IN_FLIGHT_KEY = 'mogarenta_signup_in_flight';
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ refreshAccount }),
  SIGNUP_IN_FLIGHT_KEY: 'mogarenta_signup_in_flight',
}));

const push = vi.fn();
vi.mock('@/lib/hashRouter', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useRouter: () => ({ push }),
}));

import SignupView from '@/views/SignupView';

/** Fill in the Business signup form and submit it. */
async function submitBusinessSignup() {
  const user = userEvent.setup();
  render(<SignupView />);

  await user.click(screen.getByText('Email & Password'));
  await user.click(screen.getByText('Business'));
  await user.click(screen.getByRole('button', { name: /Continue/ }));

  await user.type(screen.getByPlaceholderText('TechVault Store'), 'TechVault Store');
  await user.type(screen.getByPlaceholderText('you@example.com'), 'owner@example.com');
  await user.type(screen.getByPlaceholderText('Min. 6 characters'), 'hunter22');
  await user.type(screen.getByPlaceholderText('Repeat password'), 'hunter22');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: /Create Account/ }));
}

beforeEach(() => {
  localStorage.clear();
  signUp.mockResolvedValue({
    data: { user: { id: 'uid-9' }, session: { access_token: 't' } },
    error: null,
  });
});
afterEach(() => vi.clearAllMocks());

describe('business signup', () => {
  it('shows the server error and does not continue when the store cannot be created', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500,
      json: async () => ({ error: 'duplicate key value violates unique constraint' }),
    })));

    await submitBusinessSignup();

    await waitFor(() => {
      expect(screen.getByText(/couldn't set up your business account/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/duplicate key value/i)).toBeInTheDocument();
    // Crucially: it must NOT sail on to Billing as though the store exists.
    expect(push).not.toHaveBeenCalled();
  });

  it('retries once before giving up, so a single dropped request costs nothing', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) throw new TypeError('Failed to fetch');
      return { ok: true, status: 201, json: async () => ({ id: 7 }) };
    }));

    await submitBusinessSignup();

    await waitFor(() => expect(push).toHaveBeenCalledWith('/billing'));
    expect(calls).toEqual(['/api/suppliers', '/api/suppliers']);
    expect(refreshAccount).toHaveBeenCalled();
  });

  it('marks the signup in flight so account resolution cannot race it, and clears it after', async () => {
    let markerDuringPost: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async () => {
      markerDuringPost = localStorage.getItem(SIGNUP_IN_FLIGHT_KEY);
      return { ok: true, status: 201, json: async () => ({ id: 7 }) };
    }));

    await submitBusinessSignup();

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(markerDuringPost).toBeTruthy();
    expect(JSON.parse(markerDuringPost!).accountType).toBe('business');
    expect(localStorage.getItem(SIGNUP_IN_FLIGHT_KEY)).toBeNull();
  });

  it('posts to /api/suppliers with the chosen account type, not /api/profile', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      bodies.push({ url, body: JSON.parse(init.body as string) });
      return { ok: true, status: 201, json: async () => ({ id: 7 }) };
    }));

    await submitBusinessSignup();

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(bodies).toEqual([{
      url: '/api/suppliers',
      body: { name: 'TechVault Store', authUserId: 'uid-9', accountType: 'business' },
    }]);
  });
});
