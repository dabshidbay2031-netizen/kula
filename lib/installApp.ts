'use client';

/**
 * One source of truth for "can this person install Hamar Mall, and how?".
 *
 * Shared by the bottom nav, the desktop sidebar, the first-run banner and the
 * how-to sheet, so all four agree and the browser's one-shot install event is
 * captured once rather than raced for.
 *
 * ── Deliberately NOT persisted ──────────────────────────────────────
 * "Installed" is recomputed from the live display mode every time. Writing a
 * flag to localStorage would be easy and wrong: uninstalling the app fires no
 * event, so the flag would outlive the app and the Install entry would never
 * come back. Reading the display mode instead means a deleted app is
 * indistinguishable from one that was never installed — which is exactly the
 * behaviour we want.
 */

import { useCallback, useSyncExternalStore } from 'react';

export type InstallPlatform = 'ios-safari' | 'ios-other' | 'android' | 'desktop';

export interface InstallState {
  /** Running as an installed app right now. */
  installed: boolean;
  /** The browser offered a native install prompt we can fire. */
  canPrompt: boolean;
  platform: InstallPlatform;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/* The inline capture script in app/layout.tsx parks the event here, because it
   can fire before this bundle has even downloaded. */
declare global {
  interface Window {
    __hmInstallEvent?: BeforeInstallPromptEvent | null;
  }
}

function detectPlatform(): InstallPlatform {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support is what gives it away.
  const iOS = /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  if (iOS) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS has never supported the display-mode query; it has its own flag.
  if ((window.navigator as unknown as { standalone?: boolean }).standalone) return true;
  try {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: minimal-ui)').matches
        || window.matchMedia('(display-mode: fullscreen)').matches;
  } catch { return false; }
}

/* ── Store ───────────────────────────────────────────────────────── */

const SERVER_STATE: InstallState = { installed: false, canPrompt: false, platform: 'desktop' };

let state: InstallState = SERVER_STATE;
let started = false;
const listeners = new Set<() => void>();

function set(next: Partial<InstallState>) {
  const merged = { ...state, ...next };
  if (merged.installed === state.installed
   && merged.canPrompt === state.canPrompt
   && merged.platform  === state.platform) return;
  state = merged;
  listeners.forEach(fn => fn());
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;

  set({
    platform:  detectPlatform(),
    installed: isStandalone(),
    // The capture script may already be holding the event for us.
    canPrompt: !!window.__hmInstallEvent,
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__hmInstallEvent = e as BeforeInstallPromptEvent;
    set({ canPrompt: true });
  });

  window.addEventListener('appinstalled', () => {
    window.__hmInstallEvent = null;
    set({ installed: true, canPrompt: false });
  });

  // Installing (or launching the installed copy) flips the display mode.
  try {
    const mq = window.matchMedia('(display-mode: standalone)');
    const onChange = () => set({ installed: isStandalone() });
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);            // Safari < 14
  } catch { /* matchMedia unavailable */ }
}

export function subscribeInstall(fn: () => void): () => void {
  start();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getInstallState(): InstallState {
  start();
  return state;
}

/** Stable reference — React requires the server snapshot not to change. */
export function getInstallServerState(): InstallState {
  return SERVER_STATE;
}

/**
 * Fire the browser's native install prompt.
 * Returns 'unavailable' when there is nothing to fire — iOS always, and any
 * browser that hasn't offered one yet — so the caller can show instructions.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const evt = typeof window !== 'undefined' ? window.__hmInstallEvent : null;
  if (!evt) return 'unavailable';
  try {
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    // The event is single-use; a second prompt() throws.
    window.__hmInstallEvent = null;
    set({ canPrompt: false, installed: outcome === 'accepted' ? true : state.installed });
    return outcome;
  } catch {
    window.__hmInstallEvent = null;
    set({ canPrompt: false });
    return 'unavailable';
  }
}

/* ── React binding ───────────────────────────────────────────────── */

/** Where the how-to sheet lives, so any Install control can open it. */
const OPEN_GUIDE_EVENT = 'hm:install-guide';
export function openInstallGuide() {
  window.dispatchEvent(new CustomEvent(OPEN_GUIDE_EVENT));
}
export function onInstallGuideOpen(fn: () => void): () => void {
  window.addEventListener(OPEN_GUIDE_EVENT, fn);
  return () => window.removeEventListener(OPEN_GUIDE_EVENT, fn);
}

export function useInstall() {
  const state = useSyncExternalStore(subscribeInstall, getInstallState, getInstallServerState);

  /** One click to install: native prompt where possible, how-to otherwise. */
  const install = useCallback(async () => {
    const outcome = await promptInstall();
    if (outcome === 'unavailable') openInstallGuide();
    return outcome;
  }, []);

  return { ...state, install };
}

/** Step-by-step wording for platforms with no programmatic install. */
export function installInstructions(platform: InstallPlatform): { title: string; steps: string[] } {
  switch (platform) {
    case 'ios-safari':
      return {
        title: 'Add Hamar Mall to your Home Screen',
        steps: [
          'Tap the Share button at the bottom of Safari.',
          'Scroll down and tap “Add to Home Screen”.',
          'Tap “Add” — Hamar Mall appears with your other apps.',
        ],
      };
    case 'ios-other':
      return {
        title: 'Open this page in Safari first',
        steps: [
          'Only Safari can add apps to the iPhone Home Screen.',
          'Copy this page’s address and open it in Safari.',
          'Then tap Share → “Add to Home Screen”.',
        ],
      };
    case 'android':
      return {
        title: 'Add Hamar Mall to your home screen',
        steps: [
          'Open your browser’s menu (⋮ in the top corner).',
          'Tap “Install app” or “Add to Home screen”.',
          'Confirm — Hamar Mall opens like a normal app after that.',
        ],
      };
    default:
      return {
        title: 'Install Hamar Mall on this computer',
        steps: [
          'Look for the install icon (⊕ or a small screen) in the address bar.',
          'Click it, then choose “Install”.',
          'If you don’t see it, open the browser menu and look for “Install Hamar Mall”.',
        ],
      };
  }
}
