'use client';

import { useEffect, useState } from 'react';
import { useInstall } from '@/lib/installApp';

/**
 * First-run nudge to install the app.
 *
 * This banner is dismissible and stays dismissed — that's the point of it. The
 * PERMANENT install affordance is the Install entry in the bottom nav and the
 * desktop sidebar, which has no dismiss and returns the moment the app is
 * uninstalled. This is just the louder first ask.
 *
 * Everything it knows comes from lib/installApp, so it can't disagree with the
 * nav about whether the app is installed.
 */
export default function InstallPrompt() {
  const { installed, platform, install } = useInstall();
  const [dismissed, setDismissed] = useState(true);   // assume dismissed until we've read storage

  useEffect(() => {
    setDismissed(localStorage.getItem('pwa_dismissed') === '1');
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem('pwa_dismissed', '1');
  };

  if (installed || dismissed) return null;

  const iosManual = platform === 'ios-safari' || platform === 'ios-other';

  return (
    <div className="install-prompt">
      <div className="install-prompt-icon">📱</div>
      <div className="install-prompt-content">
        <div className="install-prompt-title">Install Hamar Mall</div>
        <div className="install-prompt-sub">
          {iosManual
            ? 'Tap Share, then “Add to Home Screen”.'
            : 'Add to your home screen for quick access'}
        </div>
      </div>
      <button className="install-prompt-btn" onClick={install}>
        {iosManual ? 'How' : 'Install'}
      </button>
      <button className="install-prompt-dismiss" onClick={handleDismiss} aria-label="Dismiss">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );
}
