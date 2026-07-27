'use client';

import { Link, usePathname } from '@/lib/hashRouter';
import { useAuth } from '@/context/AuthContext';
import { useCashier } from '@/context/CashierContext';
import { roleFor, isBusinessRoute } from '@/lib/roles';
import type { Role } from '@/lib/roles';
import {
  PHONES, SOCIALS, telHref, whatsappHref, WHATSAPP_GREETING,
} from '@/lib/contactInfo';

/**
 * Site footer — the app had none, so the policy pages it links to were
 * effectively unreachable.
 *
 * Hidden on the full-screen working surfaces (POS, chat rooms, checkout) where
 * a marketing footer would just be in the way, and on the auth screens.
 *
 * Link visibility follows the same convention as Sidebar / BottomNav:
 * `roleFor(!!user, accountType)` (with a cashier override) decides the
 * audience, and business-only routes are filtered out for non-business roles.
 * So a guest or a customer never sees "Store Dashboard" or "Billing".
 */

type FooterLink = { href: string; label: string };

const SHOP_LINKS: FooterLink[] = [
  { href: '/',         label: 'Explore' },
  { href: '/search',   label: 'Search' },
  { href: '/orders',   label: 'My Orders' },
  { href: '/wishlist', label: 'Wishlist' },
];

const SELL_LINKS: FooterLink[] = [
  { href: '/auth/signup',   label: 'Sell on Hamar Mall' },
  { href: '/my-dashboard',  label: 'Store Dashboard' },
  { href: '/suppliers',     label: 'Wholesale Suppliers' },
  { href: '/billing',       label: 'Billing' },
];

const INFO_LINKS: FooterLink[] = [
  { href: '/about',    label: 'About Us' },
  { href: '/contact',  label: 'Contact' },
  { href: '/refunds',  label: 'Returns & Refunds' },
  { href: '/privacy',  label: 'Privacy Policy' },
  { href: '/terms',    label: 'Terms of Use' },
];

/** Routes that get the whole screen — no footer. */
const HIDE_ON = ['/pos', '/chat/', '/checkout', '/auth/', '/admin', '/cashier-login', '/payment/'];

/**
 * Decide whether a footer link should be shown to a given role.
 * - Business-only routes (dashboard, POS, inventory, …) → business role only,
 *   matching the Sidebar/Header filter. `/my-dashboard` and `/billing` are
 *   selling tools, so they follow the same rule.
 * - `/suppliers` (wholesale sourcing) and `/billing` are also seller pages —
 *   hidden from guests and plain customers.
 * - `/auth/signup` ("Sell on Hamar Mall") is shown to everyone who isn't yet a
 *   seller: guests, customers. A signed-in business/supplier already sells.
 */
function showLink(href: string, role: Role): boolean {
  // Store-operations routes — business only (mirrors isBusinessRoute filter).
  if (isBusinessRoute(href)) return role === 'business';

  // Seller-only pages that aren't in BUSINESS_PREFIXES.
  if (href === '/billing') return role === 'business' || role === 'supplier';
  if (href === '/suppliers') return role === 'business' || role === 'supplier';

  // "Sell on Hamar Mall" — only relevant to non-sellers.
  if (href === '/auth/signup') return role === 'guest' || role === 'customer';

  return true;
}

export default function Footer() {
  // EVERY hook must run before the hidden-route early return below. Bailing
  // out first made useAuth/useCashier conditional, so moving between a hidden
  // route (/auth/*, /pos, /admin…) and a normal one changed the hook count on
  // the same instance — React's "change in the order of Hooks" error.
  const pathname = usePathname() ?? '/';
  const { user, accountType } = useAuth();
  const { cashier } = useCashier();

  // A cashier session governs even if a stale owner session lingers — same
  // rule the rest of the nav uses, so a cashier sees the business links.
  const role = cashier ? 'business' : roleFor(!!user, accountType);

  const sellLinks = SELL_LINKS.filter(l => showLink(l.href, role));

  if (HIDE_ON.some(p => pathname.startsWith(p))) return null;

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <div className="site-footer-logo">
            <svg viewBox="0 0 28 28" fill="none" width="26" height="26" aria-hidden="true">
              <rect width="28" height="28" rx="8" fill="currentColor" opacity=".15" />
              <path d="M7 10h14M7 14h14M7 18h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>Hamar Mall</span>
          </div>
          <p className="site-footer-tagline">
            Somalia&apos;s marketplace — shop from local stores, or run your own with a full point-of-sale
            and online storefront.
          </p>

          {/* Contact + socials. Sitewide because "how do I reach a human"
              is the question that decides whether someone buys. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
            {PHONES.map(p => (
              <div key={p.e164} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '.85rem' }}>
                <a href={telHref(p)} style={{ fontVariantNumeric: 'tabular-nums' }}>📞 {p.display}</a>
                <a href={whatsappHref(p, WHATSAPP_GREETING)} target="_blank" rel="noopener noreferrer">
                  💬 WhatsApp
                </a>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 10, fontSize: '.85rem' }}>
            {SOCIALS.map(s => (
              <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer"
                aria-label={`${s.name} — @${s.handle}`}>
                {s.icon} {s.name}
              </a>
            ))}
          </div>
        </div>

        <nav className="site-footer-col" aria-label="Shopping links">
          <h3>Shop</h3>
          {SHOP_LINKS.map(l => <Link key={l.href} href={l.href}>{l.label}</Link>)}
        </nav>

        {sellLinks.length > 0 && (
          <nav className="site-footer-col" aria-label="Selling links">
            <h3>Sell</h3>
            {sellLinks.map(l => <Link key={l.href} href={l.href}>{l.label}</Link>)}
          </nav>
        )}

        <nav className="site-footer-col" aria-label="Information links">
          <h3>Company</h3>
          {INFO_LINKS.map(l => <Link key={l.href} href={l.href}>{l.label}</Link>)}
        </nav>
      </div>

      <div className="site-footer-bottom">
        <span>© {new Date().getFullYear()} Hamar Mall. All rights reserved.</span>
        <span className="site-footer-pay">
          Pay with EVC Plus · ZAAD · SAHAL · eDahab · Premier Wallet · Cash
        </span>
      </div>
    </footer>
  );
}
