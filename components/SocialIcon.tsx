import type { SocialLink } from '@/lib/contactInfo';

/**
 * A social platform's own logo, drawn from the path data on the SocialLink.
 *
 * Painted in `currentColor` rather than the brand's colour (#1877F2 etc.) so
 * the row of icons reads as one set and stays legible on both themes — a
 * fixed Facebook blue disappears against a dark footer.
 */
export default function SocialIcon({ social, size = 16 }: { social: SocialLink; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      <path d={social.path} />
    </svg>
  );
}
