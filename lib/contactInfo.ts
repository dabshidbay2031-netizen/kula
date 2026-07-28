/**
 * Real-world contact details and social profiles — one source of truth.
 *
 * Used by the footer, the contact page and the Organization structured data.
 * The structured-data use matters most: `sameAs` links and a `contactPoint`
 * are what let Google connect this site to the Facebook and TikTok accounts
 * and show them together, rather than treating each as an unrelated stranger.
 */

export interface PhoneLine {
  /** E.164 digits, no punctuation — what wa.me and tel: need. */
  e164:    string;
  /** Grouped for humans. */
  display: string;
  label:   string;
}

export const PHONES: PhoneLine[] = [
  { e164: '252612018955', display: '+252 61 201 8955', label: 'Calls & WhatsApp' },
  { e164: '252610567612', display: '+252 61 056 7612', label: 'Calls & WhatsApp' },
];

export const SUPPORT_EMAIL = 'support@hamarmall.com';

export const telHref      = (p: PhoneLine) => `tel:+${p.e164}`;
/**
 * wa.me is WhatsApp's own short link and works whether or not the app is
 * installed — on desktop it falls through to WhatsApp Web.
 */
export const whatsappHref = (p: PhoneLine, text?: string) =>
  `https://wa.me/${p.e164}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

export interface SocialLink {
  name:   string;
  url:    string;
  handle: string;
  /**
   * The platform's own mark, as SVG path data on a 24×24 grid.
   *
   * These were 📘 and 🎵 emoji — 🎵 is a musical note, not TikTok's logo, and
   * 📘 renders as a blue *book* on most platforms. Neither is recognisable as
   * the brand, and both change shape depending on the viewer's emoji font.
   * Path data renders identically everywhere and is the actual logo.
   */
  path:   string;
}

export const SOCIALS: SocialLink[] = [
  {
    name: 'Facebook', handle: 'official.hamarmall',
    url: 'https://www.facebook.com/official.hamarmall',
    path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
  },
  {
    name: 'TikTok', handle: 'hamarmall.com',
    url: 'https://www.tiktok.com/@hamarmall.com',
    path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
  },
];

/** Every profile URL, for schema.org `sameAs`. */
export const SOCIAL_URLS = SOCIALS.map(s => s.url);

/** Default WhatsApp opener, so support sees which product the shopper meant. */
export const WHATSAPP_GREETING = 'Hi Hamar Mall, I need help with';
