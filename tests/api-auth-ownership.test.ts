// @vitest-environment node
/**
 * Ownership authorization for non-admin routes (regression guard):
 *  - chat messages are readable/writable only by conversation participants
 *  - a supplier can edit only its OWN store, and cannot self-grant
 *    verification / approval / account-type (admin-only fields)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let authedUser: { id: string } | null = null;          // who the JWT resolves to
let participants: [string, string] | null = ['userA', 'userB']; // conversation members
let supplierOwner: string | null = 'ownerA';            // suppliers.auth_user_id
let adminRole: 'admin' | 'semi_admin' | null = null;    // caller's admins row

function builder(table: string) {
  const b: Record<string, unknown> = {};
  // Capture an .eq('auth_user_id', X) so the suppliers lookup honours it —
  // requireSupplierAccess/canAccessStore filter ownership IN the query, so the
  // mock must return null when the caller isn't the owner.
  let authUserFilter: string | undefined;
  for (const m of ['select', 'in', 'order', 'limit', 'lt', 'neq', 'is', 'update', 'insert', 'upsert', 'delete', 'range', 'gte']) {
    b[m] = () => b;
  }
  b.eq = (col: string, val: unknown) => { if (col === 'auth_user_id') authUserFilter = String(val); return b; };
  b.maybeSingle = () => {
    if (table === 'conversations') {
      return Promise.resolve({ data: participants ? { user_id_1: participants[0], user_id_2: participants[1] } : null, error: null });
    }
    if (table === 'admins') {
      return Promise.resolve({ data: adminRole ? { role: adminRole, user_id: authedUser?.id } : null, error: null });
    }
    if (table === 'suppliers') {
      // Honour .eq('auth_user_id', X): the store only "matches" its true owner.
      const ownerMatches = authUserFilter === undefined || authUserFilter === supplierOwner;
      return Promise.resolve({ data: supplierOwner && ownerMatches ? { id: 1, auth_user_id: supplierOwner } : null, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };
  // update(...).select().single() → the saved supplier row
  b.single = () => Promise.resolve({ data: { id: 1, name: 'Store', auth_user_id: supplierOwner, account_type: 'supplier' }, error: null });
  (b as { then?: unknown }).then = (res: (v: unknown) => void) =>
    Promise.resolve({ data: [], error: null }).then(res);
  return b;
}

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    auth: { getUser: async (t: string) => (t && authedUser ? { data: { user: authedUser }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from: (table: string) => builder(table),
  }),
}));

import { GET as messagesGet, POST as messagesPost } from '@/app/api/conversations/[id]/messages/route';
import { PATCH as supplierPatch } from '@/app/api/suppliers/[id]/route';
import { POST as productsPost } from '@/app/api/products/route';
import { PATCH as profilePatch } from '@/app/api/profile/[id]/route';
import { GET as ordersGet } from '@/app/api/orders/route';

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const authed = (init: RequestInit = {}) => new Request('http://t/x', { headers: { Authorization: 'Bearer jwt' }, ...init });
const anon   = (init: RequestInit = {}) => new Request('http://t/x', init);

beforeEach(() => { authedUser = null; participants = ['userA', 'userB']; supplierOwner = 'ownerA'; adminRole = null; });

describe('chat messages — participants only', () => {
  it('no token → 401', async () => {
    expect((await messagesGet(anon(), params('c1'))).status).toBe(401);
  });
  it('signed-in NON-participant → 403 (cannot read others\' chats)', async () => {
    authedUser = { id: 'intruder' };
    expect((await messagesGet(authed(), params('c1'))).status).toBe(403);
  });
  it('participant → 200', async () => {
    authedUser = { id: 'userA' };
    expect((await messagesGet(authed(), params('c1'))).status).toBe(200);
  });
  it('POST as non-participant → 403', async () => {
    authedUser = { id: 'intruder' };
    const req = authed({ method: 'POST', headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }) });
    expect((await messagesPost(req, params('c1'))).status).toBe(403);
  });
});

describe('supplier PATCH — owner or admin only', () => {
  const patch = (bodyObj: object) => authed({
    method: 'PATCH',
    headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });

  it('no token → 401', async () => {
    const req = anon({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect((await supplierPatch(req, params('1'))).status).toBe(401);
  });
  it('signed-in non-owner non-admin → 403', async () => {
    authedUser = { id: 'someone-else' };
    expect((await supplierPatch(patch({ name: 'Hacked' }), params('1'))).status).toBe(403);
  });
  it('owner editing own store → 200', async () => {
    authedUser = { id: 'ownerA' };
    expect((await supplierPatch(patch({ name: 'My Store' }), params('1'))).status).toBe(200);
  });
  it('owner trying to self-verify → 403 (admin-only field)', async () => {
    authedUser = { id: 'ownerA' };
    expect((await supplierPatch(patch({ verified: true }), params('1'))).status).toBe(403);
  });
  it('owner trying to self-approve → 403', async () => {
    authedUser = { id: 'ownerA' };
    expect((await supplierPatch(patch({ approvalStatus: 'approved' }), params('1'))).status).toBe(403);
  });
  it('admin can verify any store → 200', async () => {
    authedUser = { id: 'boss' }; adminRole = 'admin';
    expect((await supplierPatch(patch({ verified: true }), params('1'))).status).toBe(200);
  });
});

describe('catalog writes — staff only (requireStaff)', () => {
  const body = () => authed({
    method: 'POST',
    headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X', price: 1, category: 'electronics', supplierId: 1 }),
  });
  it('POST /products without a token → 401', async () => {
    const req = anon({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect((await productsPost(req)).status).toBe(401);
  });
  it('POST /products as a signed-in non-staff user → 403', async () => {
    authedUser = { id: 'shopper' }; adminRole = null; supplierOwner = null; // no admin row, no supplier account
    expect((await productsPost(body())).status).toBe(403);
  });
});

describe('orders GET — no IDOR (auth + ownership)', () => {
  const ord = (q: string, tok = true) =>
    new Request('http://t/api/orders' + q, tok ? { headers: { Authorization: 'Bearer jwt' } } : {});

  it('guest reading a store\'s orders → 401 (was an open IDOR)', async () => {
    expect((await ordersGet(ord('?supplierId=31', false))).status).toBe(401);
  });
  it('guest reading all orders → 401', async () => {
    expect((await ordersGet(ord('', false))).status).toBe(401);
  });
  it('signed-in user reading a store they don\'t own → 403', async () => {
    authedUser = { id: 'someone-else' }; supplierOwner = 'ownerA';
    expect((await ordersGet(ord('?supplierId=31'))).status).toBe(403);
  });
  it('owner reading their own store → 200', async () => {
    authedUser = { id: 'ownerA' }; supplierOwner = 'ownerA';
    expect((await ordersGet(ord('?supplierId=31'))).status).toBe(200);
  });
  it('customer reading their OWN orders → 200', async () => {
    authedUser = { id: 'cust-1' };
    expect((await ordersGet(ord('?userId=cust-1'))).status).toBe(200);
  });
  it('customer reading SOMEONE ELSE\'s orders → 403', async () => {
    authedUser = { id: 'cust-1' }; adminRole = null;
    expect((await ordersGet(ord('?userId=cust-2'))).status).toBe(403);
  });
  it('admin reading everything → 200', async () => {
    authedUser = { id: 'boss' }; adminRole = 'admin';
    expect((await ordersGet(ord(''))).status).toBe(200);
  });
});

describe('profile edit — self only (requireSelf)', () => {
  const patch = () => authed({
    method: 'PATCH',
    headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: 'New Name' }),
  });
  it('no token → 401', async () => {
    const req = anon({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect((await profilePatch(req, params('user-1'))).status).toBe(401);
  });
  it('editing someone else\'s profile → 403', async () => {
    authedUser = { id: 'attacker' };
    expect((await profilePatch(patch(), params('victim-1'))).status).toBe(403);
  });
});
