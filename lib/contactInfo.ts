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
  icon:   string;
}

export const SOCIALS: SocialLink[] = [
  { name: 'Facebook', handle: 'official.hamarmall', icon: '📘',
    url: 'https://www.facebook.com/official.hamarmall' },
  { name: 'TikTok',   handle: 'hamarmall.com',      icon: '🎵',
    url: 'https://www.tiktok.com/@hamarmall.com' },
];

/** Every profile URL, for schema.org `sameAs`. */
export const SOCIAL_URLS = SOCIALS.map(s => s.url);

/** Default WhatsApp opener, so support sees which product the shopper meant. */
export const WHATSAPP_GREETING = 'Hi Hamar Mall, I need help with';
