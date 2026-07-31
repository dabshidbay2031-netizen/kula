// @vitest-environment node
/**
 * Regression guard: a view-only admin must not be able to move money.
 *
 * The panel advertises `semi_admin` as "View-only mode — you can see all data
 * but cannot make changes" and hides the privileged desks from the tab bar.
 * Every mutating handler below used a bare `requireAdmin(req)`, which accepts
 * ANY admin role, so that promise held only for people using the UI: a
 * semi_admin PATCH to /api/admin/payouts returned
 *   200 {"success":true,"status":"approved"}
 * and released a real withdrawal.
 *
 * Hiding a tab is not authorization. These pin the gate at the route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let adminRole: 'admin' | 'semi_admin' | null = null;
let authedUser: { id: string; email: string | null } | null = null;
/** Anything the handlers actually wrote, so "denied" means denied, not "failed later". */
let writes: string[] = [];

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = () => b;
  for (const m of ['update', 'insert', 'upsert', 'delete']) {
    b[m] = () => { writes.push(`${table}.${m}`); return b; };
  }
  b.maybeSingle = () => Promise.resolve(
    table === 'admins'    ? { data: adminRole ? { role: adminRole } : null, error: null }
  : table === 'payouts'   ? { data: { id: 1, supplier_id: 1, amount: 50, status: 'pending' }, error: null }
  : table === 'suppliers' ? { data: { id: 1, name: 'S', account_type: 'business' }, error: null }
  :                         { data: null, error: null });
  b.single = () => Promise.resolve({ data: { id: 1, status: 'approved' }, error: null });
  (b as { then?: unknown }).then = (res: (v: unknown) => void) =>
    Promise.resolve({ data: [], error: null, count: 0 }).then(res);
  return b;
}

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    auth: {
      getUser: async (token: string) =>
        token && authedUser ? { data: { user: authedUser }, error: null }
                            : { data: { user: null }, error: { message: 'invalid token' } },
    },
    from: (t: string) => makeBuilder(t),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock('@/lib/realtimeServer', () => ({ pingRealtime: () => {} }));
vi.mock('@/lib/notify', () => ({ createNotifications: async () => {} }));

import { PATCH as payoutsPatch } from '@/app/api/admin/payouts/route';
import { PATCH as agentsPatch }  from '@/app/api/admin/agents/route';
import { PATCH as commPatch }    from '@/app/api/admin/commissions/route';
import { POST as trialPost, DELETE as trialDelete } from '@/app/api/admin/trial/route';
import { GET as checkGet } from '@/app/api/admin/check/route';

const body = (b: unknown, method = 'PATCH', auth = true) => new Request('http://test/api/admin', {
  method,
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer jwt' } : {}) },
  body: JSON.stringify(b),
});

/** Every money/state mutation, with a payload that WOULD succeed if allowed. */
const MUTATIONS: { name: string; call: () => Promise<Response> }[] = [
  { name: 'payouts PATCH (approve a withdrawal)',
    call: () => payoutsPatch(body({ id: 1, status: 'approved' })) },
  { name: 'agents PATCH (approve a field agent)',
    call: () => agentsPatch(body({ agentId: 1, action: 'approve' })) },
  { name: 'commissions PATCH (mark a commission paid)',
    call: () => commPatch(body({ supplierId: 1, instalment: 1, action: 'pay' })) },
  { name: 'trial POST (grant free months)',
    call: () => trialPost(body({ supplierId: 1, days: 90 }, 'POST')) },
  { name: 'trial DELETE (revoke a trial)',
    call: () => trialDelete(new Request('http://test/api/admin/trial?supplierId=1', {
      method: 'DELETE', headers: { Authorization: 'Bearer jwt' } })) },
];

beforeEach(() => { adminRole = null; authedUser = null; writes = []; });

describe('semi_admin is view-only at the API, not just in the UI', () => {
  beforeEach(() => { authedUser = { id: 'viewer', email: null }; adminRole = 'semi_admin'; });

  for (const m of MUTATIONS) {
    it(`${m.name} → 403`, async () => {
      const res = await m.call();
      expect(res.status, `${m.name} must be refused`).toBe(403);
      expect(writes, `${m.name} must not write anything`).toEqual([]);
    });
  }
});

describe('anonymous callers are refused', () => {
  it('payouts PATCH without a token → 401, nothing written', async () => {
    const res = await payoutsPatch(body({ id: 1, status: 'approved' }, 'PATCH', false));
    expect(res.status).toBe(401);
    expect(writes).toEqual([]);
  });
});

describe('full admins still get through the gate', () => {
  beforeEach(() => { authedUser = { id: 'boss', email: null }; adminRole = 'admin'; });

  it('payouts PATCH is allowed', async () => {
    const res = await payoutsPatch(body({ id: 1, status: 'approved' }));
    expect(res.status).toBe(200);
  });

  it('the others clear authorization (any failure is business logic, not 401/403)', async () => {
    for (const m of MUTATIONS.slice(1)) {
      const res = await m.call();
      expect([401, 403], `${m.name} must not be an auth failure for a full admin`)
        .not.toContain(res.status);
    }
  });
});

describe('/api/admin/check answers only about the caller', () => {
  it('no token → null, so it cannot be used to probe anyone', async () => {
    adminRole = 'admin';
    const res = await checkGet(new Request('http://test/api/admin/check'));
    expect(await res.json()).toEqual({ role: null });
  });

  it('a uid in the query string is ignored — identity comes from the JWT', async () => {
    authedUser = { id: 'viewer', email: null };
    adminRole = 'semi_admin';
    const res = await checkGet(new Request('http://test/api/admin/check?uid=boss', {
      headers: { Authorization: 'Bearer jwt' },
    }));
    // Answers for the CALLER (semi_admin), never for the uid they asked about.
    expect(await res.json()).toEqual({ role: 'semi_admin' });
  });

  it('returns the caller’s real role when they are an admin', async () => {
    authedUser = { id: 'boss', email: null };
    adminRole = 'admin';
    const res = await checkGet(new Request('http://test/api/admin/check', {
      headers: { Authorization: 'Bearer jwt' },
    }));
    expect(await res.json()).toEqual({ role: 'admin' });
  });

  it('a signed-in non-admin gets null', async () => {
    authedUser = { id: 'shopper', email: null };
    adminRole = null;
    const res = await checkGet(new Request('http://test/api/admin/check', {
      headers: { Authorization: 'Bearer jwt' },
    }));
    expect(await res.json()).toEqual({ role: null });
  });
});
