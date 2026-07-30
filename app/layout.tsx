import type { Metadata, Viewport } from 'next';
import { Rubik, Nunito_Sans } from 'next/font/google';
import './globals.css';
import {
  SITE_URL, SITE_NAME, SITE_TITLE, SITE_DESCRIPTION, SITE_KEYWORDS, OG_IMAGE, siteJsonLd,
} from '@/lib/siteMeta';

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
import InstallGuide      from '@/components/InstallGuide';
import { BOOT_WATCHDOG_HTML, BOOT_WATCHDOG_SCRIPT } from '@/lib/bootWatchdog';
import { INSTALL_CAPTURE_SCRIPT } from '@/lib/installCapture';

// This app is fully dynamic (auth + real-time DB) — never statically pre-render.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  // Absolute base for canonicals, Open Graph images and the sitemap.
  metadataBase: new URL(SITE_URL),
  title: {
    default:  SITE_TITLE,
    // Inner pages get "Something — Hamar Mall" without repeating the tagline.
    template: `%s — ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  applicationName: SITE_NAME,
  manifest: '/manifest.json',
  alternates: { canonical: '/' },
  category: 'shopping',
  robots: {
    index: true, follow: true,
    googleBot: {
      index: true, follow: true,
      'max-image-preview': 'large',   // let Google show real product photos
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: 'en_US',
    alternateLocale: ['so_SO'],
    images: [{ url: OG_IMAGE, width: 512, height: 512, alt: `${SITE_NAME} logo` }],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
  // Explicit icon set. iOS only picks up apple-touch-icon; Android reads the
  // manifest; desktop browsers prefer the SVG and fall back to the PNGs.
  icons: {
    icon: [
      { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/favicon-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/icons/icon.svg', type: 'image/svg+xml' },
    ],
    apple: [
      { url: '/icons/apple-touch-icon.png', sizes: '180x180' },
      { url: '/icons/apple-touch-icon-167.png', sizes: '167x167' },
      { url: '/icons/apple-touch-icon-152.png', sizes: '152x152' },
    ],
    shortcut: ['/favicon.ico'],
  },
  appleWebApp: {
    capable: true,
    title: SITE_NAME,
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor:   '#1257E5',
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
        {/* Android adaptive icon + Windows tile colour. */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="msapplication-TileColor" content="#1257E5" />
        <meta name="msapplication-TileImage" content="/icons/icon-192.png" />
        {/* Structured data: Organization, WebSite (with a SearchAction so
            Google can render a search box) and OnlineStore. This is one of
            the few SEO signals a single-page app can still deliver properly. */}
        <script
          type="application/ld+json"
          // The payload is built from our own constants, never user input.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd()) }}
        />
      </head>
      {/* suppressHydrationWarning: browser extensions (ColorZilla, Grammarly…)
          inject attributes like cz-shortcut-listen onto <body> before React
          hydrates. Applies to this element's attributes only, not children. */}
      <body suppressHydrationWarning>
        {/* Boot watchdog — plain HTML + inline script, so it can speak up even
            when the app bundle hasn't arrived (slow link) or can't (offline).
            dangerouslySetInnerHTML keeps its subtree entirely out of React's
            hands, which is what lets the inline onclick work pre-hydration. */}
        <div
          id="hm-boot-warn"
          suppressHydrationWarning
          style={{
            display: 'none', position: 'fixed', inset: 0, zIndex: 10000,
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 24, background: 'var(--bg, #f1f5f9)', color: 'var(--text, #0f172a)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
          dangerouslySetInnerHTML={{ __html: BOOT_WATCHDOG_HTML }}
        />
        <script dangerouslySetInnerHTML={{ __html: BOOT_WATCHDOG_SCRIPT }} />
        {/* Catches the browser's one-shot install event before the bundle
            loads — otherwise it's lost and Install can only ever show
            instructions. See lib/installCapture.ts. */}
        <script dangerouslySetInnerHTML={{ __html: INSTALL_CAPTURE_SCRIPT }} />

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
              <InstallGuide />
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
