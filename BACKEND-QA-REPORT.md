# Mogarenta — Full Backend QA Report

**Date:** 2026-07-28
**Scope:** Server-side authorization & business logic across every user type
**Engine:** Vitest 4.1.8 · jsdom + node environments · Next.js 16 App Router API route handlers (Supabase mocked)
**Run by:** ZCode automated backend audit

---

## 1. Executive summary

| Metric | Before | After |
|---|---|---|
| Test files | 40 | **42** |
| Tests passed | 478 | **511** |
| Tests skipped | 9 | 9 |
| Tests failed | 0 | **0** |
| TypeScript errors | 0 | **0** |

**Verdict: ✅ PASS.** The backend is green across all seven user types. The existing suite already covered the highest-risk surfaces (admin privilege escalation, supplier ownership, orders IDOR, product/customer/claim cross-tenant guards). I closed the two remaining coverage gaps — **customer/guest self-service** and the **cashier/agent** flows — by adding **33 new tests** (2 files). No defects were found in production code; every authorization boundary I probed held.

---

## 2. The seven user types under test

Mogarenta is a multi-tenant marketplace with a service-role Supabase client that bypasses RLS, so the **API-route authorization layer (`lib/apiAuth.ts`) is the only thing protecting the data**. Every type is exercised:

| # | User type | Identity mechanism | Backend auth gate |
|---|---|---|---|
| 1 | **Guest** (anonymous) | none | browse is public; every persist → `requireUser` |
| 2 | **Customer** (signed-in shopper) | Supabase JWT | `requireUser` + self-id scoping (wishlist, reviews, referrals, addresses, orders-by-userId) |
| 3 | **Business** (store owner) | Supabase JWT + `suppliers.auth_user_id` | `requireSupplierAccess`, `resolveStoreOwner`, `ownsStoreOrAdmin` |
| 4 | **Supplier** (wholesaler) | Supabase JWT + `suppliers.auth_user_id` | same ownership gates as business; admin-only fields (`verified`, `approvalStatus`) rejected on self-edit |
| 5 | **Admin / semi_admin** | Supabase JWT + `admins` table | `requireAdmin` (any role) vs `{ role: 'admin' }` (full-admin mutations only) |
| 6 | **Cashier** (store staff) | phone+password → HMAC `X-Cashier-Token` (no JWT) | `getCashierActor` re-reads the **live** row each request; privilege-scoped via `canAccessStore(req, storeId, privilege)` |
| 7 | **Field Agent** (onboarding) | Supabase JWT + `suppliers.account_type='agent'` | `agentManagesStore` — may edit only while store is `trial`/`pending`; access ends the instant an admin approves |

---

## 3. Per-user-type coverage matrix

### Guest (anonymous)
| Route | Expected | Result |
|---|---|---|
| `GET /api/reviews?productId=` | 200 (public) | ✅ |
| `POST /api/reviews` | 401 | ✅ |
| `POST /api/wishlist` | 401 | ✅ |
| `DELETE /api/wishlist` | 401 | ✅ |
| `GET /api/referrals` | 401 | ✅ |
| `GET /api/addresses` | 401 | ✅ |
| `POST /api/addresses` | 401 | ✅ |

### Customer (self-service + IDOR isolation)
| Route | Scenario | Result |
|---|---|---|
| `POST /api/reviews` | own review accepted | ✅ |
| `POST /api/reviews` | rating out of 1–5 → 400 | ✅ |
| `POST /api/reviews` | missing productId → 400 | ✅ |
| `POST /api/wishlist` | own wishlist → 200 | ✅ |
| `POST /api/wishlist` | missing productId → 400 | ✅ |
| `GET /api/referrals?userId=self` | mint own code → 201 | ✅ |
| `GET /api/referrals?userId=victim` | **IDOR blocked → 403** | ✅ |
| `GET /api/addresses?userId=self` | 200 | ✅ |
| `GET /api/addresses?userId=victim` | **IDOR blocked → 403** | ✅ |
| `POST /api/addresses` body `userId=victim` | **forgery blocked → 403** | ✅ |
| `POST /api/addresses` missing lat/long | 400 | ✅ |

