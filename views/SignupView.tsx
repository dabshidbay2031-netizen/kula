'use client';

import { useState } from 'react';
import { Link } from '@/lib/hashRouter';
import { useRouter } from '@/lib/hashRouter';
import { getSupabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { SUBSCRIPTION_PRICES, SUBSCRIPTION_TRIAL_DAYS } from '@/lib/subscription';

type Method   = 'email' | 'google';
type AcctType = 'user' | 'business' | 'supplier' | 'agent';

/* Email-specific steps */
type EmailStep = 'type' | 'details' | 'done';
/* Google-specific steps */
type GoogleStep = 'type' | 'name';

export default function SignupPage() {
  const router = useRouter();
  const { refreshAccount } = useAuth();

  /* ── Shared state ────────────────────────────── */
  const [method,    setMethod]    = useState<Method | null>(null);
  const [acctType,  setAcctType]  = useState<AcctType>('user');
  const [name,      setName]      = useState('');
  const [error,     setError]     = useState('');
  const [loading,   setLoading]   = useState(false);

  /* ── Email state ─────────────────────────────── */
  const [emailStep,   setEmailStep]   = useState<EmailStep>('type');
  const [email,       setEmail]       = useState('');
  const [password,    setPassword]    = useState('');
  const [password2,   setPassword2]   = useState('');
  const [showPass,    setShowPass]    = useState(false);
  const [emailSent,   setEmailSent]   = useState(false);

  /* ── Google state ────────────────────────────── */
  const [googleStep, setGoogleStep] = useState<GoogleStep>('type');

  /* ── Terms agreement (required to create any account) ── */
  const [agreed, setAgreed] = useState(false);

  /* Seller plans pay a subscription; customers & agents are free. */
  const planFee = acctType === 'supplier' ? SUBSCRIPTION_PRICES.supplier
                : acctType === 'business' ? SUBSCRIPTION_PRICES.business
                : null;

  /* ── Helpers ─────────────────────────────────── */
  async function createRecord(uid: string, userName: string, userPhone = '') {
    if (acctType === 'business' || acctType === 'supplier' || acctType === 'agent') {
      await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: userName.trim(), authUserId: uid, accountType: acctType }),
      });
    } else {
      await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: uid, fullName: userName.trim(), phone: userPhone, avatar: '👤' }),
      });
    }
  }

  /* ══════════════════════════════════════════════
     EMAIL FLOW
  ══════════════════════════════════════════════ */
  async function handleEmailSignup() {
    if (!name.trim())     { setError(`Enter your ${acctType === 'business' ? 'business' : acctType === 'supplier' ? 'supplier' : acctType === 'agent' ? 'agent' : 'full'} name`); return; }
    if (!email.trim())    { setError('Enter your email address'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (password !== password2) { setError('Passwords do not match'); return; }
    setError(''); setLoading(true);

    const { data, error: err } = await getSupabase().auth.signUp({
      email:    email.trim(),
      password,
      options: {
        data: { full_name: name.trim() },
      },
    });

    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }

    const uid = data.user?.id;
    if (!uid) { setError('Signup failed. Please try again.'); setLoading(false); return; }

    await createRecord(uid, name);

    if (data.session) {
      // Email confirmation disabled — user is logged in immediately.
      // AuthContext resolved the account BEFORE the supplier record above
      // existed (it saw a plain customer) — re-resolve now, or a fresh
      // business/supplier lands on the CUSTOMER UI until a manual refresh.
      await refreshAccount().catch(() => {});
      // A new seller's next step is paying for the store — send them straight
      // to Billing instead of a profile page they have no reason to visit yet.
      router.push(acctType === 'business' || acctType === 'supplier' ? '/billing' : '/profile');
    } else {
      // Email confirmation required — show "check email" message
      setEmailSent(true);
      setEmailStep('done');
    }
    setLoading(false);
  }

  /* ══════════════════════════════════════════════
     GOOGLE FLOW
  ══════════════════════════════════════════════ */
  async function handleGoogleSignup() {
    if (!name.trim()) { setError(`Enter your ${acctType === 'business' ? 'business' : acctType === 'supplier' ? 'supplier' : acctType === 'agent' ? 'agent' : 'full'} name`); return; }
    setError(''); setLoading(true);

    // The chosen account type has to survive a full round trip to Google. It
    // rides in the RETURN URL, which Supabase preserves — localStorage does not
    // survive an origin change (a different port/domain, or a Site-URL
    // fallback), and losing it silently created a CUSTOMER account for someone
    // who asked for a store. localStorage is kept only as a secondary copy.
    const params = new URLSearchParams({ type: acctType, name: name.trim() });
    localStorage.setItem('mogarenta_pending_oauth', JSON.stringify({
      accountType: acctType,
      name:        name.trim(),
    }));

    const { error: err } = await getSupabase().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?${params}` },
    });

    if (err) {
      localStorage.removeItem('mogarenta_pending_oauth');
      setError(err.message);
      setLoading(false);
    }
    // On success, browser is redirected — no further action needed
  }

  const acctIcon = acctType === 'business' ? '🏪' : acctType === 'supplier' ? '🏭' : acctType === 'agent' ? '📋' : '👤';

  /* Fee disclosure + Terms checkbox, shared by the Email and Google flows. */
  const agreeBlock = (
    <>
      {planFee != null && (
        <div className="card" style={{ padding: '12px 14px', borderRadius: 10, margin: '4px 0 12px', fontSize: '.85rem', lineHeight: 1.5 }}>
          💳 The {acctType === 'supplier' ? 'Supplier' : 'Business'} plan is <strong>${planFee.toFixed(2)}/month</strong>,
          charged when you activate your store — with a <strong>{SUBSCRIPTION_TRIAL_DAYS}-day money-back guarantee</strong>.
          You can create your account now and pay from the Billing page.
        </div>
      )}
      <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: '.85rem', margin: '2px 0 14px', cursor: 'pointer' }}>
        <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: 3, flexShrink: 0 }} />
        <span>I agree to the <Link href="/terms">Terms of Use</Link> and <Link href="/privacy">Privacy Policy</Link>.</span>
      </label>
    </>
  );

  /* ── Method selector ─────────────────────────── */
  if (!method) {
    return (
      <div className="page-anim auth-wrap">
        <div className="auth-logo">
          <div className="auth-logo-icon">🏪</div>
          <div className="auth-logo-title">Hamar Mall</div>
          <div className="auth-logo-sub">Create your account</div>
        </div>

        <div className="auth-card">
          <div className="auth-card-title">How would you like to sign up?</div>
          <div className="auth-card-sub">Choose your preferred method</div>

          <div className="auth-method-list">
            <button className="auth-method-btn" onClick={() => { setMethod('email'); setEmailStep('type'); }}>
              <span className="auth-method-icon">✉️</span>
              <div className="auth-method-info">
                <div className="auth-method-label">Email & Password</div>
                <div className="auth-method-sub">Sign up with your email address</div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
            </button>

            <button className="auth-method-btn" onClick={() => { setMethod('google'); setGoogleStep('type'); }}>
              <span className="auth-method-icon">
                <svg width="22" height="22" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
              </span>
              <div className="auth-method-info">
                <div className="auth-method-label">Continue with Google</div>
                <div className="auth-method-sub">Quick one-tap sign up</div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          </div>
        </div>

        <div className="auth-switch">
          Already have an account? <Link href="/auth/login">Sign in</Link>
        </div>
        <div className="auth-switch" style={{ marginTop: 6 }}>
          <Link href="/" style={{ color: 'var(--text-muted)', fontSize: '.82rem' }}>← Back to shop</Link>
        </div>
      </div>
    );
  }

  /* ════════════════════════════════════════════════════
     EMAIL FLOW
  ════════════════════════════════════════════════════ */
  if (method === 'email') {
    return (
      <div className="page-anim auth-wrap">
        <div className="auth-logo">
          <div className="auth-logo-icon">{acctIcon}</div>
          <div className="auth-logo-title">Hamar Mall</div>
          <div className="auth-logo-sub">Sign up with Email</div>
        </div>

        {/* Email confirmation sent screen */}
        {emailSent ? (
          <div className="auth-card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '3rem', marginBottom: 12 }}>📧</div>
            <div className="auth-card-title">Check your email</div>
            <div className="auth-card-sub" style={{ marginBottom: 20 }}>
              We sent a confirmation link to<br /><strong>{email}</strong>
            </div>
            <div style={{ fontSize: '.83rem', color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.6 }}>
              Click the link in the email to activate your account. You can then sign in.
            </div>
            <button className="btn btn-primary btn-full" onClick={() => router.push('/auth/login')}>
              Go to Sign In →
            </button>
          </div>
        ) : (
          <>
            {/* Step 1 — Account type */}
            {emailStep === 'type' && (
              <>
                <div className="acct-type-toggle" style={{ flexDirection: 'column' }}>
                  <button className={`acct-type-btn ${acctType === 'user' ? 'active' : ''}`} onClick={() => setAcctType('user')}>
                    <span className="acct-type-icon">👤</span>
                    <span className="acct-type-label">Customer</span>
                    <span className="acct-type-sub">Shop &amp; track orders</span>
                  </button>
                  <button className={`acct-type-btn ${acctType === 'business' ? 'active' : ''}`} onClick={() => setAcctType('business')}>
                    <span className="acct-type-icon">🏪</span>
                    <span className="acct-type-label">Business</span>
                    <span className="acct-type-sub">Sell &amp; manage products</span>
                  </button>
                  <button className={`acct-type-btn ${acctType === 'supplier' ? 'active' : ''}`} onClick={() => setAcctType('supplier')}>
                    <span className="acct-type-icon">🏭</span>
                    <span className="acct-type-label">Supplier</span>
                    <span className="acct-type-sub">Wholesale &amp; bulk orders</span>
                  </button>
                  <button className={`acct-type-btn ${acctType === 'agent' ? 'active' : ''}`} onClick={() => setAcctType('agent')}>
                    <span className="acct-type-icon">📋</span>
                    <span className="acct-type-label">Field Agent</span>
                    <span className="acct-type-sub">Sign up stores &amp; earn per store</span>
                  </button>
                </div>
                <div style={{ padding: '0 20px', display: 'flex', gap: 10 }}>
                  <button className="btn btn-ghost btn-lg" style={{ flex: 1 }} onClick={() => setMethod(null)}>← Back</button>
                  <button className="btn btn-primary btn-lg" style={{ flex: 2 }} onClick={() => { setError(''); setEmailStep('details'); }}>
                    Continue →
                  </button>
                </div>
              </>
            )}

            {/* Step 2 — Details */}
            {emailStep === 'details' && (
              <div className="auth-card">
                <button className="auth-back-btn" onClick={() => { setEmailStep('type'); setError(''); }}>← Back</button>
                <div className="auth-card-title">Create your account</div>
                <div className="auth-card-sub">{acctType === 'business' ? 'Set up your business account' : acctType === 'supplier' ? 'Set up your supplier account' : acctType === 'agent' ? 'Set up your field agent account' : 'Fill in your details below'}</div>

                {error && <div className="auth-error">{error}</div>}

                <div className="form-group" style={{ marginTop: 12 }}>
                  <label className="form-label">{acctType === 'business' ? 'Business Name' : acctType === 'supplier' ? 'Supplier / Company Name' : acctType === 'agent' ? 'Agent / Full Name' : 'Full Name'} *</label>
                  <input className="form-input"
                    placeholder={acctType === 'business' ? 'TechVault Store' : acctType === 'supplier' ? 'Acme Wholesale Co.' : acctType === 'agent' ? 'Mohamed Ali' : 'Ahmed Hassan'}
                    value={name} onChange={e => setName(e.target.value)} autoFocus
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Email Address *</label>
                  <input className="form-input" type="email" placeholder="you@example.com"
                    value={email} onChange={e => setEmail(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Password *</label>
                  <div style={{ position: 'relative' }}>
                    <input className="form-input"
                      type={showPass ? 'text' : 'password'} placeholder="Min. 6 characters"
                      value={password} onChange={e => setPassword(e.target.value)}
                      style={{ paddingRight: 42 }}
                    />
                    <button type="button" tabIndex={-1}
                      onClick={() => setShowPass(v => !v)}
                      style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '.88rem', color: 'var(--text-muted)' }}>
                      {showPass ? '🙈' : '👁️'}
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Confirm Password *</label>
                  <input className="form-input"
                    type={showPass ? 'text' : 'password'} placeholder="Repeat password"
                    value={password2} onChange={e => setPassword2(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleEmailSignup()}
                  />
                </div>

                {agreeBlock}

                <button className="btn btn-primary btn-full btn-lg" onClick={handleEmailSignup}
                  disabled={loading || !name.trim() || !email.trim() || password.length < 6 || !password2 || !agreed}>
                  {loading ? <><span className="btn-spinner" /> Creating account…</> : 'Create Account →'}
                </button>
              </div>
            )}
          </>
        )}

        <div className="auth-switch" style={{ marginTop: 16 }}>
          Already have an account? <Link href="/auth/login">Sign in</Link>
        </div>
      </div>
    );
  }

  /* ════════════════════════════════════════════════════
     GOOGLE FLOW
  ════════════════════════════════════════════════════ */
  return (
    <div className="page-anim auth-wrap">
      <div className="auth-logo">
        <div className="auth-logo-icon">{acctIcon}</div>
        <div className="auth-logo-title">Hamar Mall</div>
        <div className="auth-logo-sub">Sign up with Google</div>
      </div>

      {/* Step 1 — Account type */}
      {googleStep === 'type' && (
        <>
          <div className="acct-type-toggle" style={{ flexDirection: 'column' }}>
            <button className={`acct-type-btn ${acctType === 'user' ? 'active' : ''}`} onClick={() => setAcctType('user')}>
              <span className="acct-type-icon">👤</span>
              <span className="acct-type-label">Customer</span>
              <span className="acct-type-sub">Shop &amp; track orders</span>
            </button>
            <button className={`acct-type-btn ${acctType === 'business' ? 'active' : ''}`} onClick={() => setAcctType('business')}>
              <span className="acct-type-icon">🏪</span>
              <span className="acct-type-label">Business</span>
              <span className="acct-type-sub">Sell &amp; manage products</span>
            </button>
            <button className={`acct-type-btn ${acctType === 'supplier' ? 'active' : ''}`} onClick={() => setAcctType('supplier')}>
              <span className="acct-type-icon">🏭</span>
              <span className="acct-type-label">Supplier</span>
              <span className="acct-type-sub">Wholesale &amp; bulk orders</span>
            </button>
            <button className={`acct-type-btn ${acctType === 'agent' ? 'active' : ''}`} onClick={() => setAcctType('agent')}>
              <span className="acct-type-icon">📋</span>
              <span className="acct-type-label">Field Agent</span>
              <span className="acct-type-sub">Register products in the catalog</span>
            </button>
          </div>
          <div style={{ padding: '0 20px', display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost btn-lg" style={{ flex: 1 }} onClick={() => setMethod(null)}>← Back</button>
            <button className="btn btn-primary btn-lg" style={{ flex: 2 }} onClick={() => { setError(''); setGoogleStep('name'); }}>
              Continue →
            </button>
          </div>
        </>
      )}

      {/* Step 2 — Name + redirect */}
      {googleStep === 'name' && (
        <div className="auth-card">
          <button className="auth-back-btn" onClick={() => { setGoogleStep('type'); setError(''); }}>← Back</button>
          <div className="auth-card-title">{acctType === 'business' ? 'Business name' : acctType === 'supplier' ? 'Supplier name' : acctType === 'agent' ? 'Your name' : 'Your name'}</div>
          <div className="auth-card-sub">
            {acctType === 'business'
              ? 'What is your business called?'
              : acctType === 'supplier'
              ? 'What is your company called?'
              : acctType === 'agent'
              ? 'What is your name? (used as your agent ID)'
              : 'What should we call you? (or leave for Google to fill in)'}
          </div>

          {error && <div className="auth-error">{error}</div>}

          <div className="form-group" style={{ marginTop: 16 }}>
            <input className="form-input"
              placeholder={acctType === 'business' ? 'TechVault Store' : acctType === 'supplier' ? 'Acme Wholesale Co.' : acctType === 'agent' ? 'Mohamed Ali' : 'Ahmed Hassan (optional)'}
              value={name} onChange={e => setName(e.target.value)} autoFocus
            />
          </div>

          {agreeBlock}

          <button className="auth-google-btn" onClick={handleGoogleSignup} disabled={loading || !agreed || ((acctType === 'business' || acctType === 'supplier' || acctType === 'agent') && !name.trim())}>
            {loading ? (
              <><span className="btn-spinner" style={{ borderTopColor: '#4285F4' }} /> Redirecting…</>
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Continue with Google
              </>
            )}
          </button>

          <p className="auth-provider-note">
            You&apos;ll be redirected to Google to complete sign-up.
          </p>
        </div>
      )}

      <div className="auth-switch" style={{ marginTop: 16 }}>
        Already have an account? <Link href="/auth/login">Sign in</Link>
      </div>
    </div>
  );
}
