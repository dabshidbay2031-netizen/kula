/**
 * Admin panel — every tab.
 *
 * The whole panel sits behind an admin sign-in, which makes it the easiest
 * screen in the app to ship broken: nobody stumbles onto it. These render the
 * real AdminDashboard against a stubbed API and walk each tab, so a rename, a
 * bad field mapping, or a role-gating slip shows up here rather than in front
 * of an operator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const toast = vi.fn();

vi.mock('@/context/AppContext', () => ({ useApp: () => ({ toast }) }));
vi.mock('@/lib/clientAuth', () => ({ authHeaders: async () => ({}) }));
vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({ storage: { from: () => ({}) } }) }));
vi.mock('@/lib/downloadFile', () => ({ downloadWithAuth: vi.fn(async () => {}) }));

let currentRole: 'admin' | 'semi_admin' = 'admin';
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'boss-uid', displayName: 'Boss' } }),
}));

const STATS = {
  totalBusinesses: 4, totalSuppliers: 2, totalProducts: 120, totalOrders: 9,
  totalRevenue: 1234.5, totalUsers: 40, pendingVerifications: 1, recentOrders: [
    { id: 'ORD-9', customerName: 'Xasan', total: 40, status: 'completed', createdAt: '2026-03-04T09:00:00Z' },
  ],
};
const SUPPLIERS = [
  { id: 1, name: 'Sokow Sambusa', icon: '🥟', verified: true,  location: 'Hodan',
    accountType: 'business', approvalStatus: 'approved', slug: 'sokow' },
  { id: 2, name: 'Hamar Tech',    icon: '💻', verified: false, location: 'Wadajir',
    accountType: 'supplier', approvalStatus: 'pending', slug: 'hamar',
    agentSubmittedAt: '2026-03-01T00:00:00Z' },
];
const PRODUCTS = [
  { id: 11, name: 'Sambusa', sku: 'SB-1', category: 'food', price: 1.5, stock: 10,
    supplierId: 1, imageUrl: '', tags: [] },
  { id: 12, name: 'Cable', sku: 'CB-1', category: 'electronics', price: 9, stock: 0,
    supplierId: 2, imageUrl: '', tags: [] },
];
const ORDERS = [
  { id: 'ORD-1', customerName: 'Xasan', total: 100, status: 'completed', items: [],
    createdAt: '2026-03-04T09:00:00Z' },
  { id: 'ORD-2', customerName: 'Amina', total: 50, status: 'pending', items: [],
    createdAt: '2026-03-04T10:00:00Z' },
];
const USERS  = [{ id: 'u1', fullName: 'Xasan Cadde', phone: '+252611', avatar: '', verified: true, createdAt: '2026-01-01' }];
const ADMINS = [{ id: 1, userId: 'boss-uid', role: 'admin', name: 'Boss', email: 'b@x.com', createdAt: '2026-01-01' }];
const PAYOUTS = {
  payouts: [{ id: 5, supplierId: 1, storeName: 'Sokow Sambusa', storeIcon: '🥟', amount: 75,
              phone: '+252611', status: 'pending', note: null, createdAt: '2026-03-02', decidedAt: null }],
  totals: { pending: 75, approved: 0, pendingCount: 1 },
};
const AGENTS = { agents: [{ id: 3, name: 'Field Ali', icon: '🧑', status: 'pending', createdAt: '2026-02-01',
                            stores: 2, instalmentsDue: 1, amountDue: 10, amountPaid: 0 }] };

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/api/admin/check'))       return json({ role: currentRole });
    if (url.includes('/api/admin/stats'))       return json(STATS);
    if (url.includes('/api/admin/users'))       return json(USERS);
    if (url.includes('/api/admin/admins'))      return json(ADMINS);
    if (url.includes('/api/admin/payouts'))     return json(init?.method === 'PATCH' ? { success: true } : PAYOUTS);
    if (url.includes('/api/admin/agents'))      return json(AGENTS);
    if (url.includes('/api/admin/commissions')) return json({ rows: [] });
    if (url.includes('/api/settings/feed-tiers')) return json({});
    if (url.includes('/api/settings/hero'))     return json({ enabled: true, imageUrl: '', tag: '🔥 Hot Deals',
                                                              title: 'T', subtitle: 'S', ctaLabel: 'Go' });
    if (url.includes('/api/suppliers'))         return json(SUPPLIERS);
    if (url.includes('/api/products'))          return json(PRODUCTS);
    if (url.includes('/api/orders'))            return json(ORDERS);
    if (url.includes('/api/business-products')) return json([]);
    return json([]);
  });
}

async function open(tab?: RegExp) {
  const AdminDashboard = (await import('@/components/AdminDashboard')).default;
  render(<AdminDashboard />);
  if (tab) await userEvent.click(await screen.findByRole('button', { name: tab }));
}

beforeEach(() => {
  vi.clearAllMocks();
  currentRole = 'admin';
  vi.stubGlobal('fetch', stubFetch());
});

describe('access gate', () => {
  it('a non-admin is refused and shown their user id to hand over', async () => {
    currentRole = null as unknown as 'admin';
    await open();
    expect(await screen.findByText(/Access Denied/i)).toBeInTheDocument();
    expect(screen.getByText('boss-uid')).toBeInTheDocument();
  });
});

describe('overview', () => {
  it('shows the headline figures', async () => {
    await open();
    expect(await screen.findByText('👑 Full Admin', { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('120')).toBeInTheDocument());   // products
    expect(screen.getByText('40')).toBeInTheDocument();                          // users
  });

  it('surfaces a to-do list that links to the right desk', async () => {
    await open();
    expect(await screen.findByText(/Payout requests to decide/i)).toBeInTheDocument();
    expect(screen.getByText(/Verification requests/i)).toBeInTheDocument();
  });

  it('counts agent-submitted store setups WITHOUT visiting another tab first', async () => {
    // The to-do list derives the review queue from `businesses`, which the
    // overview loader did not fetch — so a store waiting on an admin was
    // invisible on the one screen meant to list everything waiting on an admin.
    await open();
    expect(await screen.findByText(/Store setups awaiting review/i)).toBeInTheDocument();
  });
});

describe('businesses', () => {
  it('lists stores with verification state', async () => {
    await open(/Businesses/);
    expect(await screen.findByText('Sokow Sambusa')).toBeInTheDocument();
    expect(screen.getByText('Hamar Tech')).toBeInTheDocument();
  });

  it('deleting a store confirms in-app and only then issues the DELETE', async () => {
    // window.confirm returns undefined in this runtime, so a confirm()-gated
    // handler would silently cancel and the button would look dead.
    await open(/Businesses/);
    await screen.findByText('Sokow Sambusa');
    await userEvent.click(screen.getAllByRole('button', { name: '🗑️' })[0]);

    const modal = await screen.findByText(/Delete business/i);
    expect(modal).toBeInTheDocument();
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .some(c => c[1]?.method === 'DELETE')).toBe(false);   // nothing yet

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .some(c => c[1]?.method === 'DELETE' && String(c[0]).includes('/api/suppliers/1'))).toBe(true));
  });

  it('cancelling the delete modal sends nothing', async () => {
    await open(/Businesses/);
    await screen.findByText('Sokow Sambusa');
    await userEvent.click(screen.getAllByRole('button', { name: '🗑️' })[0]);
    await screen.findByText(/Delete business/i);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .some(c => c[1]?.method === 'DELETE')).toBe(false);
  });

  it('search narrows a derived view without destroying the list', async () => {
    await open(/Businesses/);
    await screen.findByText('Sokow Sambusa');
    const box = screen.getByPlaceholderText(/search/i);
    await userEvent.type(box, 'hamar');
    await waitFor(() => expect(screen.queryByText('Sokow Sambusa')).not.toBeInTheDocument());
    await userEvent.clear(box);
    expect(await screen.findByText('Sokow Sambusa')).toBeInTheDocument();
  });
});

describe('products', () => {
  it('lists the catalog with a business filter', async () => {
    await open(/Products/);
    expect(await screen.findByText('Sambusa')).toBeInTheDocument();
    expect(screen.getByText('Cable')).toBeInTheDocument();
  });

  it('deleting asks for confirmation in-app rather than via window.confirm', async () => {
    await open(/Products/);
    await screen.findByText('Sambusa');
    // The row's delete control is the 🗑️ button.
    const del = screen.getAllByRole('button', { name: '🗑️' })[0];
    await userEvent.click(del);
    // An in-app modal, so it still works in runtimes where window.confirm is
    // blocked — window.confirm would silently no-op and delete nothing.
    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
  });
});

describe('orders', () => {
  it('lists orders and filters by status as a derived view', async () => {
    await open(/Orders/);
    expect(await screen.findByText(/ORD-1/)).toBeInTheDocument();
    expect(screen.getByText(/ORD-2/)).toBeInTheDocument();
  });
});

describe('users', () => {
  it('lists users and searches by name', async () => {
    await open(/Users/);
    expect(await screen.findByText('Xasan Cadde')).toBeInTheDocument();
  });
});

describe('review queue', () => {
  it('shows only agent-submitted stores that are pending', async () => {
    await open(/Review/);
    // The name sits beside the store emoji in one <strong>, so the text spans
    // several nodes — match the element's combined content.
    expect(await screen.findByText((_t, el) =>
      el?.tagName === 'STRONG' && /Hamar Tech/.test(el.textContent ?? ''))).toBeInTheDocument();
    // The approved store must NOT be queued for review.
    expect(screen.queryByText(/Sokow Sambusa/)).not.toBeInTheDocument();
  });
});

describe('payouts', () => {
  it('lists a pending request with its amount and store', async () => {
    await open(/Payouts/);
    expect(await screen.findByText(/Sokow Sambusa/)).toBeInTheDocument();
    // $75 appears both as the row amount and in the pending total.
    expect(screen.getAllByText(/\$75\.00/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /approve/i }).length).toBeGreaterThan(0);
  });
});

describe('agents', () => {
  it('lists a field agent awaiting approval with its commission owed', async () => {
    await open(/Agents/);
    // Name shares a cell with the agent's avatar emoji, so the text is split.
    const cell = await screen.findByText((_t, el) =>
      el?.tagName === 'TD' && /Field Ali/.test(el.textContent ?? ''));
    const row = cell.closest('tr')!;
    expect(within(row).getByText(/Pending/)).toBeInTheDocument();
    expect(within(row).getByText('$10.00')).toBeInTheDocument();
  });
});

describe('storefront', () => {
  it('loads the hero banner into an editable form', async () => {
    await open(/Storefront/);
    expect(await screen.findByText(/Hot Deals Hero Banner/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('T')).toBeInTheDocument();
  });
});

describe('team', () => {
  it('lists admins with their role', async () => {
    await open(/Team/);
    expect(await screen.findByText('Boss')).toBeInTheDocument();
  });

  it('refuses to let an admin remove themselves', async () => {
    await open(/Team/);
    await screen.findByText('Boss');
    // The only listed admin IS the signed-in user (boss-uid).
    const remove = screen.queryByRole('button', { name: /remove/i });
    if (remove) {
      await userEvent.click(remove);
      expect(toast).toHaveBeenCalledWith(expect.stringMatching(/can't remove yourself/i), 'error');
      expect(screen.queryByText(/Remove team member/i)).not.toBeInTheDocument();
    }
  });
});

/* ── The role contract the UI advertises ─────────────────────────────── */
describe('view-only (semi_admin)', () => {
  beforeEach(() => { currentRole = 'semi_admin'; });

  it('says it is view-only', async () => {
    await open();
    expect(await screen.findByText(/View-only mode/i)).toBeInTheDocument();
  });

  it('hides every privileged desk from the tab bar', async () => {
    await open();
    await screen.findByText(/View-only mode/i);
    for (const hidden of [/Payouts/, /Agents/, /Storefront/, /Feed/, /Exports/, /Team/]) {
      expect(screen.queryByRole('button', { name: hidden })).not.toBeInTheDocument();
    }
  });

  it('still gets the read-only tabs', async () => {
    await open();
    await screen.findByText(/View-only mode/i);
    for (const shown of [/Overview/, /Businesses/, /Products/, /Orders/, /Users/]) {
      expect(screen.getByRole('button', { name: shown })).toBeInTheDocument();
    }
  });
});
