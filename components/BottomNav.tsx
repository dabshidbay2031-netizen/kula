'use client';

import { Link } from '@/lib/hashRouter';
import { usePathname } from '@/lib/hashRouter';
import { useEffect, useState } from 'react';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { useCashier } from '@/context/CashierContext';
import { roleFor } from '@/lib/roles';
import { cashierCanAccess } from '@/lib/cashierPrivileges';
import { useChatUnread } from '@/lib/useChatUnread';

export default function BottomNav() {
  const pathname = usePathname();
  const { unreadCount } = useApp();
  const { user, accountType } = useAuth();
  const { cashier, logoutCashier } = useCashier();
  // A cashier session governs even if a stale owner session lingers (see GuardedApp).
  const role = cashier ? 'business' : roleFor(!!user, accountType);
  const posAllowed = role === 'business' && (!cashier || cashierCanAccess('/pos', cashier.privileges));
  const [mounted, setMounted] = useState(false);
  const notifs = unreadCount();
  const chatUnread = useChatUnread();

  useEffect(() => { setMounted(true); }, []);

  /* Install lives at the right of the header now (components/Header.tsx), not
     here: the bottom bar is for places you GO, and installing is an action.
     Dropping that sixth slot also gives the five real destinations their full
     labels back on a narrow phone. */

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
    // Second slot: POS for businesses with POS access, Orders for everyone else
    posAllowed ? {
      href: '/pos',
      label: 'POS',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
        </svg>
      ),
    } : {
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
      href: '/chat',
      label: 'Chat',
      badge: chatUnread > 0 ? chatUnread : null,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      ),
    },
    {
      href: '/notifications',
      label: 'Alerts',
      badge: notifs > 0 ? notifs : null,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
      ),
    },
    cashier ? {
      href: '/',
      label: 'Log Out',
      onClick: logoutCashier,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      ),
    } : {
      href: user ? '/profile' : '/auth/login',
      label: user ? 'Profile' : 'Login',
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
    /* `compact` shrinks the labels so a sixth slot still fits a 320px phone. */
    <nav className="bottom-nav">
      {items.map(item => {
        const isActive = item.href === '/' ? pathname === '/' : (pathname?.startsWith(item.href) ?? false);
        const onClick  = (item as { onClick?: () => void }).onClick;
        return onClick ? (
          <button key={item.label} className="nav-item" onClick={onClick} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            {item.icon}
            <span>{item.label}</span>
          </button>
        ) : (
          <Link key={item.href} href={item.href} className={`nav-item ${isActive ? 'active' : ''}`}>
            {item.icon}
            {mounted && item.badge != null && (
              <span className="badge nav-badge">{item.badge}</span>
            )}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
