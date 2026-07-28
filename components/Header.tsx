'use client';

import { useEffect, useRef, useState } from 'react';
import { Link } from '@/lib/hashRouter';
import { usePathname, useRouter } from '@/lib/hashRouter';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { useCashier } from '@/context/CashierContext';
import { roleFor, isBusinessRoute } from '@/lib/roles';
import { cashierCanAccess } from '@/lib/cashierPrivileges';
import { useIsAdmin } from '@/lib/useIsAdmin';
import { openAssistant } from '@/lib/assistant';
import BrandMark from '@/components/BrandMark';

interface HeaderProps {
  searchQuery?: string;
  onSearch?: (q: string) => void;
  showSearch?: boolean;
  /** When set, focusing/tapping the search box runs this instead of typing
   *  in place — used to hand off to the full Search page. */
  onSearchFocus?: () => void;
}

/* Navs pulled out of the bottom bar into the mobile menu drawer */
const MENU_LINKS = [
  {
    href: '/my-dashboard',
    label: 'Dashboard',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg>
    ),
  },
  {
    href: '/inventory',
    label: 'Stock',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
      </svg>
    ),
  },
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
    href: '/suppliers',
    label: 'Suppliers',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8z"/>
        <circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
      </svg>
    ),
  },
  {
    href: '/orders',
    label: 'Orders',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
        <rect x="8" y="2" width="8" height="4" rx="1"/>
        <path d="M9 12h6M9 16h6"/>
      </svg>
    ),
  },
  {
    href: '/wishlist',
    label: 'Wishlist',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    ),
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    ),
  },
];

