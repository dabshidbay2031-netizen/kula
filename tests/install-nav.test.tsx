/**
 * The permanent Install entry.
 *
 * The requirement is narrow and easy to break: Install stays in the nav until
 * the app is genuinely installed, and comes BACK if the app is deleted. That
 * rules out the obvious implementation — remembering "installed" or "dismissed"
 * in localStorage — because nothing tells a web app it was uninstalled, so any
 * stored flag outlives the app and hides the entry forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/* ── Stubs for everything BottomNav pulls in ─────────────────────── */
vi.mock('@/context/AppContext',     () => ({ useApp:     () => ({ unreadCount: () => 0 }) }));
vi.mock('@/context/AuthContext',    () => ({ useAuth:    () => ({ user: null, accountType: null }) }));
vi.mock('@/context/CashierContext', () => ({ useCashier: () => ({ cashier: null, logoutCashier: () => {} }) }));
vi.mock('@/lib/useChatUnread',      () => ({ useChatUnread: () => 0 }));
vi.mock('@/lib/hashRouter', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  usePathname: () => '/',
}));

import InstallGuide from '@/components/InstallGuide';
import { installInstructions } from '@/lib/installApp';

/** Point matchMedia at a chosen display-mode. */
function setDisplayMode(mode: 'browser' | 'standalone') {
  const listeners: Array<() => void> = [];
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: mode === 'standalone' && q.includes('standalone'),
    media: q,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: () => {},
    addListener: (fn: () => void) => listeners.push(fn),
    removeListener: () => {},
  }));
}

/**
 * Reload the store module so each test starts from a clean singleton.
 * Every test must go through this — lib/installApp keeps module-level state
 * and window listeners, so a statically imported BottomNav would carry the
 * previous test's `appinstalled` across.
 */
async function freshNav(mode: 'browser' | 'standalone' = 'browser') {
  setDisplayMode(mode);
  vi.resetModules();
  const { default: Nav } = await import('@/components/BottomNav');
  return Nav;
}

const installLink = () => screen.queryByText('Install');

beforeEach(() => { localStorage.clear(); setDisplayMode('browser'); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Install stays until the app is installed', () => {
  it('is in the nav when browsing normally', async () => {
    const Nav = await freshNav('browser');
    render(<Nav />);
    await waitFor(() => expect(installLink()).toBeInTheDocument());
  });

  it('is absent when already running as the installed app', async () => {
    const Nav = await freshNav('standalone');
    render(<Nav />);
    // Give the mount effect a chance to add it — it must not.
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Install')).not.toBeInTheDocument();
  });

  it('never persists an "installed" flag, so an uninstall brings it back', async () => {
    const Nav = await freshNav('browser');
    const { unmount } = render(<Nav />);
    await waitFor(() => expect(screen.getByText('Install')).toBeInTheDocument());

    await act(async () => { window.dispatchEvent(new Event('appinstalled')); });
    await waitFor(() => expect(screen.queryByText('Install')).not.toBeInTheDocument());

    // Nothing written anywhere. A fresh load (the app having been deleted, so
    // display-mode is 'browser' again) shows it once more.
    expect(Object.keys(localStorage)).toHaveLength(0);
    unmount();

    const Nav2 = await freshNav('browser');
    render(<Nav2 />);
    await waitFor(() => expect(screen.getByText('Install')).toBeInTheDocument());
  });

  it('survives dismissing the first-run banner', async () => {
    // The banner's dismissal flag must not reach the nav entry.
    localStorage.setItem('pwa_dismissed', '1');
    const Nav = await freshNav('browser');
    render(<Nav />);
    await waitFor(() => expect(screen.getByText('Install')).toBeInTheDocument());
  });

  it('keeps the nav to one row of six by switching to compact labels', async () => {
    const Nav = await freshNav('browser');
    const { container } = render(<Nav />);
    await waitFor(() => expect(screen.getByText('Install')).toBeInTheDocument());
    const nav = container.querySelector('.bottom-nav')!;
    expect(nav.className).toContain('compact');
    expect(nav.querySelectorAll('.nav-item')).toHaveLength(6);
  });
});

describe('what Install does', () => {
  it('fires the browser prompt when one is available', async () => {
    const prompt = vi.fn(async () => {});
    const Nav = await freshNav('browser');
    render(<Nav />);
    await waitFor(() => expect(screen.getByText('Install')).toBeInTheDocument());

    await act(async () => {
      window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), {
        prompt, userChoice: Promise.resolve({ outcome: 'dismissed' }),
      }));
    });
    await userEvent.click(screen.getByText('Install'));

    await waitFor(() => expect(prompt).toHaveBeenCalled());
  });

  it('opens the how-to sheet when the browser offers no prompt', async () => {
    const Nav = await freshNav('browser');
    render(<><Nav /><InstallGuide /></>);
    await waitFor(() => expect(screen.getByText('Install')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Install'));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });
});

describe('platform instructions', () => {
  it('tells iPhone users to use Share → Add to Home Screen', () => {
    const { steps } = installInstructions('ios-safari');
    expect(steps.join(' ')).toMatch(/Share/);
    expect(steps.join(' ')).toMatch(/Add to Home Screen/);
  });

  it('sends non-Safari iOS browsers to Safari, since only it can install', () => {
    const { steps } = installInstructions('ios-other');
    expect(steps.join(' ')).toMatch(/Safari/);
  });

  it('has wording for Android and desktop too', () => {
    expect(installInstructions('android').steps.length).toBeGreaterThan(0);
    expect(installInstructions('desktop').steps.length).toBeGreaterThan(0);
  });
});
