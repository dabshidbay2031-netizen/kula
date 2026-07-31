/**
 * Admin → Feed Controls and Exports tabs.
 *
 * Both tabs are behind an admin sign-in, so they are the easiest screens in the
 * app to ship broken — nobody stumbles onto them. These render the real
 * AdminDashboard against a stubbed API and assert the controls an operator
 * needs are actually on screen and wired, rather than trusting that it compiles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const toast = vi.fn();
const downloadWithAuth = vi.fn(async (_url: string, _fallbackName: string) => {});

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'boss-uid', displayName: 'Boss' } }),
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ toast }) }));
vi.mock('@/lib/clientAuth', () => ({ authHeaders: async () => ({}) }));
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({ storage: { from: () => ({}) } }) }));
vi.mock('@/lib/downloadFile', () => ({ downloadWithAuth }));

const SUPPLIERS = [
  { id: 1, name: 'Sokow Sambusa', icon: '🥟', verified: true },
  { id: 2, name: 'Hamar Tech',    icon: '💻', verified: false },
];
const PRODUCTS = [
  { id: 11, name: 'Sambusa', sku: 'SB-1', category: 'food',        supplierId: 1, imageUrl: '' },
  { id: 12, name: 'Cable',   sku: 'CB-1', category: 'electronics', supplierId: 2, imageUrl: '' },
];

/** Whatever the dashboard asks for, answered from one place. */
function stubFetch(feedTiers: unknown = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    if (url.includes('/api/admin/check'))         return json({ role: 'admin' });
    if (url.includes('/api/settings/feed-tiers')) return json(feedTiers);
    if (url.includes('/api/suppliers'))           return json(SUPPLIERS);
    if (url.includes('/api/products'))            return json(PRODUCTS);
    return json([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', stubFetch());
});

/** Render the dashboard and click through to a tab. */
async function open(tab: RegExp, feedTiers: unknown = {}) {
  vi.stubGlobal('fetch', stubFetch(feedTiers));
  const AdminDashboard = (await import('@/components/AdminDashboard')).default;
  render(<AdminDashboard />);
  const btn = await screen.findByRole('button', { name: tab });
  await userEvent.click(btn);
  return btn;
}

describe('Feed Controls tab', () => {
  it('shows the store diversity cap with its default', async () => {
    await open(/Feed/);
    expect(await screen.findByText(/Store diversity cap/i)).toBeInTheDocument();
    expect(screen.getByText(/max 3 of every 10/i)).toBeInTheDocument();
  });

  it('states the scope guarantee, so nobody assumes it hides products from search', async () => {
    await open(/Feed/);
    expect(await screen.findByText(/stays searchable/i)).toBeInTheDocument();
    expect(screen.getByText(/Search, store profiles and similar-products/i)).toBeInTheDocument();
  });

  it('lists every store with a tier picker defaulting to Normal', async () => {
    await open(/Feed/);
    expect(await screen.findByText('Sokow Sambusa')).toBeInTheDocument();
    expect(screen.getByText('Hamar Tech')).toBeInTheDocument();
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(2);
    expect((selects[0] as HTMLSelectElement).value).toBe('normal');
  });

  it('offers exactly the four tiers', async () => {
    await open(/Feed/);
    await screen.findByText('Sokow Sambusa');
    const select = screen.getAllByRole('combobox')[0];
    expect(Array.from(select.querySelectorAll('option')).map(o => o.textContent))
      .toEqual(['Normal', 'Reduced', 'Low', 'Hidden']);
  });

  it('switches to categories, showing subcategories nested under their parent', async () => {
    await open(/Feed/);
    await userEvent.click(await screen.findByRole('button', { name: /Categories/ }));
    // The parent row is bold; each child is prefixed with ↳ and indented.
    expect(await screen.findByText('📱 Electronics')).toBeInTheDocument();
    expect(screen.getByText('↳ 📱 Phones')).toBeInTheDocument();
    expect(screen.getByText('↳ 💻 Laptops')).toBeInTheDocument();
  });

  it('product overrides start empty and prompt for a search', async () => {
    await open(/Feed/);
    await userEvent.click(await screen.findByRole('button', { name: /Products \(/ }));
    expect(await screen.findByText(/No product overrides set/i)).toBeInTheDocument();
  });

  it('badges the tab with the number of rules already set', async () => {
    await open(/Feed/, { stores: { '1': 'low' }, subs: { seasonings: 'hidden' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Feed \(2\)/ })).toBeInTheDocument());
  });

  it('saving PUTs the draft, keyed to the store whose row was changed', async () => {
    await open(/Feed/);
    await screen.findByText('Sokow Sambusa');

    // Stores are listed alphabetically, so row 0 is "Hamar Tech" (id 2) — the
    // assertion pins the id to the NAME, not to the array order it was fetched
    // in, which is exactly the mix-up that would tier the wrong shop.
    const row = screen.getByText('Sokow Sambusa').closest('tr')!;
    await userEvent.selectOptions(row.querySelector('select')!, 'low');
    await userEvent.click(screen.getByRole('button', { name: /Save Feed Rules/ }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const put = calls.find(c => String(c[0]).includes('/api/settings/feed-tiers') && c[1]?.method === 'PUT');
      expect(put, 'expected a PUT to /api/settings/feed-tiers').toBeTruthy();
      expect(JSON.parse(put![1].body)).toMatchObject({ stores: { '1': 'low' } });
    });
  });
});

describe('Exports tab', () => {
  it('defaults to every store and offers each period', async () => {
    await open(/Exports/);
    expect(await screen.findByText(/Data Exports/i)).toBeInTheDocument();
    for (const label of ['Today', 'This week', 'This month', 'This year', 'All time', 'Exact dates']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /Download all 2 stores/ })).toBeInTheDocument();
  });

  it('reveals two date inputs only for an exact-date export', async () => {
    await open(/Exports/);
    await screen.findByText(/Data Exports/i);
    expect(screen.queryByLabelText(/From/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Exact dates' }));
    expect(await screen.findByText('From')).toBeInTheDocument();
    expect(screen.getByText('To')).toBeInTheDocument();
  });

  it('refuses an exact-date export with no dates instead of downloading everything', async () => {
    await open(/Exports/);
    await screen.findByText(/Data Exports/i);
    await userEvent.click(screen.getByRole('button', { name: 'Exact dates' }));
    await userEvent.click(screen.getByRole('button', { name: /Download all/ }));
    expect(downloadWithAuth).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/start and an end date/i), 'error');
  });

  it('downloads all stores for the chosen period', async () => {
    await open(/Exports/);
    await screen.findByText(/Data Exports/i);
    await userEvent.click(screen.getByRole('button', { name: 'All time' }));
    await userEvent.click(screen.getByRole('button', { name: /Download all/ }));
    await waitFor(() => expect(downloadWithAuth).toHaveBeenCalled());
    expect(downloadWithAuth.mock.calls[0][0]).toContain('period=all');
    expect(downloadWithAuth.mock.calls[0][0]).not.toContain('storeId');
  });

  it('scopes the download to one store when one is picked', async () => {
    await open(/Exports/);
    await screen.findByText(/Data Exports/i);
    await userEvent.selectOptions(screen.getByRole('combobox'), '2');
    await userEvent.click(screen.getByRole('button', { name: /Download this store/ }));
    await waitFor(() => expect(downloadWithAuth).toHaveBeenCalled());
    expect(downloadWithAuth.mock.calls[0][0]).toContain('storeId=2');
  });
});
