'use client';

import { useState, useEffect } from 'react';
import { Link } from '@/lib/hashRouter';
import { usePathname, useRouter } from '@/lib/hashRouter';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { useCashier } from '@/context/CashierContext';
import { roleFor, isBusinessRoute } from '@/lib/roles';
import { cashierCanAccess } from '@/lib/cashierPrivileges';
import { useIsAdmin } from '@/lib/useIsAdmin';
import { useChatUnread } from '@/lib/useChatUnread';
import { openAssistant } from '@/lib/assistant';
import { useInstall } from '@/lib/installApp';
import BrandMark from '@/components/BrandMark';

export default function Sidebar() {
  const pathname = usePathname();
  const router   = useRouter();
  const { unreadCount, cartCount, setCartOpen } = useApp();
  const { user, accountType, signOut } = useAuth();
  const { cashier, logoutCashier } = useCashier();
  const { isAdmin } = useIsAdmin();
  const chatUnread = useChatUnread();
  const { installed, install } = useInstall();

  async function handleLogout() {
    await signOut();
    router.push('/auth/login');
  }
  // A cashier session governs even if a stale owner session lingers (see GuardedApp).
  const role      = cashier ? 'business' : roleFor(!!user, accountType);
  const notifs    = unreadCount();
  const cartItems = cartCount();
  
  // Desktop-only component: below 960px the CSS hides .sidebar entirely and
  // mobile navigation is the Header drawer + BottomNav. (The old mobile
  // toggle here showed a full-screen overlay over an invisible sidebar.)
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const items = [
    {
      href: '/',
      label: 'Explore',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
      ),
    },
    {
      href: '/my-dashboard',
      label: 'Dashboard',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1.5"/>
          <rect x="14" y="3" width="7" height="7" rx="1.5"/>
          <rect x="3" y="14" width="7" height="7" rx="1.5"/>
          <rect x="14" y="14" width="7" height="7" rx="1.5"/>
        </svg>
      ),
    },
    // Global (all-businesses) dashboard — admins only
    ...(isAdmin ? [{
      href: '/dashboard',
      label: 'Global Dashboard',
      badge: undefined as number | undefined,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      ),
    }] : []),
    {
      href: '/customers',
      label: 'Customers',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      ),
    },
    {
      href: '/staff',
      label: 'Staff',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      ),
    },
    {
      href: '/pos',
      label: 'Point of Sale',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
        </svg>
      ),
    },
    {
      href: '/inventory',
      label: 'Inventory',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        </svg>
      ),
    },
    {
      href: '/suppliers',
      label: 'Suppliers',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      ),
    },
    ...(user || cashier ? [{
      href: '/chat',
      label: 'Chat',
      badge: chatUnread > 0 ? chatUnread : undefined,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      ),
    }] : []),
    {
      href: '/wishlist',
      label: 'Wishlist',
      badge: undefined as number | undefined,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
      ),
    },
    {
      href: '/notifications',
      label: 'Alerts',
      badge: notifs,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
      ),
    },
    ...(user || cashier ? [{
      href: '/orders',
      label: 'Orders',
      badge: undefined as number | undefined,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
      ),
    }] : []),
    {
      href: '/settings',
      label: 'Settings',
      badge: undefined as number | undefined,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      ),
    },
    {
      href: '/profile',
      label: user ? 'Profile' : 'Login',
      badge: undefined as number | undefined,
      icon: user ? (
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
          <polyline points="10 17 15 12 10 7"/>
          <line x1="15" y1="12" x2="3" y2="12"/>
        </svg>
      ),
    },
  ];

  return (
    <>
      <aside className="sidebar">
        {/* Logo + search shortcut */}
        <div className="sidebar-logo">
          <Link href="/" className="sidebar-logo-link">
            <div className="sidebar-logo-icon">
              <BrandMark size={32} />
            </div>
            <span className="sidebar-logo-text">Hamar Mall</span>
          </Link>
          <button className="sidebar-search-btn" onClick={() => router.push('/search')} title="Search (/)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          </button>
        </div>

        {/* Nav items — store-operations links are business-only, and a cashier
            session is further narrowed to only the privileges they were granted */}
        <nav className="sidebar-nav">
          {items
            .filter(item => !isBusinessRoute(item.href) || role === 'business')
            .filter(item => !cashier || cashierCanAccess(item.href, cashier.privileges))
            .map(item => {
            const isActive = item.href === '/' ? pathname === '/' : (pathname?.startsWith(item.href) ?? false);
            return (
              <Link key={item.href} href={item.href} className={`sidebar-item ${isActive ? 'active' : ''}`}>
                <span className="sidebar-item-icon">{item.icon}</span>
                <span className="sidebar-item-label">{item.label}</span>
                {mounted && item.badge != null && item.badge > 0 && (
                  <span className="sidebar-badge">{item.badge}</span>
                )}
              </Link>
            );
          })}

          {/* Install — one of the navigation items, not a pinned footer
              button. It stays for exactly as long as the app isn't installed:
              `installed` is read from the live display mode (lib/installApp),
              never a stored flag, so deleting the app brings it straight back.
              The `mounted` guard keeps it out of the server render, which
              cannot know whether this is already the installed app. */}
          {mounted && !installed && (
            <button className="sidebar-item sidebar-install-btn" onClick={install}
              style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left' }}>
              <span className="sidebar-item-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="2" width="14" height="20" rx="2.5"/>
                  <path d="M12 7v8m0 0 3-3m-3 3-3-3"/>
                </svg>
              </span>
              <span className="sidebar-item-label">Install app</span>
            </button>
          )}

          {/* AI help assistant — opens the chat panel (no longer a floating button) */}
          <button className="sidebar-item" onClick={openAssistant} style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left' }}>
            <span className="sidebar-item-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="14" rx="3"/>
                <path d="M8 20l2-2h4l2 2"/><circle cx="9" cy="11" r="1"/><circle cx="15" cy="11" r="1"/>
              </svg>
            </span>
            <span className="sidebar-item-label">AI Assistant</span>
          </button>
        </nav>

        {/* Cart button */}
        <div className="sidebar-footer">
          {cashier && (
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-light)', marginBottom: 4 }}>
              <div style={{ fontSize: '.78rem', color: 'var(--text-light)' }}>Logged in as</div>
              <div style={{ fontWeight: 700, fontSize: '.88rem' }}>{cashier.name}</div>
              <button className="btn btn-sm btn-secondary" style={{ marginTop: 6, width: '100%', fontSize: '.78rem' }}
                onClick={logoutCashier}>
                Log Out
              </button>
            </div>
          )}
          <button className="sidebar-item sidebar-cart-btn" onClick={() => setCartOpen(true)}>
            <span className="sidebar-item-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
              </svg>
            </span>
            <span className="sidebar-item-label">Cart</span>
            {mounted && cartItems > 0 && <span className="sidebar-badge">{cartItems}</span>}
          </button>

          {/* Global log out — only when a real user (not a cashier) is signed in */}
          {user && (
            <button className="sidebar-item" onClick={handleLogout}>
              <span className="sidebar-item-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
              </span>
              <span className="sidebar-item-label">Log out</span>
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
