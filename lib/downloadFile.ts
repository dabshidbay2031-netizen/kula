'use client';

import { authHeaders } from '@/lib/clientAuth';

/**
 * Download a file from an authenticated API route.
 *
 * A plain <a href> cannot be used for these: every export endpoint is gated on
 * an `Authorization: Bearer <jwt>` header, and the browser does not attach it
 * to a normal navigation — the link would simply 401 and the user would see a
 * JSON error page instead of their data.
 *
 * So the file is fetched with credentials, turned into a blob, and saved via a
 * synthetic link. The object URL is revoked afterwards; without that, a few
 * large exports in one session keep their whole payload alive in memory.
 */
export async function downloadWithAuth(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { headers: await authHeaders() });

  if (!res.ok) {
    // The route returns JSON on failure — surface its message rather than
    // saving an error document as if it were the export.
    let message = `Download failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = String(body.error);
    } catch { /* non-JSON body — keep the status message */ }
    throw new Error(message);
  }

  // Prefer the server's filename: it already encodes the store and date range.
  const name = filenameFromDisposition(res.headers.get('Content-Disposition')) ?? fallbackName;

  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Safari needs the URL to outlive the click, so free it on the next tick.
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}

/** Pull `filename="…"` out of a Content-Disposition header, if present. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : null;
}
