// @vitest-environment node
/**
 * Cashier (staff) & field-agent backend coverage.
 *
 * Cashiers are the ONLY non-Supabase-auth actor: they authenticate with phone
 * + password and receive an HMAC-signed X-Cashier-Token. Their authority is
 * re-read from the live cashiers row on every request, so a deactivated cashier
 * (or a revoked privilege) is rejected immediately. This is the boundary that
 * stops a fired staff member from continuing to ring up sales. We exercise the
 * REAL token pipeline by setting CASHIER_TOKEN_SECRET and signing real tokens —
 * only the DB layer is mocked — so the HMAC verify + live-row recheck is under
 * test, not stubbed away.
 *
 * Field agents onboard stores; they may edit a store ONLY while it's still in
 * trial/pending review (agentManagesStore). Once an admin approves, the agent
 * loses access and the owner takes over — and an unvetted agent may not submit
 * anything to the review queue at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real HMAC secret so the genuine sign/verify round-trips in the test.
process.env.CASHIER_TOKEN_SECRET = 'test-secret-only-for-vitest';

/* ── Test-controlled state ───────────────────────────────────── */
let authedUser: { id: string; email: string | null } | null = null; // JWT caller (agent/admin/owner)
let adminRow: { role: string } | null = null;
let cashierRow: Record<string, unknown> | null = null; // live cashiers row
let supplierOwnerMatch: string | null = null;          // suppliers.auth_user_id that "matches"
let agentStoreId: number | null = null;                // agent's own supplier id
let storeRegisteredBy: number | null = null;           // registered_by_agent_id for a target store
let storeApprovalStatus: string | null = null;

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  let eqFilter: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'order', 'limit', 'lt', 'neq', 'is', 'range', 'gte', 'update', 'insert', 'upsert', 'delete']) {
    b[m] = () => b;
  }
  b.eq = (col: string, val: unknown) => { eqFilter[col] = val; return b; };
  b.maybeSingle = () => {
    if (table === 'cashiers') return Promise.resolve({ data: cashierRow, error: null });
    if (table === 'admins')   return Promise.resolve({ data: adminRow, error: null });
    if (table === 'suppliers') {
      // .eq('auth_user_id', X) → owner/agent identity lookup
      if ('auth_user_id' in eqFilter) {
        const matches = supplierOwnerMatch != null && String(eqFilter['auth_user_id']) === supplierOwnerMatch;
        return Promise.resolve(matches
          ? { data: { id: agentStoreId ?? 5, auth_user_id: supplierOwnerMatch, account_type: 'agent' }, error: null }
          : { data: null, error: null });
      }
      // .eq('id', X) → store-attribute lookup (agentManagesStore / requireApprovedAgent)
      if ('id' in eqFilter) {
        return Promise.resolve({
          data: { id: Number(eqFilter['id']), registered_by_agent_id: storeRegisteredBy, approval_status: storeApprovalStatus },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };
  b.single = () => Promise.resolve({ data: { id: 1, approval_status: 'pending', agent_submitted_at: '2026-01-01' }, error: null });
  (b as { then?: unknown }).then = (res: (v: unknown) => void) =>
    Promise.resolve({ data: [], error: null }).then(res);
  return b;
}

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    auth: {
      getUser: async (token: string) =>
        token && authedUser ? { data: { user: authedUser }, error: null }
                            : { data: { user: null }, error: { message: 'no token' } },
    },
    from: (table: string) => makeBuilder(table),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { signCashierToken } from '@/lib/cashierAuth';
import { GET as cashierMeGet } from '@/app/api/cashiers/me/route';
import { GET as agentStoresGet } from '@/app/api/agent/stores/route';
import { POST as agentSubmitPost } from '@/app/api/agent/submit/route';

/** Authenticated request. `init.headers` are MERGED with the bearer (not replaced). */
const authed = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { Authorization: 'Bearer jwt', ...((init.headers as Record<string, string>) ?? {}) } });
const anon = (url: string, init: RequestInit = {}) => new Request(url, init);
const json = (body: unknown) => JSON.stringify(body);
const cashierReq = () => new Request('http://t/api/cashiers/me', { headers: { 'X-Cashier-Token': signCashierToken('c-1') } });

beforeEach(() => {
  authedUser = null; adminRow = null; cashierRow = null;
  supplierOwnerMatch = null; agentStoreId = null; storeRegisteredBy = null; storeApprovalStatus = null;
});

/* ───────────────────────── CASHIER ───────────────────────── */

describe('CASHIER login session (X-Cashier-Token) — live re-validation', () => {
  it('no token → /cashiers/me 401', async () => {
    expect((await cashierMeGet(anon('http://t/api/cashiers/me'))).status).toBe(401);
  });

  it('a forged/garbage token → 401 (HMAC verify fails)', async () => {
    expect((await cashierMeGet(new Request('http://t/api/cashiers/me', { headers: { 'X-Cashier-Token': 'garbage.sig' } }))).status).toBe(401);
  });

  it('a valid token but no live cashiers row → 401', async () => {
    cashierRow = null;
    expect((await cashierMeGet(cashierReq())).status).toBe(401);
  });

  it('an ACTIVE cashier with a valid token → 200 + privileges + store id', async () => {
    cashierRow = { id: 'c-1', business_id: 'ownerA', name: 'Ali', privileges: ['pos', 'customers'], is_active: true };
    supplierOwnerMatch = 'ownerA';
    const res = await cashierMeGet(cashierReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.privileges).toEqual(['pos', 'customers']);
    expect(body.supplierId).toBe(5);
    expect(body.id).toBe('c-1');
  });

  it('a DEACTIVATED cashier (is_active:false) is rejected immediately → 401', async () => {
    cashierRow = { id: 'c-1', business_id: 'ownerA', name: 'Ali', privileges: ['pos'], is_active: false };
    // Even with a still-valid signed token, the live row says inactive → no actor.
    expect((await cashierMeGet(cashierReq())).status).toBe(401);
  });
});

/* ──────────────────────── FIELD AGENT ────────────────────── */

describe('FIELD AGENT — store onboarding is gated to the registering agent', () => {
  // agentSupplierIdFor('agentA') must resolve → set the agent's auth_user_id match.
  const agentOwns = () => { supplierOwnerMatch = 'agentA'; agentStoreId = 5; };

  it('agent/stores without a token → 401', async () => {
    expect((await agentStoresGet(anon('http://t/api/agent/stores?agentId=5'))).status).toBe(401);
  });

  it('agent reading its OWN stores → 200', async () => {
    authedUser = { id: 'agentA', email: null }; agentOwns();
    expect((await agentStoresGet(authed('http://t/api/agent/stores?agentId=5'))).status).toBe(200);
  });

  it('agent reading ANOTHER agent\'s stores → 403', async () => {
    authedUser = { id: 'agentA', email: null }; agentOwns();
    expect((await agentStoresGet(authed('http://t/api/agent/stores?agentId=999'))).status).toBe(403);
  });

  it('admin may read any agent\'s stores → 200', async () => {
    authedUser = { id: 'boss', email: null }; adminRow = { role: 'admin' };
    expect((await agentStoresGet(authed('http://t/api/agent/stores?agentId=5'))).status).toBe(200);
  });

  it('agent submitting a store it onboards (still trial) → not rejected for ownership', async () => {
    authedUser = { id: 'agentA', email: null }; agentOwns();
    storeRegisteredBy = 5;            // this store was registered by agent 5
    storeApprovalStatus = 'trial';    // still in setup window
    const req = authed('http://t/api/agent/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ storeId: 7 }) });
    const res = await agentSubmitPost(req);
    // ownership gate passes; the assertion is it is NOT rejected as "not your store".
    const body = await res.json().catch(() => ({}));
    expect(body.error ?? '').not.toMatch(/not a store you/i);
  });

  it('agent submitting a store it did NOT onboard → 403', async () => {
    authedUser = { id: 'agentA', email: null }; agentOwns();
    storeRegisteredBy = 999;          // registered by a DIFFERENT agent
    storeApprovalStatus = 'trial';
    const req = authed('http://t/api/agent/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ storeId: 7 }) });
    expect((await agentSubmitPost(req)).status).toBe(403);
  });

  it('agent submitting a store already APPROVED → 403 (access ended)', async () => {
    authedUser = { id: 'agentA', email: null }; agentOwns();
    storeRegisteredBy = 5;            // they registered it…
    storeApprovalStatus = 'approved'; // …but it's now approved → no longer theirs to edit
    const req = authed('http://t/api/agent/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ storeId: 7 }) });
    expect((await agentSubmitPost(req)).status).toBe(403);
  });

  it('agent submit without a token → 401', async () => {
    const req = anon('http://t/api/agent/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({ storeId: 7 }) });
    expect((await agentSubmitPost(req)).status).toBe(401);
  });

  it('agent submit missing storeId → 400', async () => {
    authedUser = { id: 'agentA', email: null }; agentOwns();
    storeRegisteredBy = 5;
    storeApprovalStatus = 'trial';
    const req = authed('http://t/api/agent/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json({}) });
    expect((await agentSubmitPost(req)).status).toBe(400);
  });
});
