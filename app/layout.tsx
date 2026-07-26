import type { Metadata, Viewport } from 'next';
import { Rubik, Nunito_Sans } from 'next/font/google';
import './globals.css';

const rubik = Rubik({
  subsets:  ['latin'],
  weight:   ['500', '600', '700', '800'],
  variable: '--font-display',
  display:  'swap',
});

const nunitoSans = Nunito_Sans({
  subsets:  ['latin'],
  weight:   ['400', '500', '600', '700', '800'],
  variable: '--font-body',
  display:  'swap',
  // Next 14 has no built-in fallback metrics for Nunito Sans — the CSS
  // var already falls back to the system stack, so skip the auto-adjust.
  adjustFontFallback: false,
});
import { AppProvider }        from '@/context/AppContext';
import { AuthProvider }       from '@/context/AuthContext';
import { I18nProvider }       from '@/context/I18nContext';
import { CashierProvider }    from '@/context/CashierContext';
import { HashRouterProvider } from '@/lib/hashRouter';
import BottomNav         from '@/components/BottomNav';
import Sidebar           from '@/components/Sidebar';
import Footer            from '@/components/Footer';
import CartDrawer        from '@/components/CartDrawer';
import ToastContainer    from '@/components/Toast';
import InstallPrompt     from '@/components/InstallPrompt';
import WishlistSync      from '@/components/WishlistSync';
import ApiAuthInstaller  from '@/components/ApiAuthInstaller';
import OfflineBanner     from '@/components/OfflineBanner';
import SyncManager       from '@/components/SyncManager';
import AiAssistant       from '@/components/AiAssistant';
import PushManager       from '@/components/PushManager';

// This app is fully dynamic (auth + real-time DB) — never statically pre-render.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Hamar Mall',
  description: 'E-commerce & Point of Sale',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  themeColor:   '#4F46E5',
  width:        'device-width',
  initialScale: 1,
  maximumScale: 1,
  // Draw under the iOS status bar / home indicator so env(safe-area-inset-*)
  // returns real values — the nav and page bottom padding depend on it, else
  // form submit buttons hide behind the home indicator in the installed app.
  viewportFit:  'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${rubik.variable} ${nunitoSans.variable}`}>
      <head>
        <link rel="preconnect" href="https://knnrmdkzoicjuuaaownb.supabase.co" />
        <link rel="dns-prefetch" href="https://knnrmdkzoicjuuaaownb.supabase.co" />
      </head>
      {/* suppressHydrationWarning: browser extensions (ColorZilla, Grammarly…)
          inject attributes like cz-shortcut-listen onto <body> before React
          hydrates. Applies to this element's attributes only, not children. */}
      <body suppressHydrationWarning>
        <HashRouterProvider>
        <AuthProvider>
        <CashierProvider>
          <I18nProvider>
            <AppProvider>
              <ApiAuthInstaller />
              <OfflineBanner />
              <SyncManager />
              <Sidebar />
              <div id="app">
                {children}
                {/* Inside #app so it sits after the page content and inherits
                    the desktop sidebar offset. */}
                <Footer />
              </div>
              <BottomNav />
              <CartDrawer />
              <ToastContainer />
              <AiAssistant />
              <InstallPrompt />
              <WishlistSync />
              <PushManager />
            </AppProvider>
          </I18nProvider>
        </CashierProvider>
        </AuthProvider>
        </HashRouterProvider>
      </body>
    </html>
  );
}
