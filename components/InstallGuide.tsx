'use client';

import { useEffect, useState } from 'react';
import {
  useInstall, onInstallGuideOpen, installInstructions,
} from '@/lib/installApp';

/**
 * How to install, for every browser that won't let us do it in one tap —
 * iOS Safari (which has no install API at all), in-app browsers, and desktop
 * browsers that hide the option behind a menu.
 *
 * Opened by whichever Install control the user pressed; there is exactly one
 * of these mounted, in the root layout.
 */
export default function InstallGuide() {
  const { platform, installed, canPrompt, install } = useInstall();
  const [open, setOpen] = useState(false);

  useEffect(() => onInstallGuideOpen(() => setOpen(true)), []);

  // Installing while the sheet is open should just close it.
  useEffect(() => { if (installed) setOpen(false); }, [installed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const { title, steps } = installInstructions(platform);

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}
      style={{ zIndex: 400 }}
    >
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <span>📲 {title}</span>
          <button className="modal-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
        </div>

        <div style={{ padding: '4px 18px 18px' }}>
          <p style={{ fontSize: '.86rem', color: 'var(--text-light)', lineHeight: 1.55, marginTop: 0 }}>
            Installing puts Hamar Mall on your home screen and lets it open
            instantly — and keep working when your connection drops.
          </p>

          <ol style={{ margin: '16px 0 0', paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 12 }}>
            {steps.map((step, i) => (
              <li key={step} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{
                  flexShrink: 0, width: 24, height: 24, borderRadius: '50%',
                  background: 'var(--primary)', color: '#fff', fontSize: '.78rem',
                  fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{i + 1}</span>
                <span style={{ fontSize: '.88rem', lineHeight: 1.5 }}>{step}</span>
              </li>
            ))}
          </ol>

          {/* If a native prompt turned up while the sheet was open, offer it. */}
          {canPrompt && (
            <button className="btn btn-primary btn-full" style={{ marginTop: 18 }}
              onClick={() => { install(); setOpen(false); }}>
              Install now
            </button>
          )}
          <button className="btn btn-ghost btn-full" style={{ marginTop: 8 }} onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
