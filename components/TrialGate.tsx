'use client';

import type { ReactNode } from 'react';
import { usePathname, Link } from '@/lib/hashRouter';
import { useAuth } from '@/context/AuthContext';
import { isBusinessRoute } from '@/lib/roles';
import { deriveSubscription, planLabel, SUBSCRIPTION_TRIAL_DAYS } from '@/lib/subscription';

/**
 * Subscription gate.
 *
 * Business & supplier accounts must have an active paid subscription to use the
 * store dashboard. When they don't (never paid, or refunded within the
 * money-back window), the seller working routes are replaced with a lock screen
 * that sends them to Billing. Every other route — storefront, explore, profile,
 * and Billing itself — stays open so they can always reach the pay screen.
 *
 * Agents, customers, guests, and grandfathered stores are never locked.
 */

/** Seller routes that require an active subscription. */
function isGatedRoute(path: string): boolean {
  return isBusinessRoute(path) || path === '/orders' || path.startsWith('/orders/');
}

export default function TrialGate({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { loading, currentSupplier } = useAuth();

  const sub = deriveSubscription(currentSupplier);

  // Don't flash the lock while auth is still restoring, and never gate the
  // billing page or any non-seller route.
  if (loading || !sub.locked || !isGatedRoute(path)) {
    return <>{children}</>;
  }

  const refunded = sub.status === 'refunded';
  const expired  = sub.status === 'expired';

  return (
    <div className="page-anim" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      minHeight: '70dvh', gap: 14, padding: '32px 24px', textAlign: 'center',
    }}>
      <div style={{ fontSize: '2.6rem' }}>🔒</div>
      <div style={{ fontWeight: 800, fontSize: '1.3rem' }}>
        {refunded ? 'Subscription cancelled' : expired ? 'Monthly subscription expired' : 'Activate your store'}
      </div>
      <div style={{ color: 'var(--text-muted)', maxWidth: 420, lineHeight: 1.6 }}>
        {refunded
          ? 'Your subscription was refunded, so the dashboard is locked. Pay the '
          : expired
            ? 'Your paid month has ended, so the dashboard is locked. Renew the '
            : 'Your store dashboard is locked until you start your subscription. Pay the '}
        <strong>{planLabel(sub.plan)}</strong> fee of <strong>${sub.price?.toFixed(2)}</strong>
        {expired
          ? ' to reopen it for another month.'
          : <> to unlock it — with a full {SUBSCRIPTION_TRIAL_DAYS}-day money-back guarantee.</>}
      </div>
      <Link href="/billing" className="btn btn-primary btn-lg" style={{ marginTop: 6 }}>
        {refunded ? 'Reactivate for' : expired ? 'Renew for' : 'Pay'} ${sub.price?.toFixed(2)} →
      </Link>
      <Link href="/" style={{ color: 'var(--text-muted)', fontSize: '.85rem' }}>← Back to shop</Link>
    </div>
  );
}
