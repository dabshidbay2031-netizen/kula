'use client';

import { useId } from 'react';

/**
 * The Hamar Mall brand mark — a padlock whose face carries the three bars.
 *
 * There were four hand-copied inline SVGs of the old bars-only mark (header,
 * mobile drawer, sidebar, footer, legal pages). Changing the logo meant editing
 * every one and hoping none drifted, so the artwork lives here now.
 *
 * Drawn in `currentColor` so it inherits the surrounding text colour and works
 * on light and dark alike. The bars are *punched out* of the lock body with a
 * mask rather than painted on top — that way they read as the background
 * showing through, exactly like the real logo, whatever colour sits behind.
 *
 * The mask needs a document-unique id: rendering two marks on one page with a
 * hardcoded id makes the second one reuse the first's mask. `useId()` gives
 * each instance its own, and stays stable across SSR/hydration.
 */
export default function BrandMark({
  size = 26,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const maskId = useId();

  return (
    <svg
      viewBox="0 0 28 28"
      width={size}
      height={size}
      fill="none"
      className={className}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Rounded-square field, as on the app icon. */}
      <rect width="28" height="28" rx="8" fill="currentColor" opacity=".15" />

      <mask id={maskId}>
        {/* White = keep, black = cut away. */}
        <rect x="4.8" y="10.7" width="18.4" height="15.6" rx="1.9" fill="#fff" />
        <rect x="8.3" y="15.1" width="11.4" height="1.5" rx=".75" fill="#000" />
        <rect x="8.3" y="18.3" width="11.4" height="1.5" rx=".75" fill="#000" />
        <rect x="8.3" y="21.4" width="7.3" height="1.5" rx=".75" fill="#000" />
      </mask>

      {/* Shackle first — the body then covers where its legs end. */}
      <path
        d="M10.8 11.5V6.9a3.2 3.2 0 0 1 6.4 0v4.6"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <rect
        x="4.8" y="10.7" width="18.4" height="15.6" rx="1.9"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
