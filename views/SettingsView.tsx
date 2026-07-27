'use client';

import { useState, useEffect, useRef } from 'react';
import Header from '@/components/Header';
import { Link, useRouter } from '@/lib/hashRouter';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { isPushSupported, subscribeToPush, unsubscribeFromPush, pushReasonMessage } from '@/lib/push';

const STORAGE_KEY = 'mogarenta_settings';

/* Platform-wide fixed values — the app trades in USD and speaks English;
   these are shown as information, not choices. */
const DEFAULTS = {
  theme:               'light' as 'light' | 'dark',
  // POS (consumed by the register — see PosView)
  defaultPayment:      'cash',
  requireCustomerName: false,
  autoPrint:           false,
  // POS receipt customization (POS receipts only — online receipts unchanged).
  receiptQr:           true,
  merchantNumber:      '',
  receiptHeader1:      '',
  receiptHeader2:      '',
  receiptHeader3:      '',
};

type Settings = typeof DEFAULTS;

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="sett-toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="sett-track">
        <span className="sett-thumb" />
      </span>
    </label>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { user, accountType, currentSupplier, signOut } = useAuth();
  const { toast } = useApp();
  const [s, setS] = useState<Settings>(DEFAULTS);
  const loadedRef = useRef(false);

  /* Push notification state */
  const [pushState, setPushState] = useState<'unsupported' | 'off' | 'on' | 'busy'>('unsupported');

  /* Load from localStorage */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        setS({
          theme:               saved.theme === 'dark' ? 'dark' : 'light',
          defaultPayment:      ['cash', 'waafi', 'card'].includes(saved.defaultPayment) ? saved.defaultPayment : 'cash',
          requireCustomerName: !!saved.requireCustomerName,
          autoPrint:           !!saved.autoPrint,
          receiptQr:           saved.receiptQr !== undefined ? !!saved.receiptQr : true,
          merchantNumber:      typeof saved.merchantNumber === 'string' ? saved.merchantNumber : '',
          receiptHeader1:      typeof saved.receiptHeader1 === 'string' ? saved.receiptHeader1 : '',
          receiptHeader2:      typeof saved.receiptHeader2 === 'string' ? saved.receiptHeader2 : '',
          receiptHeader3:      typeof saved.receiptHeader3 === 'string' ? saved.receiptHeader3 : '',
        });
      }
    } catch {}
    loadedRef.current = true;
  }, []);

  /* Detect current push subscription */
  useEffect(() => {
    if (!isPushSupported()) { setPushState('unsupported'); return; }
    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        const sub = await reg?.pushManager.getSubscription();
        setPushState(sub && Notification.permission === 'granted' ? 'on' : 'off');
      } catch {
        setPushState('off');
      }
    })();
  }, []);

  /* Apply theme to <html> */
  useEffect(() => {
    if (s.theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [s.theme]);

  /* Every change saves itself — no "Save" button to forget. */
  useEffect(() => {
    if (!loadedRef.current) return;
    try {
      const raw  = localStorage.getItem(STORAGE_KEY);
      const prev = raw ? JSON.parse(raw) : {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prev, ...s }));
    } catch {}
  }, [s]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setS(prev => ({ ...prev, [k]: v }));

  async function togglePush() {
    if (pushState === 'unsupported' || pushState === 'busy') return;
    const turnOn = pushState === 'off';
    setPushState('busy');
    if (turnOn) {
      const { ok, reason } = await subscribeToPush();
      setPushState(ok ? 'on' : 'off');
      toast(ok ? 'Push notifications enabled ✓' : pushReasonMessage(reason), ok ? 'success' : 'error');
    } else {
      await unsubscribeFromPush();
      setPushState('off');
      toast('Push notifications disabled', 'default');
    }
  }

  function clearCachedData() {
    try {
      ['mg_c_products', 'mg_c_suppliers', 'mg_c_notifications'].forEach(k => localStorage.removeItem(k));
    } catch {}
    toast('Cached data cleared — reloading…', 'success');
    setTimeout(() => window.location.reload(), 600);
  }

  const handleReset = () => {
    if (!confirm('Reset all settings to defaults?')) return;
    localStorage.removeItem(STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
    setS(DEFAULTS);
    toast('Settings reset', 'default');
  };

  const isSeller = accountType === 'business' || accountType === 'supplier';

  return (
    <div className="page-anim">
      <Header showSearch={false} />

      <div className="page-title-bar">
        <span className="page-title">⚙️ Settings</span>
      </div>
      <p className="page-subtitle">Changes are saved automatically</p>

      {/* ── Account ───────────────────────────────────── */}
      <div className="sett-section">
        <div className="sett-section-title">👤 Account</div>
        <div className="sett-card">
          {user ? (
            <>
              <div className="sett-row">
                <div className="sett-row-info">
                  <div className="sett-row-label">Signed in as</div>
                  <div className="sett-row-sub">{user.email ?? user.displayName ?? user.id}</div>
                </div>
                <span className="sett-info-val">
                  {accountType === 'business' ? '🏪 Business'
                    : accountType === 'supplier' ? '🏭 Supplier'
                    : accountType === 'agent' ? '📋 Agent'
                    : '👤 Customer'}
                </span>
              </div>
              {currentSupplier && (
                <div className="sett-row">
                  <div className="sett-row-info">
                    <div className="sett-row-label">Store</div>
                    <div className="sett-row-sub">Shown on receipts and your storefront</div>
                  </div>
                  <span className="sett-info-val">{currentSupplier.name}</span>
                </div>
              )}
              <div className="sett-row">
                <div className="sett-row-info">
                  <div className="sett-row-label">Profile</div>
                  <div className="sett-row-sub">Name, photo{isSeller ? ', store details, logo' : ''}</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => router.push('/profile')}>Open</button>
              </div>
              <div className="sett-row">
                <div className="sett-row-info">
                  <div className="sett-row-label">Sign Out</div>
                  <div className="sett-row-sub">Log out of this device</div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ color: 'var(--danger)', border: '1.5px solid var(--danger)' }}
                  onClick={async () => { await signOut(); router.push('/'); }}
                >
                  Sign Out
                </button>
              </div>
            </>
          ) : (
            <div className="sett-row">
              <div className="sett-row-info">
                <div className="sett-row-label">Not signed in</div>
                <div className="sett-row-sub">Sign in to sync orders, chat and wishlist</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => router.push('/auth/login')}>Sign In</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Appearance ────────────────────────────────── */}
      <div className="sett-section">
        <div className="sett-section-title">🎨 Appearance</div>
        <div className="sett-card">
          <div className="sett-row">
            <div className="sett-row-info">
              <div className="sett-row-label">Theme</div>
              <div className="sett-row-sub">Light or dark mode</div>
            </div>
            <div className="sett-theme-toggle">
              <button
                className={`sett-theme-btn${s.theme === 'light' ? ' active' : ''}`}
                onClick={() => set('theme', 'light')}
              >☀️ Light</button>
              <button
                className={`sett-theme-btn${s.theme === 'dark' ? ' active' : ''}`}
                onClick={() => set('theme', 'dark')}
              >🌙 Dark</button>
            </div>
          </div>
          <div className="sett-row">
            <div className="sett-row-info">
              <div className="sett-row-label">Currency</div>
              <div className="sett-row-sub">All prices are in US Dollars</div>
            </div>
            <span className="sett-info-val">$ USD</span>
          </div>
          <div className="sett-row">
            <div className="sett-row-info">
              <div className="sett-row-label">Language</div>
              <div className="sett-row-sub">Interface language</div>
            </div>
            <span className="sett-info-val">English</span>
          </div>
        </div>
      </div>

      {/* ── Notifications ─────────────────────────────── */}
      <div className="sett-section">
        <div className="sett-section-title">🔔 Notifications</div>
        <div className="sett-card">
          <div className="sett-row">
            <div className="sett-row-info">
              <div className="sett-row-label">Push Notifications</div>
              <div className="sett-row-sub">
                {pushState === 'unsupported'
                  ? 'Not supported by this browser'
                  : 'Order updates & chat messages, even when the app is closed'}
              </div>
            </div>
            {pushState === 'unsupported' ? (
              <span className="sett-info-val">—</span>
            ) : (
              <button
                className={`btn btn-sm ${pushState === 'on' ? 'btn-secondary' : 'btn-primary'}`}
                onClick={togglePush}
                disabled={pushState === 'busy' || !user}
              >
                {pushState === 'busy' ? '…' : pushState === 'on' ? '✓ On — turn off' : 'Enable'}
              </button>
            )}
          </div>
          <div className="sett-row">
            <div className="sett-row-info">
              <div className="sett-row-label">In-App Notifications</div>
              <div className="sett-row-sub">Orders, payments and announcements</div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => router.push('/notifications')}>View</button>
          </div>
        </div>
      </div>

      {/* ── Point of Sale (sellers only) ───────────────── */}
      {isSeller && (
        <div className="sett-section">
          <div className="sett-section-title">🖥️ Point of Sale</div>
          <div className="sett-card">
            <div className="sett-row">
              <div className="sett-row-info">
                <div className="sett-row-label">Default Payment</div>
                <div className="sett-row-sub">Pre-selected at the register</div>
              </div>
              <select className="sett-input" value={s.defaultPayment} onChange={e => set('defaultPayment', e.target.value)}>
                <option value="cash">💵 Cash</option>
                <option value="waafi">📱 Waafi</option>
                <option value="card">💳 Card</option>
              </select>
            </div>
            <div className="sett-row">
              <div className="sett-row-info">
                <div className="sett-row-label">Require Customer Name</div>
                <div className="sett-row-sub">The register won't charge without a name</div>
              </div>
              <Toggle checked={s.requireCustomerName} onChange={v => set('requireCustomerName', v)} />
            </div>
            <div className="sett-row">
              <div className="sett-row-info">
                <div className="sett-row-label">Auto-Print Receipt</div>
                <div className="sett-row-sub">Opens the print dialog after every sale</div>
              </div>
              <Toggle checked={s.autoPrint} onChange={v => set('autoPrint', v)} />
            </div>
          </div>

          {/* Receipt customization — POS receipts only. Online-sale receipts
              are unaffected (they don't read these settings). */}
          <div className="sett-card" style={{ marginTop: 12 }}>
            <div className="sett-section-title" style={{ fontSize: '.85rem', marginBottom: 4 }}>🧾 Receipt</div>
            <div className="sett-row">
              <div className="sett-row-info">
                <div className="sett-row-label">QR Code on Receipt</div>
                <div className="sett-row-sub">Show the order-tracking QR</div>
              </div>
              <Toggle checked={s.receiptQr} onChange={v => set('receiptQr', v)} />
            </div>
            <div className="sett-row">
              <div className="sett-row-info">
                <div className="sett-row-label">Merchant Number</div>
                <div className="sett-row-sub">Printed under the store name</div>
              </div>
              <input
                className="sett-input"
                value={s.merchantNumber}
                onChange={e => set('merchantNumber', e.target.value)}
                placeholder="e.g. 0612345678"
                maxLength={60}
              />
            </div>
            <div className="sett-row">
              <div className="sett-row-info">
                <div className="sett-row-label">Receipt Header Line 1</div>
                <div className="sett-row-sub">Printed at the very top</div>
              </div>
              <input
                className="sett-input"
                value={s.receiptHeader1}
                onChange={e => set('receiptHeader1', e.target.value)}
                placeholder="e.g. Branch name"
                maxLength={80}
              />
            </div>
            <div className="sett-row">
              <div className="sett-row-info">
                <div className="sett-row-label">Receipt Header Line 2</div>
                <div className="sett-row-sub">Printed at the very top</div>
              </div>
              <input
                className="sett-input"
                value={s.receiptHeader2}
                onChange={e => set('receiptHeader2', e.target.value)}
                placeholder="e.g. Address"
                maxLength={80}
              />
            </div>
            <div className="sett-row">
              <div className="sett-row-info">
                <div className="sett-row-label">Receipt Header Line 3</div>
                <div className="sett-row-sub">Printed at the very top</div>
              </div>
              <input
                className="sett-input"
                value={s.receiptHeader3}
                onChange={e => set('receiptHeader3', e.target.value)}
                placeholder="e.g. Phone"
                maxLength={80}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Data ──────────────────────────────────────── */}
      <div className="sett-section">
        <div className="sett-section-title">🧹 Data</div>
        <div className="sett-card">
          <div className="sett-row">
            <div className="sett-row-info">
              <div className="sett-row-label">Refresh Cached Data</div>
              <div className="sett-row-sub">Clear the local product/store cache and reload</div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={clearCachedData}>Clear</button>
          </div>
          <div className="sett-row">
            <div className="sett-row-info">
              <div className="sett-row-label">Reset Settings</div>
              <div className="sett-row-sub">Back to defaults (theme, POS options)</div>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              style={{ color: 'var(--danger)', border: '1.5px solid var(--danger)' }}
              onClick={handleReset}
            >
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* ── About ─────────────────────────────────────── */}
      <div className="sett-section" style={{ marginBottom: 80 }}>
        <div className="sett-section-title">ℹ️ About</div>
        <div className="sett-card">
          <div className="sett-row">
            <div className="sett-row-info">
              <div className="sett-row-label">Version</div>
              <div className="sett-row-sub">Current app version</div>
            </div>
            <span className="sett-info-val">1.0.0</span>
          </div>
        </div>
      </div>

      {/* ── Legal ───────────────────────────────────────── */}
      <div className="legal-footer">
        <Link href="/privacy">Privacy Policy</Link>
        <span>·</span>
        <Link href="/terms">Terms of Service</Link>
      </div>
    </div>
  );
}
