'use client';

import { useEffect, useMemo, useState } from 'react';
import Header from '@/components/Header';
import { Link, useRouter } from '@/lib/hashRouter';
import { useAuth } from '@/context/AuthContext';
import { authHeaders } from '@/lib/clientAuth';
import {
  deriveSubscription, planLabel, SUBSCRIPTION_TRIAL_DAYS, SUBSCRIPTION_CURRENCY,
  SUBSCRIPTION_PERIOD_DAYS, SUBSCRIPTION_NOTICE_DAYS,
} from '@/lib/subscription';
import type { SifaloGateway } from '@/lib/types';

/** `grant` = a comped period (e.g. the free month when billing launched). No
 *  money moved, so it is never shown as a payment. */
interface Receipt { id: number; kind: 'payment' | 'refund' | 'grant'; amount: number; plan: string | null; method: string | null; createdAt: string; note?: string | null; }

const RECEIPT_LABEL: Record<Receipt['kind'], { icon: string; text: string }> = {
  payment: { icon: '💳', text: 'Payment' },
  refund:  { icon: '↩️', text: 'Refund'  },
  grant:   { icon: '🎁', text: 'Free month' },
};

const GATEWAYS: { value: SifaloGateway; label: string }[] = [
  { value: 'waafi',    label: 'EVC Plus / ZAAD / SAHAL (Waafi)' },
  { value: 'edahab',   label: 'eDahab' },
  { value: 'pbwallet', label: 'Premier Wallet' },
];

