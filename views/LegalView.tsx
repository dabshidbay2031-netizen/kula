'use client';

import { usePathname, useRouter, Link } from '@/lib/hashRouter';
import Header from '@/components/Header';
import {
  SUBSCRIPTION_PRICES, SUBSCRIPTION_TRIAL_DAYS, SUBSCRIPTION_CURRENCY, SUBSCRIPTION_PERIOD_DAYS,
} from '@/lib/subscription';
import {
  PHONES, SOCIALS, telHref, whatsappHref, WHATSAPP_GREETING,
} from '@/lib/contactInfo';
import { PLATFORM_FEE_RATE } from '@/lib/fees';
import SharedBrandMark from '@/components/BrandMark';
import SocialIcon from '@/components/SocialIcon';

/**
 * The site's information pages — Privacy, Terms, Refunds, About and Contact —
 * all served from here (#/privacy, #/terms, #/refunds, #/about, #/contact) and
 * linked from the footer.
 *
 * These are starter templates — have them reviewed by counsel and fill in the
 * bracketed placeholders before launch / PSP / app-store onboarding.
 */
const COMPANY = 'Hamar Mall';
const CONTACT = 'support@hamarmall.com';
const UPDATED = 'July 2026';
const BIZ = `$${SUBSCRIPTION_PRICES.business.toFixed(2)}`;
const SUP = `$${SUBSCRIPTION_PRICES.supplier.toFixed(2)}`;
const FEE_PCT = `${Math.round(PLATFORM_FEE_RATE * 100)}%`;

/* The shared brand mark, at the size the legal hero uses. */
function BrandMark() {
  return <SharedBrandMark size={22} />;
}

/* Reusable hero header — gradient banner with the mark, an eyebrow, the title,
   and a one-line subtitle. */
function LegalHero({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <header className="legal-hero">
      <span className="legal-hero-shine" aria-hidden="true" />
      <div className="legal-hero-mark"><BrandMark /></div>
      <p className="legal-hero-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="legal-hero-sub">{sub}</p>
    </header>
  );
}

