# Hamar Mall — Terms of Use & Agreement

> Last updated: July 2026
> In-app version: `#/terms` (rendered by `views/LegalView.tsx`)
>
> **This is a starter agreement, not legal advice.** Have a qualified lawyer in your
> jurisdiction review it before you take real money from customers.

---

## 1. Acceptance

By creating an account or using Hamar Mall (the "Service") you agree to these Terms of Use.
If you do not agree, do not use the Service. If you use the Service on behalf of a business,
you confirm you are authorised to bind that business to these Terms.

## 2. Accounts

You are responsible for your account credentials and all activity under your account.
Business and supplier accounts must provide accurate store, contact, and payout information
and keep it up to date.

## 3. Seller subscription & fees

Business and supplier accounts require a paid subscription to access the store dashboard and
selling tools. The subscription fees are:

| Account type | Fee | Billing |
|---|---|---|
| **Business** — sell & manage products | **$14.99 USD** | per month |
| **Supplier** — wholesale & bulk orders | **$24.99 USD** | per month |
| Customer (shopper) | Free | — |
| Field agent | Free | — |

The fee is charged when you activate your store, through the displayed mobile-money payment
method (Sifalo Pay — EVC Plus / ZAAD / SAHAL, eDahab, or Premier Wallet). Fees are stated in
USD and exclude any charges levied by your wallet provider. We may change fees on notice;
changes apply to your next billing cycle.

**Each payment covers a 30-day billing period.** Subscriptions are *not* auto-renewing: we
never charge your wallet without you starting the payment. Your Billing page shows the date
your current month ends, and warns you in the final 5 days. If the period ends without a
renewal, the store dashboard is locked until you pay again (Section 5) — your data is kept.
You may renew before the period ends; paying early **adds** 30 days to the time you already
have rather than replacing it.

## 4. 7-day money-back guarantee

Every seller subscription includes a **7-day money-back guarantee**.

- You may request a **full refund** of your subscription fee at any time within **7 days** of
  payment, directly from the Billing page — **no reason required**.
- **After 7 days the payment is non-refundable.**
- When a refund is issued, your subscription is cancelled and store-dashboard access is locked
  until you pay again.
- Refunds are returned to the wallet used for payment; processing times depend on the payment
  provider.
- This guarantee applies to the **subscription fee only** — not to order payments, other
  charges, or third-party fees.

## 5. Non-payment & suspension

If a subscription is unpaid, expired, or refunded, the store dashboard, point-of-sale, and
selling features are locked until payment is made. Your public storefront may also be hidden
while inactive. Data is retained per Section 9 during any locked period.

## 6. Orders & payments

Prices and availability are set by sellers and may change. Orders are confirmed once placed and
are priced server-side. Order payments are handled by the displayed payment method/processor;
Hamar Mall is not the merchant of record for order transactions unless expressly stated.

## 7. Seller responsibilities

Sellers are responsible for their listings, stock accuracy, fulfilment and delivery, customer
service, taxes (including any VAT), and compliance with applicable law.

## 8. Prohibited use

No unlawful, fraudulent, infringing, or abusive activity; no manipulation of pricing, balances,
reviews, referrals, or fees; and no attempts to disrupt or gain unauthorised access to the Service.

## 9. Data & privacy

Your use of the Service is also governed by the Privacy Policy (`#/privacy`). We retain account
and transaction records as required for accounting and legal obligations.

## 10. Liability

The Service is provided "as is". To the extent permitted by law, Hamar Mall is not liable for
indirect, incidental, or consequential damages, and our total liability for any claim relating
to the subscription is limited to the fees you paid in the 7 days before the claim.

## 11. Changes

We may update these Terms; we will post the updated date above, and continued use after changes
take effect constitutes acceptance.

## 12. Contact

Questions about these Terms or billing: **support@hamarmall.com**

---

## Implementation notes (internal — not part of the agreement)

| Piece | Where |
|---|---|
| Prices, window, state machine | `lib/subscription.ts` (single source of truth) |
| Pay / refund / status API | `app/api/subscriptions/route.ts` |
| Dashboard lock | `components/TrialGate.tsx` |
| Billing screen | `views/BillingView.tsx` (`#/billing`) |
| DB columns + ledger | `supabase/migration_subscriptions.sql` |
| Monthly period column | `supabase/migration_v4_3.sql` (`subscription_period_end`) |
| In-app terms | `views/LegalView.tsx` (`#/terms`) |

- The fee is decided **server-side from `account_type`** — a client can never choose its own price.
- Refunds are gated server-side to the 7-day window; a late refund returns HTTP 409.
- The billing period is `subscription_period_end`; `deriveSubscription` marks a store `expired`
  (and `locked`) once it passes. Renewal extends from the later of *now* and the current period
  end, so early payment never burns paid days.
- Existing stores were **grandfathered** by the migration (backfilled `subscription_paid_at = created_at`)
  so the paywall did not lock out accounts that joined before billing existed. `migration_v4_3.sql`
  grandfathers them again for the monthly cycle: every currently-paid store gets a period ending
  30 days after the migration runs, never a period derived from that backfilled `created_at`.
- Until `migration_v4_3.sql` runs, monthly expiry is **not enforced** (`monthlyBillingEnabled`
  is false when the column is absent) — deploying the code before the migration cannot lock anyone out.
- Payment currently runs through **Sifalo mock mode** until real merchant credentials are set
  (`SIFALO_API_USERNAME` / `SIFALO_API_PASSWORD`). No real money moves until then; the refund
  step records the reversal in `subscription_events` but does not call a gateway refund API.
