'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Renders its children in the SERVER HTML only.
 *
 * A crawler (and the very first paint) gets real, readable content. The moment
 * React hydrates and the interactive SPA takes over the same screen, this
 * removes itself so the shopper never sees the content twice.
 *
 * The first client render deliberately still returns the children — that keeps
 * it byte-identical to the server output, so hydration can't mismatch. Only
 * the effect afterwards drops it.
 */
export default function SeoOnly({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  if (hydrated) return null;
  return <>{children}</>;
}