/* Bottom cross-links between the info pages (active page is plain text). */
function LegalFootNav({ current }: { current: 'about' | 'contact' | 'refunds' | 'privacy' | 'terms' }) {
  const items: { key: typeof current; href: string; label: string }[] = [
    { key: 'about',   href: '/about',   label: 'About Us' },
    { key: 'contact', href: '/contact', label: 'Contact' },
    { key: 'refunds', href: '/refunds', label: 'Returns & Refunds' },
    { key: 'privacy', href: '/privacy', label: 'Privacy Policy' },
    { key: 'terms',   href: '/terms',   label: 'Terms of Use' },
  ];
  return (
    <nav className="legal-footnav" aria-label="Information pages">
      {items.map((it, i) => (
        <span key={it.key}>
          {i > 0 && <span className="legal-footnav-dot" aria-hidden="true"> · </span>}
          {it.key === current ? (
            <span className="legal-footnav-current">{it.label}</span>
          ) : (
            <Link href={it.href}>{it.label}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}

export default function LegalPage() {
  const pathname = usePathname();
  const router   = useRouter();
  const isTerms   = pathname?.startsWith('/terms');
  const isRefunds = pathname?.startsWith('/refunds');
  const isAbout   = pathname?.startsWith('/about');
  const isContact = pathname?.startsWith('/contact');

  return (
    <div className="page-anim">
      <Header showSearch={false} />
      <div className="legal-wrap">
        <button className="auth-back-btn" onClick={() => router.back()}>← Back</button>

        {isAbout ? (
          <article className="legal-doc">
            <LegalHero
              eyebrow={COMPANY}
              title={`About ${COMPANY}`}
              sub="Somalia's marketplace — shop from local stores, or run your own with a full point-of-sale and online storefront."
            />

            <section className="legal-card">
              <h2>Who we are</h2>
              <p>{COMPANY} is an online marketplace for Somalia, connecting shoppers with local shops,
              pharmacies, wholesalers and suppliers — from electronics and clothing to medicine, food and
              construction materials.</p>
            </section>

            <section className="legal-card">
              <h2>For shoppers</h2>
              <p>Browse products from stores near you, compare prices across shops selling the same item, and
              pay the way you already do — with EVC Plus, ZAAD, SAHAL, eDahab or Premier Wallet through Sifalo
              Pay, or with cash on delivery. Filter by district to find what&apos;s closest to you.</p>
            </section>

            <section className="legal-card">
              <h2>For sellers</h2>
              <p>A {COMPANY} store is a complete shop system: an online storefront, a point-of-sale register
              for in-person sales (which keeps working offline), inventory and barcode scanning, a customer
              book with credit invoicing, staff accounts with per-permission access, and a dashboard covering
              sales, costs and profit.</p>
            </section>

            <section className="legal-card">
              <h2>For wholesalers</h2>
              <p>Suppliers sell in bulk to businesses, with tiered pricing so the unit price drops automatically
              as the order quantity rises.</p>
            </section>

            <section className="legal-card">
              <h2>Verified stores</h2>
              <p>Stores displaying a ✓ have had their business details reviewed by our team. Verification is a
              check of identity and legitimacy — it is not a guarantee of any particular product or transaction.</p>
            </section>

            <section className="legal-card">
              <h2>Get in touch</h2>
              <p>Questions, partnership enquiries, or want to sell on {COMPANY}?{' '}
              <a href="#/contact">Contact us</a>.</p>
            </section>

            <LegalFootNav current="about" />
          </article>
        ) : isContact ? (
          <article className="legal-doc">
            <LegalHero
              eyebrow="Support"
              title="Contact us"
              sub="We're here to help — whether you're a shopper with a question about an order or a business wanting to sell on Hamar Mall."
            />

            <section className="legal-card">
              <h2>Call or WhatsApp</h2>
              <p>The fastest way to reach us — same numbers for both.</p>
              <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
                {PHONES.map(p => (
                  <div key={p.e164} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <strong style={{ fontVariantNumeric: 'tabular-nums', minWidth: 150 }}>{p.display}</strong>
                    <a className="btn btn-secondary btn-sm" href={telHref(p)}>📞 Call</a>
                    <a
                      className="btn btn-primary btn-sm"
                      href={whatsappHref(p, WHATSAPP_GREETING)}
                      target="_blank"
                      // noreferrer with target=_blank: without it the new tab
                      // can reach back through window.opener.
                      rel="noopener noreferrer"
                    >
                      💬 WhatsApp
                    </a>
                  </div>
                ))}
              </div>
            </section>

            <section className="legal-card">
              <h2>Follow us</h2>
              <p>New stores, offers and updates.</p>
              <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                {SOCIALS.map(s => (
                  <a key={s.name} className="btn btn-secondary btn-sm"
                    href={s.url} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <SocialIcon social={s} /> {s.name} — @{s.handle}
                  </a>
                ))}
              </div>
            </section>

            <section className="legal-card">
              <h2>Email</h2>
              <p><a href={`mailto:${CONTACT}`}>{CONTACT}</a><br />
              <span className="legal-updated">We aim to reply within one business day.</span></p>
            </section>

            <section className="legal-card">
              <h2>In the app</h2>
              <p>Signed in? Message a store directly from its page, or open the{' '}
              <a href="#/chat">Chat</a> tab to continue a conversation. For help using {COMPANY}, the
              <strong> AI Assistant</strong> in the menu answers common questions in Somali and English.</p>
            </section>

            <section className="legal-card">
              <h2>Order problems</h2>
              <p>For anything about a specific order — delivery, a wrong or missing item, or a refund — please
              contact the <strong>store you bought from</strong> first, as they handle fulfilment. Their contact
              details are on their store page and your order page. If you can&apos;t reach them, email us and
              include your order number.</p>
            </section>

            <section className="legal-card">
              <h2>Reporting</h2>
              <p>To report a listing, a store, or suspected fraud, email us with the store or product link.
              See also our <a href="#/terms">Terms of Use</a>.</p>
            </section>

            <LegalFootNav current="contact" />
          </article>
        ) : isRefunds ? (
          <article className="legal-doc">
            <LegalHero
              eyebrow="Policy"
              title="Returns & Refunds"
              sub="How returns, exchanges and refunds work on Hamar Mall — and who handles them."
            />
            <p className="legal-updated">Last updated: {UPDATED}</p>

            <section className="legal-card">
              <h2>1. Who handles your refund</h2>
              <p>Each order is sold and fulfilled by an independent store on {COMPANY}. Returns, exchanges and
              refunds for an order are handled by <strong>that store</strong>, under the policy shown on its
              store page. {COMPANY} operates the marketplace and is not the merchant of record for order
              payments unless expressly stated.</p>
            </section>

            <section className="legal-card">
              <h2>2. How to request a refund</h2>
              <p>Contact the store directly from your order page or its store page, with your order number and
              the reason. If the store does not respond within a reasonable time, email{' '}
              <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we will try to help resolve it.</p>
            </section>

            <section className="legal-card">
              <h2>3. Damaged, wrong or missing items</h2>
              <p>Please check your order on delivery. Report a damaged, incorrect or missing item to the store
              as soon as possible, with photos where relevant.</p>
            </section>

            <section className="legal-card">
              <h2>4. Non-returnable items</h2>
              <p>For health and safety reasons, some goods cannot be returned once supplied or once the seal is
              broken — including medicines, and perishable food. This does not affect your rights where an item
              is faulty, expired, or not what was ordered.</p>
            </section>

            <section className="legal-card">
              <h2>5. Transaction fee</h2>
              <p>A {FEE_PCT} transaction fee applies to orders paid online, unless the store has chosen to cover
              it. Where a full refund is issued for an order, the transaction fee is refunded with it.</p>
            </section>

            <section className="legal-card">
              <h2>6. How refunds are returned</h2>
              <p>Refunds are returned to the wallet or payment method used for the order. Processing time
              depends on the payment provider. Cash-on-delivery orders are refunded by the store directly.</p>
            </section>

            <section className="legal-card">
              <h2>7. Seller subscriptions</h2>
              <p>Seller subscriptions have their own{' '}
              <strong>{SUBSCRIPTION_TRIAL_DAYS}-day money-back guarantee</strong>, described in section 4 of our{' '}
              <a href="#/terms">Terms of Use</a>. That guarantee covers the subscription fee only, not orders.</p>
            </section>

            <section className="legal-card">
              <h2>8. Contact</h2>
              <p>Questions about this policy: <a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
            </section>

            <LegalFootNav current="refunds" />
          </article>
        ) : isTerms ? (
          <article className="legal-doc">
            <LegalHero
              eyebrow="Legal"
              title="Terms of Use & Agreement"
              sub={`The terms for using ${COMPANY} — accounts, seller subscriptions, orders, and more.`}
            />
            <p className="legal-updated">Last updated: {UPDATED}</p>

            <section className="legal-card">
              <h2>1. Acceptance</h2>
              <p>By creating an account or using {COMPANY} (the “Service”) you agree to these Terms of Use. If you
              do not agree, do not use the Service. If you use the Service on behalf of a business, you confirm you
              are authorised to bind that business to these Terms.</p>
            </section>

            <section className="legal-card">
              <h2>2. Accounts</h2>
              <p>You are responsible for your account credentials and all activity under your account. Business and
              supplier accounts must provide accurate store, contact, and payout information and keep it up to date.</p>
            </section>

            <section className="legal-card">
              <h2>3. Seller subscription &amp; fees</h2>
              <p>Business and supplier accounts require a paid subscription to access the store dashboard and selling
              tools. The subscription fees are:</p>
              <ul>
                <li><strong>Business account — {BIZ} {SUBSCRIPTION_CURRENCY}</strong> per month.</li>
                <li><strong>Supplier account — {SUP} {SUBSCRIPTION_CURRENCY}</strong> per month.</li>
              </ul>
              <p>The fee is charged when you activate your store, through the displayed mobile-money payment method
              (Sifalo Pay — EVC Plus / ZAAD / SAHAL, eDahab, or Premier Wallet). Customer (“shopper”) and field-agent
              accounts are free. Fees are stated in {SUBSCRIPTION_CURRENCY} and exclude any charges levied by your
              wallet provider. We may change fees on notice; changes apply to your next billing cycle.</p>
              <p><strong>Each payment covers a {SUBSCRIPTION_PERIOD_DAYS}-day billing period.</strong> Subscriptions do
              not auto-renew — we never charge your wallet without you starting the payment. Your Billing page shows
              when the current month ends and warns you in the final days. If it ends without a renewal, the store
              dashboard is locked until you pay again; your data is kept. Renewing early adds
              {' '}{SUBSCRIPTION_PERIOD_DAYS} days to the time you already have rather than replacing it.</p>
            </section>

            <section className="legal-card">
              <h2>4. {SUBSCRIPTION_TRIAL_DAYS}-day money-back guarantee</h2>
              <p>Every seller subscription includes a <strong>{SUBSCRIPTION_TRIAL_DAYS}-day money-back guarantee</strong>.
              You may request a full refund of your subscription fee at any time within {SUBSCRIPTION_TRIAL_DAYS} days
              of payment, directly from the Billing page — no reason required.{' '}
              <strong>After {SUBSCRIPTION_TRIAL_DAYS} days the payment is non-refundable.</strong> When a refund is issued, your subscription is cancelled and
              store-dashboard access is locked until you pay again. Refunds are returned to the wallet used for payment;
              processing times depend on the payment provider. This guarantee applies to the subscription fee only and
              not to any other charges, order payments, or third-party fees.</p>
            </section>

            <section className="legal-card">
              <h2>5. Non-payment &amp; suspension</h2>
              <p>If a subscription is unpaid, expired, or refunded, the store dashboard, point-of-sale, and selling
              features are locked until payment is made. Your public storefront may also be hidden while inactive.
              Data is retained per Section 9 during any locked period.</p>
            </section>

            <section className="legal-card">
              <h2>6. Orders &amp; payments</h2>
              <p>Prices and availability are set by sellers and may change. Orders are confirmed once placed and are
              priced server-side. Order payments are handled by the displayed payment method/processor; {COMPANY} is
              not the merchant of record for order transactions unless expressly stated.</p>
            </section>

            <section className="legal-card">
              <h2>7. Seller responsibilities</h2>
              <p>Sellers are responsible for their listings, stock accuracy, fulfilment and delivery, customer service,
              taxes (including any VAT), and compliance with applicable law.</p>
            </section>

            <section className="legal-card">
              <h2>8. Prohibited use</h2>
              <p>No unlawful, fraudulent, infringing, or abusive activity; no manipulation of pricing, balances,
              reviews, referrals, or fees; and no attempts to disrupt or gain unauthorised access to the Service.</p>
            </section>

            <section className="legal-card">
              <h2>9. Data &amp; privacy</h2>
              <p>Your use of the Service is also governed by our <a href="#/privacy">Privacy Policy</a>. We retain
              account and transaction records as required for accounting and legal obligations.</p>
            </section>

            <section className="legal-card">
              <h2>10. Liability</h2>
              <p>The Service is provided “as is”. To the extent permitted by law, {COMPANY} is not liable for indirect,
              incidental, or consequential damages, and our total liability for any claim relating to the subscription
              is limited to the fees you paid in the {SUBSCRIPTION_TRIAL_DAYS} days before the claim.</p>
            </section>

            <section className="legal-card">
              <h2>11. Changes</h2>
              <p>We may update these Terms; we will post the updated date above, and continued use after changes take
              effect constitutes acceptance.</p>
            </section>

            <section className="legal-card">
              <h2>12. Contact</h2>
              <p>Questions about these Terms or billing: <a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
            </section>

            <LegalFootNav current="terms" />
          </article>
        ) : (
          <article className="legal-doc">
            <LegalHero
              eyebrow="Legal"
              title="Privacy Policy"
              sub={`What ${COMPANY} collects, how we use it, and the choices you have.`}
            />
            <p className="legal-updated">Last updated: {UPDATED}</p>

            <section className="legal-card">
              <h2>1. What we collect</h2>
              <p>Account details (name, email, phone), profile and store information, orders and transaction
              history, messages you send, optional delivery location (GPS) you choose to share, and basic device/log data.</p>
              <p><strong>Optional gender and year of birth.</strong> Shoppers may give these when signing up or in
              their profile. They are never required, you can change or remove them at any time from
              Profile → Edit, and leaving them blank does not limit your use of {COMPANY} in any way.</p>
            </section>

            <section className="legal-card">
              <h2>2. How we use it</h2>
              <p>To operate the marketplace: authenticate you, process and track orders, enable buyer–seller
              messaging, show store locations/directions you opt into, prevent abuse, and improve the service.</p>
              <p>If you provided gender or year of birth, we also use them to decide which products, offers and
              advertising to show you, and to understand our audience in aggregate (for example &ldquo;how many
              shoppers are 25–34&rdquo;). We do not sell this data, and we do not share it with advertisers in a
              form that identifies you.</p>
            </section>

            <section className="legal-card">
              <h2>3. Sharing</h2>
              <p>Order and contact details are shared with the relevant seller to fulfil your order. We use
              processors (e.g. Supabase for database/auth/storage, the payment provider, and hosting) under their
              respective terms. We do not sell your personal data.</p>
            </section>

            <section className="legal-card">
              <h2>4. Location</h2>
              <p>Location is captured only when you tap to share it (checkout delivery point or a store’s map pin)
              and is used to show addresses/routes. You can decline at the browser prompt.</p>
            </section>

            <section className="legal-card">
              <h2>5. Retention &amp; your rights</h2>
              <p>We keep data while your account is active and as required for records/legal obligations. You may
              request access, correction, or deletion by contacting us.</p>
            </section>

            <section className="legal-card">
              <h2>6. Security</h2>
              <p>Passwords are hashed; access to data is restricted. No method is 100% secure, but we take
              reasonable measures to protect your information.</p>
            </section>

            <section className="legal-card">
              <h2>7. Contact</h2>
              <p>Privacy questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
            </section>

            <LegalFootNav current="privacy" />
          </article>
        )}
      </div>
    </div>
  );
}
