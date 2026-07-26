'use client';

/**
 * Hash route table. Order matters: specific patterns first,
 * '/:slug' (seller storefront catch-all) last.
 *
 * Every view is lazy-loaded so the initial bundle stays small —
 * a route's code is only fetched the first time it is visited.
 */

import dynamic from 'next/dynamic';
import type { RouteDef } from '@/lib/hashRouter';

const ViewLoading = () => (
  <div className="empty-state" style={{ marginTop: 80 }}>
    <div className="spinner" style={{ width: 28, height: 28 }} />
  </div>
);

const lazy = (loader: () => Promise<{ default: React.ComponentType }>) =>
  dynamic(loader, { ssr: false, loading: ViewLoading });

export const ROUTES: RouteDef[] = [
  { pattern: '/',              component: lazy(() => import('@/views/ExploreView')) },
  { pattern: '/dashboard',     component: lazy(() => import('@/views/DashboardView')) },
  { pattern: '/my-dashboard',  component: lazy(() => import('@/views/BusinessDashboardView')) },
  { pattern: '/inventory',     component: lazy(() => import('@/views/InventoryView')) },
  { pattern: '/customers',     component: lazy(() => import('@/views/CustomersView')) },
  { pattern: '/suppliers',     component: lazy(() => import('@/views/SuppliersView')) },
  { pattern: '/supplier/:id',  component: lazy(() => import('@/views/SupplierProfileView')) },
  { pattern: '/orders',        component: lazy(() => import('@/views/OrdersView')) },
  { pattern: '/orders/:id',    component: lazy(() => import('@/views/OrderTrackingView')) },
  { pattern: '/pos',           component: lazy(() => import('@/views/PosView')) },
  { pattern: '/settings',      component: lazy(() => import('@/views/SettingsView')) },
  { pattern: '/profile',       component: lazy(() => import('@/views/ProfileView')) },
  { pattern: '/billing',       component: lazy(() => import('@/views/BillingView')) },
  { pattern: '/checkout',         component: lazy(() => import('@/views/CheckoutView')) },
  { pattern: '/checkout/:shopId', component: lazy(() => import('@/views/CheckoutView')) },
  { pattern: '/payment/sifalo/return', component: lazy(() => import('@/views/SifaloReturnView')) },
  { pattern: '/chat',          component: lazy(() => import('@/views/ChatListView')) },
  { pattern: '/chat/:id',      component: lazy(() => import('@/views/ChatRoomView')) },
  { pattern: '/notifications', component: lazy(() => import('@/views/NotificationsView')) },
  { pattern: '/search',        component: lazy(() => import('@/views/SearchView')) },
  { pattern: '/wishlist',      component: lazy(() => import('@/views/WishlistView')) },
  { pattern: '/product/:id',   component: lazy(() => import('@/views/ProductDetailView')) },
  { pattern: '/admin',          component: lazy(() => import('@/views/AdminView')) },
  { pattern: '/staff',          component: lazy(() => import('@/views/StaffView')) },
  { pattern: '/cashier-login',  component: lazy(() => import('@/views/CashierLoginView')) },
  // Information pages — all rendered by LegalView, which switches on the path.
  { pattern: '/privacy',        component: lazy(() => import('@/views/LegalView')) },
  { pattern: '/terms',          component: lazy(() => import('@/views/LegalView')) },
  { pattern: '/refunds',        component: lazy(() => import('@/views/LegalView')) },
  { pattern: '/about',          component: lazy(() => import('@/views/LegalView')) },
  { pattern: '/contact',        component: lazy(() => import('@/views/LegalView')) },
  { pattern: '/auth/login',     component: lazy(() => import('@/views/LoginView')) },
  { pattern: '/auth/signup',    component: lazy(() => import('@/views/SignupView')) },
  { pattern: '/auth/callback',  component: lazy(() => import('@/views/AuthCallbackView')) },
  { pattern: '/auth/reset',     component: lazy(() => import('@/views/ResetPasswordView')) },
  // Seller storefront shortcuts — must stay LAST (generic catch-alls).
  // '/:slug'            → store landing (redirects to the supplier profile)
  // '/:slug/:productId' → a product within a store, e.g. /city-care-pharmacy/123
  { pattern: '/:slug',             component: lazy(() => import('@/views/SlugView')) },
  { pattern: '/:slug/:productId',  component: lazy(() => import('@/views/ProductDetailView')) },
];

export const NotFound = lazy(() => import('@/views/SlugView'));
