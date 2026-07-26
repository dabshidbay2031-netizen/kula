'use client';

import { authHeaders } from '@/lib/clientAuth';

/**
 * Unsent chat messages.
 *
 * A send that failed used to be swallowed: the optimistic bubble stayed on
 * screen with a ✓, so the customer believed they had replied and the seller
 * never received it — a silent lost sale that neither side could see.
 *
 * Anything that doesn't reach the server lands here, survives a reload, and is
 * retried when the connection comes back. Mirrors lib/offlineQueue (POS sales)
 * so there is one storage idiom in the app rather than two.
 */

const KEY = 'mg_msg_outbox';

export interface QueuedMessage {
  localId:        string;
  conversationId: string;
  senderId:       string;
  content:        string | null;
  imageUrl:       string | null;
  messageType:    'text' | 'image';
  queuedAt:       string;
}

type Listener = () => void;
const listeners = new Set<Listener>();
function notify() { listeners.forEach(fn => { try { fn(); } catch { /* ignore */ } }); }

export function onOutboxChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getOutbox(): QueuedMessage[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

function write(queue: QueuedMessage[]) {
  try { localStorage.setItem(KEY, JSON.stringify(queue)); } catch { /* storage full */ }
  notify();
}

/** Queue a message that failed to send. `localId` matches the optimistic bubble. */
export function enqueueMessage(msg: Omit<QueuedMessage, 'queuedAt'>): void {
  const queue = getOutbox();
  if (queue.some(q => q.localId === msg.localId)) return;   // already queued
  queue.push({ ...msg, queuedAt: new Date().toISOString() });
  write(queue);
}

export function dequeueMessage(localId: string): void {
  write(getOutbox().filter(q => q.localId !== localId));
}

/** Messages still waiting for a given conversation. */
export function outboxFor(conversationId: string): QueuedMessage[] {
  return getOutbox().filter(q => q.conversationId === conversationId);
}

/**
 * Try to deliver one queued message. Returns the saved message on success.
 *
 * A 4xx that isn't a timeout means the server refused it for good (blocked,
 * deleted conversation, no longer a participant) — drop it rather than retry
 * forever, otherwise the outbox jams behind an undeliverable message.
 */
export async function sendQueued(q: QueuedMessage): Promise<{ ok: boolean; saved?: unknown; dropped?: boolean }> {
  try {
    const res = await fetch(`/api/conversations/${q.conversationId}/messages`, {
      method:  'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify({
        senderId:    q.senderId,
        content:     q.content,
        imageUrl:    q.imageUrl,
        messageType: q.messageType,
      }),
    });
    if (res.ok) {
      dequeueMessage(q.localId);
      return { ok: true, saved: await res.json() };
    }
    // 429 = rate limited: keep it, try later. Other 4xx = permanent refusal.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      dequeueMessage(q.localId);
      return { ok: false, dropped: true };
    }
    return { ok: false };
  } catch {
    return { ok: false };            // offline — keep for the next attempt
  }
}

/** Attempt every queued message for a conversation, oldest first. */
export async function flushOutbox(conversationId: string): Promise<number> {
  let sent = 0;
  for (const q of outboxFor(conversationId)) {
    const r = await sendQueued(q);
    if (r.ok) sent++;
  }
  return sent;
}
