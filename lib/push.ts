'use client';

import { authHeaders } from '@/lib/clientAuth';

/**
 * Browser-side Web Push plumbing: service-worker registration, permission,
 * subscribe/unsubscribe. PushManager (component) auto-refreshes an existing
 * subscription on login; NotificationsView exposes the opt-in button.
 */

export function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    return reg;
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Why a subscribe attempt didn't complete — lets the UI show a real reason. */
export type PushSubscribeReason =
  | 'unsupported'   // browser can't do Web Push
  | 'insecure'      // not HTTPS (or localhost) — push is unavailable
  | 'no-vapid'      // NEXT_PUBLIC_VAPID_PUBLIC_KEY not set in this build
  | 'denied'        // user blocked notifications
  | 'sw-failed'     // service worker couldn't register
  | 'needs-setup'   // push_subscriptions table missing — run migration_v3_5.sql
  | 'unauthorized'  // not signed in
  | 'server'        // saving the subscription failed for some other reason
  | 'error';        // anything else

export interface PushSubscribeResult {
  ok: boolean;
  reason?: PushSubscribeReason;
  /** Raw server detail, surfaced so a misconfiguration is diagnosable. */
  detail?: string;
}

/**
 * Ask for permission (if needed) and register this browser for pushes,
 * tied to the signed-in user. Returns { ok, reason } so callers can explain
 * exactly what went wrong instead of a generic failure.
 */
export async function subscribeToPush(): Promise<PushSubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };
  // Push requires a secure context. Served over plain http:// on a LAN IP (the
  // usual way people test on a phone) the APIs exist but subscribe always
  // fails — worth naming, because it looks like a bug in the app.
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };

  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapid) return { ok: false, reason: 'no-vapid' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const reg = await ensureServiceWorker();
  if (!reg) return { ok: false, reason: 'sw-failed' };

  try {
    // Reuse an existing subscription: calling subscribe() again with the same
    // key returns the same one, but an OLD subscription made with a DIFFERENT
    // VAPID key throws InvalidStateError — so drop it first.
    const existing = await reg.pushManager.getSubscription();
    if (existing) { try { await existing.unsubscribe(); } catch { /* ignore */ } }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid).buffer as ArrayBuffer,
    });
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(sub.toJSON()),
    });
    if (res.ok) return { ok: true };

    // Server rejected the save. Roll the browser subscription back so a retry
    // is clean, and pass the real reason up — a silently-swallowed "table
    // missing" here is exactly what made this look mysteriously broken.
    const body = await res.json().catch(() => null);
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    if (res.status === 401) return { ok: false, reason: 'unauthorized' };
    return {
      ok: false,
      reason: body?.needsMigration ? 'needs-setup' : 'server',
      detail: body?.error ?? `HTTP ${res.status}`,
    };
  } catch (e) {
    return { ok: false, reason: 'error', detail: (e as Error)?.message };
  }
}

/** Human-readable, actionable message for a failed subscribe. */
export function pushReasonMessage(reason?: PushSubscribeReason): string {
  switch (reason) {
    case 'unsupported':  return 'This browser doesn’t support notifications.';
    case 'insecure':     return 'Notifications need a secure (https) connection.';
    case 'no-vapid':     return 'Notifications aren’t configured on this site yet.';
    case 'denied':       return 'Notifications are blocked — allow them in your browser settings.';
    case 'sw-failed':    return 'Couldn’t start the notification service. Try reloading the page.';
    case 'unauthorized': return 'Sign in first to enable notifications.';
    case 'needs-setup':  return 'Notifications aren’t set up on the server yet (run migration_v3_5.sql).';
    case 'server':       return 'The server couldn’t save your notification settings.';
    default:             return 'Couldn’t enable notifications. Please try again.';
  }
}

/** Silently re-sync an ALREADY-granted subscription (no permission prompt). */
export async function refreshPushSubscription(): Promise<void> {
  if (!isPushSupported() || Notification.permission !== 'granted') return;
  const reg = await ensureServiceWorker();
  if (!reg) return;
  try {
    const existing = await reg.pushManager.getSubscription();
    if (!existing) { await subscribeToPush(); return; }
    const sub = existing;
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(sub.toJSON()),
    });
  } catch { /* best-effort */ }
}

/** Unsubscribe this browser and delete the server row. */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ endpoint }),
    });
  } catch { /* best-effort */ }
}