export default function Header({ searchQuery = '', onSearch, showSearch = true, onSearchFocus }: HeaderProps) {
  const { unreadCount, cartCount, setCartOpen } = useApp();
  const { user, accountType, signOut } = useAuth();
  const { cashier, logoutCashier } = useCashier();
  const { isAdmin } = useIsAdmin();
  // A cashier session governs even if a stale owner session lingers (see GuardedApp).
  const role = cashier ? 'business' : roleFor(!!user, accountType);
  const router = useRouter();

  async function handleLogout() {
    setMenuOpen(false);
    await signOut();
    router.push('/auth/login');
  }
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const notifs = unreadCount();
  const cartItems = cartCount();

  // Close the drawer whenever navigation happens
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  useEffect(() => { setMounted(true); }, []);

  // Freeze the page behind the open drawer
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  /* ── Slide gestures ──────────────────────────────────────────
     Open:  swipe right from the left screen edge.
     Close: drag the drawer left — it follows the finger, then
     snaps closed past 70px or springs back. */
  const drawerRef = useRef<HTMLElement>(null);
  const dragRef   = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  useEffect(() => {
    if (menuOpen) return;
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t.clientX <= 24 ? { x: t.clientX, y: t.clientY } : null;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t  = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = Math.abs(t.clientY - start.y);
      if (dx > 50 && dx > dy * 1.5) { setMenuOpen(true); start = null; }
    };
    const onEnd = () => { start = null; };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove',  onMove,  { passive: true });
    window.addEventListener('touchend',   onEnd,   { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove',  onMove);
      window.removeEventListener('touchend',   onEnd);
    };
  }, [menuOpen]);

  const onDrawerTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    dragRef.current = { x: t.clientX, y: t.clientY, dragging: false };
  };
  const onDrawerTouchMove = (e: React.TouchEvent) => {
    const s = dragRef.current;
    const el = drawerRef.current;
    if (!s || !el) return;
    const t  = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = Math.abs(t.clientY - s.y);
    if (!s.dragging && Math.abs(dx) > 8 && Math.abs(dx) > dy) s.dragging = true;
    if (s.dragging && dx < 0) {
      el.style.transition = 'none';
      el.style.transform  = `translateX(${dx}px)`;
    }
  };
  const onDrawerTouchEnd = (e: React.TouchEvent) => {
    const s  = dragRef.current;
    const el = drawerRef.current;
    dragRef.current = null;
    if (!s || !el) return;
    const dx = e.changedTouches[0].clientX - s.x;
    el.style.transition = '';
    el.style.transform  = '';
    if (s.dragging && dx < -70) setMenuOpen(false);
  };

  return (
    <>
      <header className="header" suppressHydrationWarning>
        <button className="menu-btn" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h12"/>
          </svg>
        </button>

        <Link href="/" className="header-logo">
          <BrandMark className="logo-icon" />
          Hamar Mall
        </Link>

        {showSearch && (
          <div className="header-search" onClick={onSearchFocus}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="text"
              placeholder="Search products…"
              value={searchQuery}
              onChange={e => onSearch?.(e.target.value)}
              onFocus={onSearchFocus}
              readOnly={!!onSearchFocus}
            />
          </div>
        )}

        <div className="header-actions">
          <button className="icon-btn" aria-label="Open cart" onClick={() => setCartOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
              <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
            </svg>
            {mounted && cartItems > 0 && <span key={cartItems} className="badge badge-bump">{cartItems}</span>}
          </button>

          <Link href="/notifications" className="icon-btn" aria-label="Notifications">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            {mounted && notifs > 0 && <span className="badge">{notifs}</span>}
          </Link>
        </div>
      </header>

      {/* ── Mobile menu drawer ── */}
      <div className={`overlay ${menuOpen ? 'show' : ''}`} onClick={() => setMenuOpen(false)} />
      <aside
        ref={drawerRef}
        className={`mobile-menu ${menuOpen ? 'open' : ''}`}
        aria-hidden={!menuOpen}
        onTouchStart={onDrawerTouchStart}
        onTouchMove={onDrawerTouchMove}
        onTouchEnd={onDrawerTouchEnd}
      >
        <div className="mobile-menu-head">
          <span className="header-logo">
            <BrandMark size={26} />
            Hamar Mall
          </span>
          <button className="mobile-menu-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <nav className="mobile-menu-list">
          {MENU_LINKS
            .filter(item => !isBusinessRoute(item.href) || role === 'business')
            .filter(item => !cashier || cashierCanAccess(item.href, cashier.privileges))
            .map(item => {
            const isActive = pathname?.startsWith(item.href) ?? false;
            return (
              <Link key={item.href} href={item.href} className={`mobile-menu-link ${isActive ? 'active' : ''}`}>
                {item.icon}
                {item.label}
              </Link>
            );
          })}
          {/* Global (all-businesses) dashboard — admins only */}
          {isAdmin && (
            <Link href="/dashboard" className={`mobile-menu-link ${pathname === '/dashboard' ? 'active' : ''}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              Global Dashboard
            </Link>
          )}

          {/* AI help assistant — opens the chat panel (no longer a floating button) */}
          <button
            className="mobile-menu-link"
            onClick={() => { setMenuOpen(false); openAssistant(); }}
            style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="14" rx="3"/>
              <path d="M8 20l2-2h4l2 2"/><circle cx="9" cy="11" r="1"/><circle cx="15" cy="11" r="1"/>
            </svg>
            AI Assistant
          </button>
        </nav>

        <div className="mobile-menu-foot">
          {cashier && (
            <div style={{ padding: '0 4px 10px' }}>
              <div style={{ fontSize: '.78rem', color: 'var(--text-light)' }}>Logged in as</div>
              <div style={{ fontWeight: 700, fontSize: '.92rem' }}>{cashier.name}</div>
              <button
                className="mobile-menu-link mobile-menu-logout"
                onClick={() => { setMenuOpen(false); logoutCashier(); }}
                style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, marginTop: 6 }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                Log out (staff)
              </button>
            </div>
          )}
          <Link href={user ? '/profile' : '/auth/login'} className="mobile-menu-link">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
            {user ? 'My Profile' : 'Sign In'}
          </Link>
          {user && (
            <button className="mobile-menu-link mobile-menu-logout" onClick={handleLogout} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              Log out
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