function money(n: number | null | undefined): string {
  return n == null ? '—' : `$${n.toFixed(2)}`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

export default function BillingView() {
  const router = useRouter();
  const { user, loading, accountType, currentSupplier, refreshAccount } = useAuth();

  const [account, setAccount]   = useState('');
  const [gateway, setGateway]   = useState<SifaloGateway>('waafi');
  const [busy,    setBusy]      = useState(false);
  const [error,   setError]     = useState('');
  const [notice,  setNotice]    = useState('');
  const [events,  setEvents]    = useState<Receipt[]>([]);
  const [showRenew, setShowRenew] = useState(false);

  // Subscription state is derived from the live supplier record in context.
  const sub = useMemo(() => deriveSubscription(currentSupplier), [currentSupplier]);
  const supplierId = currentSupplier?.id;

  // Load receipt history (best-effort; needs the migration).
  useEffect(() => {
    if (!supplierId) return;
    (async () => {
      try {
        const res = await fetch(`/api/subscriptions?supplierId=${supplierId}`, { headers: await authHeaders() });
        if (res.ok) { const d = await res.json(); setEvents(Array.isArray(d.events) ? d.events : []); }
      } catch { /* ignore */ }
    })();
  }, [supplierId, sub.status]);

  if (loading) {
    return <div className="page-anim"><Header showSearch={false} /><div className="empty-state" style={{ marginTop: 80 }}><div className="spinner" style={{ width: 28, height: 28 }} /></div></div>;
  }

  // Signed-out or an account type that never pays.
  if (!user || !currentSupplier || !sub.requiresSubscription) {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div className="legal-wrap">
          <button className="auth-back-btn" onClick={() => router.back()}>← Back</button>
          <div className="empty-state" style={{ marginTop: 40 }}>
            <div style={{ fontSize: '2.4rem', marginBottom: 10 }}>🧾</div>
            <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: 6 }}>No subscription needed</div>
            <div style={{ color: 'var(--text-muted)' }}>
              {user ? 'This account doesn’t require a paid store subscription.' : 'Sign in with a business or supplier account to manage billing.'}
            </div>
            {!user && <Link href="/auth/login" className="btn btn-primary" style={{ marginTop: 16 }}>Sign in →</Link>}
          </div>
        </div>
      </div>
    );
  }

  async function pay() {
    if (!supplierId) return;
    if (!account.trim()) { setError('Enter the wallet number to charge.'); return; }
    setError(''); setNotice(''); setBusy(true);
    try {
      const res = await fetch('/api/subscriptions', {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ supplierId, account: account.trim(), gateway }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || 'Payment failed. Please try again.'); return; }
      const until = d.periodEnd ? ` Your store is paid through ${fmtDate(d.periodEnd)}.` : ' Your store is now active.';
      setNotice((d.mock ? 'Payment approved (test mode — no live charge yet).' : 'Payment approved.') + until);
      setShowRenew(false);
      setAccount('');
      await refreshAccount().catch(() => {});
    } catch { setError('Network error. Please try again.'); }
    finally { setBusy(false); }
  }

  async function refund() {
    if (!supplierId) return;
    if (!confirm(`Request a full refund of ${money(sub.price)}? Your store access will be locked until you pay again.`)) return;
    setError(''); setNotice(''); setBusy(true);
    try {
      const res = await fetch('/api/subscriptions', {
        method: 'PATCH',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ supplierId, action: 'refund' }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || 'Refund could not be processed.'); return; }
      setNotice('Refund recorded. Your subscription has been cancelled and access is now locked.');
      await refreshAccount().catch(() => {});
    } catch { setError('Network error. Please try again.'); }
    finally { setBusy(false); }
  }

  const badge = sub.status === 'active'     ? { t: 'Active',             c: 'var(--success, #16a34a)' }
              : sub.status === 'refundable' ? { t: 'Active · money-back', c: 'var(--success, #16a34a)' }
              : sub.status === 'expired'    ? { t: 'Expired · renew now', c: 'var(--danger, #dc2626)' }
              : sub.status === 'refunded'   ? { t: 'Refunded · locked',   c: 'var(--danger, #dc2626)' }
              :                               { t: 'Payment required',    c: 'var(--danger, #dc2626)' };

  // Warn while there's still time to act, not after the store is already locked.
  const renewSoon = !sub.locked && sub.daysLeftInPeriod > 0 && sub.daysLeftInPeriod <= SUBSCRIPTION_NOTICE_DAYS;

  // The same wallet + gateway inputs serve first payment and renewal.
  const payForm = (
    <>
      <div className="form-group" style={{ marginTop: 8 }}>
        <label className="form-label">Pay from wallet number</label>
        <input className="form-input" inputMode="tel" placeholder="e.g. 2526XXXXXXXX"
          value={account} onChange={e => setAccount(e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">Payment method</label>
        <select className="form-input" value={gateway} onChange={e => setGateway(e.target.value as SifaloGateway)}>
          {GATEWAYS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
      </div>
    </>
  );

  return (
    <div className="page-anim">
      <Header showSearch={false} />
      <div className="legal-wrap" style={{ maxWidth: 560 }}>
        <button className="auth-back-btn" onClick={() => router.back()}>← Back</button>

        <h1 style={{ fontSize: '1.5rem', margin: '4px 0 2px' }}>Store subscription</h1>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          {planLabel(sub.plan)} plan · <strong>{money(sub.price)}</strong> / month · billed every {SUBSCRIPTION_PERIOD_DAYS} days
          {' '}· {SUBSCRIPTION_TRIAL_DAYS}-day money-back guarantee
        </p>

        {/* Status card */}
        <div className="card" style={{ padding: 18, marginTop: 14, borderRadius: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700 }}>Status</span>
            <span style={{ marginLeft: 'auto', fontWeight: 700, color: badge.c, fontSize: '.9rem' }}>● {badge.t}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14, fontSize: '.9rem' }}>
            <div><div style={{ color: 'var(--text-muted)' }}>Plan</div><div style={{ fontWeight: 600 }}>{planLabel(sub.plan)}</div></div>
            <div><div style={{ color: 'var(--text-muted)' }}>Fee</div><div style={{ fontWeight: 600 }}>{money(sub.price)} {SUBSCRIPTION_CURRENCY} / month</div></div>
            {sub.paidAt && <div><div style={{ color: 'var(--text-muted)' }}>Last paid</div><div style={{ fontWeight: 600 }}>{fmtDate(sub.paidAt)}</div></div>}
            {sub.periodEnd && (
              <div>
                <div style={{ color: 'var(--text-muted)' }}>{sub.locked ? 'Expired on' : 'Next payment due'}</div>
                <div style={{ fontWeight: 600, color: sub.locked ? 'var(--danger, #dc2626)' : undefined }}>
                  {fmtDate(sub.periodEnd)}
                  {!sub.locked && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {sub.daysLeftInPeriod}d left</span>}
                </div>
              </div>
            )}
            {sub.refundable && <div><div style={{ color: 'var(--text-muted)' }}>Money-back until</div><div style={{ fontWeight: 600 }}>{fmtDate(sub.refundDeadline)}</div></div>}
          </div>
        </div>

        {renewSoon && (
          <div className="card" style={{ marginTop: 14, padding: '12px 14px', borderRadius: 12, fontSize: '.88rem' }}>
            ⏳ Your month ends in <strong>{sub.daysLeftInPeriod} day{sub.daysLeftInPeriod === 1 ? '' : 's'}</strong> ({fmtDate(sub.periodEnd)}).
            Renew below to keep your dashboard open — paying early adds {SUBSCRIPTION_PERIOD_DAYS} days on top of the time you have left.
          </div>
        )}

        {error  && <div className="auth-error" style={{ marginTop: 14 }}>{error}</div>}
        {notice && <div className="card" style={{ marginTop: 14, padding: 14, borderRadius: 12, background: 'var(--success-bg, #dcfce7)', color: 'var(--success-text, #166534)', fontSize: '.9rem' }}>{notice}</div>}

        {/* ── LOCKED (never paid / expired / refunded): pay to unlock ── */}
        {sub.locked ? (
          <div className="card" style={{ padding: 18, marginTop: 14, borderRadius: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              {sub.status === 'refunded' ? 'Reactivate your store'
                : sub.status === 'expired' ? 'Renew your subscription'
                : 'Activate your store'}
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '.9rem', marginTop: 0 }}>
              {sub.status === 'expired'
                ? <>Your paid month ended on <strong>{fmtDate(sub.periodEnd)}</strong>. Pay the {planLabel(sub.plan)} fee
                    of <strong>{money(sub.price)}</strong> for another {SUBSCRIPTION_PERIOD_DAYS} days of dashboard access.</>
                : <>Pay the {planLabel(sub.plan)} fee of <strong>{money(sub.price)}</strong> to unlock your dashboard
                    for {SUBSCRIPTION_PERIOD_DAYS} days. You can request a full refund any time within {SUBSCRIPTION_TRIAL_DAYS} days.</>}
            </p>

            {payForm}

            <button className="btn btn-primary btn-full btn-lg" onClick={pay} disabled={busy || !account.trim()}>
              {busy ? <><span className="btn-spinner" /> Processing…</>
                    : `Pay ${money(sub.price)} & ${sub.status === 'expired' ? 'renew' : 'activate'} →`}
            </button>
            <p style={{ fontSize: '.78rem', color: 'var(--text-muted)', marginTop: 10, textAlign: 'center' }}>
              By paying you agree to the <Link href="/terms">Terms of Use</Link>. Secured by Sifalo Pay.
            </p>
          </div>
        ) : (
          /* ── ACTIVE: renew / manage / refund ── */
          <>
            <div className="card" style={{ padding: 18, marginTop: 14, borderRadius: 14 }}>
              {sub.refundable ? (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>Money-back guarantee active</div>
                  <p style={{ color: 'var(--text-muted)', fontSize: '.9rem', marginTop: 0 }}>
                    You have <strong>{sub.daysLeftToRefund} day{sub.daysLeftToRefund === 1 ? '' : 's'}</strong> left to request a full refund
                    (until {fmtDate(sub.refundDeadline)}). After that the subscription is non-refundable.
                  </p>
                  <button className="btn btn-ghost btn-full" onClick={refund} disabled={busy}
                    style={{ marginTop: 6, color: 'var(--danger, #dc2626)' }}>
                    {busy ? 'Processing…' : `Request full refund (${money(sub.price)})`}
                  </button>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>Subscription active</div>
                  <p style={{ color: 'var(--text-muted)', fontSize: '.9rem', marginTop: 0 }}>
                    The {SUBSCRIPTION_TRIAL_DAYS}-day money-back window has passed, so this month&apos;s payment is non-refundable.
                    {sub.periodEnd && <> Your dashboard stays open until <strong>{fmtDate(sub.periodEnd)}</strong>.</>}
                  </p>
                  <Link href="/my-dashboard" className="btn btn-primary btn-full" style={{ marginTop: 6 }}>Go to dashboard →</Link>
                </>
              )}
            </div>

            {/* Pay the next month before it lapses — the days left are kept. */}
            <div className="card" style={{ padding: 18, marginTop: 14, borderRadius: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>Renew early</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '.85rem', marginTop: 2 }}>
                    Add another {SUBSCRIPTION_PERIOD_DAYS} days for {money(sub.price)}
                    {sub.periodEnd && <> — starting {fmtDate(sub.periodEnd)}, not today</>}.
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
                  onClick={() => setShowRenew(v => !v)} aria-expanded={showRenew}>
                  {showRenew ? 'Cancel' : 'Renew now'}
                </button>
              </div>

              {showRenew && (
                <>
                  {payForm}
                  <button className="btn btn-primary btn-full" onClick={pay} disabled={busy || !account.trim()}>
                    {busy ? <><span className="btn-spinner" /> Processing…</> : `Pay ${money(sub.price)} & extend →`}
                  </button>
                  <p style={{ fontSize: '.78rem', color: 'var(--text-muted)', marginTop: 10, textAlign: 'center' }}>
                    By paying you agree to the <Link href="/terms">Terms of Use</Link>. Secured by Sifalo Pay.
                  </p>
                </>
              )}
            </div>
          </>
        )}

        {/* Receipts */}
        {events.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div className="form-label" style={{ marginBottom: 8 }}>Billing history</div>
            <div className="card" style={{ borderRadius: 12, overflow: 'hidden' }}>
              {events.map(ev => {
                const meta = RECEIPT_LABEL[ev.kind] ?? { icon: '•', text: ev.kind };
                return (
                  <div key={ev.id} style={{ display: 'flex', gap: 10, padding: '11px 14px', borderBottom: '1px solid var(--border, #e5e7eb)', fontSize: '.88rem' }}>
                    <span>{meta.icon}</span>
                    <span>{meta.text}</span>
                    <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>{fmtDate(ev.createdAt)}</span>
                    <span style={{ fontWeight: 700, color: ev.kind === 'refund' ? 'var(--danger, #dc2626)' : 'inherit', minWidth: 64, textAlign: 'right' }}>
                      {ev.kind === 'grant' ? 'Free' : `${ev.kind === 'refund' ? '−' : ''}${money(ev.amount)}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