### Business / Supplier (ownership) — *existing coverage, re-verified*
| Route | Scenario | Result |
|---|---|---|
| `PATCH /api/suppliers/[id]` | owner → 200; non-owner → 403; no token → 401 | ✅ |
| `PATCH /api/suppliers/[id]` | owner self-verify → **403 (admin-only field)** | ✅ |
| `PATCH /api/suppliers/[id]` | owner self-approve → **403** | ✅ |
| `POST /api/products` | non-staff → 403; no token → 401 | ✅ |
| `GET /api/orders?supplierId=` | guest → 401; non-owner → 403; owner → 200 | ✅ |
| products/customers/claims cross-tenant edits | `requireProductOwner` / `requireCustomerOwner` / `requireClaimOwner` | ✅ |

### Admin / semi_admin — *existing coverage, re-verified*
| Route | Scenario | Result |
|---|---|---|
| `GET /api/admin/users`, `/stats`, `/admins` | no token → 401; non-admin JWT → 401 | ✅ |
| `POST /api/admin/admins` (self-promote) | anon → 401; normal user → 401; semi_admin → **403**; full admin → 201 | ✅ |

### Cashier (staff token lifecycle) — *new coverage*
| Route | Scenario | Result |
|---|---|---|
| `GET /api/cashiers/me` | no token → 401 | ✅ |
| `GET /api/cashiers/me` | forged/garbage token → **401 (HMAC verify)** | ✅ |
| `GET /api/cashiers/me` | valid token, no live row → 401 | ✅ |
| `GET /api/cashiers/me` | active cashier → 200 + privileges + store id | ✅ |
| `GET /api/cashiers/me` | **deactivated cashier (`is_active:false`) → 401 immediately** | ✅ |

### Field Agent (onboarding window) — *new coverage*
| Route | Scenario | Result |
|---|---|---|
| `GET /api/agent/stores?agentId=` | no token → 401 | ✅ |
| `GET /api/agent/stores` | own stores → 200; **other agent → 403**; admin → 200 | ✅ |
| `POST /api/agent/submit` | own store, status `trial` → not rejected for ownership | ✅ |
| `POST /api/agent/submit` | store registered by **another** agent → 403 | ✅ |
| `POST /api/agent/submit` | store now **approved** → **403 (access ended)** | ✅ |
| `POST /api/agent/submit` | no token → 401; missing storeId → 400 | ✅ |

---

## 4. How the new tests work (engineering note)

Both new files run in the `node` environment (no DOM) and **import the real Next.js route handlers**, mocking only `@/lib/supabase`. That keeps the authorization logic — the actual security boundary — under test, not stubbed.

**`tests/customer-self-service.test.ts`** — guest-vs-customer + cross-customer IDOR. Each identity-scoped endpoint is hit twice: once anonymous (expect 401), once signed-in as `cust-1` attempting to act on `victim` (expect 403). A helper bug in v1 (spreading `init.headers` overwrote the `Authorization` bearer, and passing a URL string as `init` dropped the querystring) surfaced as false 401s; fixed by a helper that **merges** headers and accepts `(url, init)`.

**`tests/cashier-agent-flows.test.ts`** — exercises the **genuine HMAC token pipeline** by setting `CASHIER_TOKEN_SECRET` and signing real tokens via `signCashierToken`, so verify + live-row recheck run for real. The critical assertion is that a **deactivated cashier** is rejected even with a still-valid token — the property that stops a fired staff member from continuing to operate the POS. The agent block verifies the time-boxed onboarding window: access dies the moment `approval_status` flips to `approved`.

---

## 5. Findings & risk notes

- **No defects found** in production code during this pass.
- **Defense-in-depth is sound.** The service-role client bypassing RLS is fully mitigated by the `require*` gate family; every privileged mutation is owner-or-admin checked, and admin-only fields (`verified`, `approvalStatus`, account type) are explicitly filtered on self-service writes.
- **Anti-enumeration** on cashier login (uniform "Incorrect phone or password") and **rate limiting** (8/min per IP) are present and intact.
- **9 pre-existing skipped tests** (`tests/trial.test.tsx`) are intentionally skipped — not a regression. Worth a follow-up to either implement or delete them to keep the suite honest.

---

## 6. Reproducing this run

```bash
npm test                              # full suite (42 files, 511 tests, ~19s)
npm run test:watch                    # interactive
npx vitest run tests/customer-self-service.test.ts tests/cashier-agent-flows.test.ts   # just the new coverage
npx tsc --noEmit                      # typecheck (0 errors)
```

## 7. New files added

- `tests/customer-self-service.test.ts` — 19 tests (guest boundary + customer self-service + IDOR)
- `tests/cashier-agent-flows.test.ts` — 14 tests (cashier token lifecycle + agent onboarding window)
