'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter, useParams } from '@/lib/hashRouter';
import { useAuth } from '@/context/AuthContext';
import { getSupabase } from '@/lib/supabase';
import { authHeaders } from '@/lib/clientAuth';
import { CATEGORIES } from '@/lib/data';
import StoreAvatar from '@/components/StoreAvatar';
import type { ChatUser, Message } from '@/lib/types';
import {
  enqueueMessage, dequeueMessage, flushOutbox, outboxFor, onOutboxChange,
} from '@/lib/messageOutbox';

/** A text message whose whole content is just an image URL should render as
 *  the photo, not as a raw link (covers uploads saved without message_type). */
function contentAsImageUrl(content: string | null): string | null {
  const s = (content ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  if (/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(s)) return s;
  if (s.includes('/storage/v1/object/')) return s;
  return null;
}

/* ─── Profile modal ──────────────────────────────── */
function ProfileModal({
  user: cu, onClose, blocked, onToggleBlock,
}: {
  user: ChatUser;
  onClose: () => void;
  blocked: boolean;
  onToggleBlock: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  async function handleBlock() {
    if (busy) return;
    const verb = blocked ? 'unblock' : 'block';
    if (!confirm(`Are you sure you want to ${verb} ${cu.name}?`)) return;
    setBusy(true);
    try { await onToggleBlock(); } finally { setBusy(false); }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>👤 Profile</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="chat-profile-card">
            <div className="chat-profile-avatar"><StoreAvatar value={cu.avatar} fallback="👤" alt={`${cu.name} photo`} /></div>
            <div>
              <div className="chat-profile-name">
                {cu.name}
                {cu.verified && (
                  <span className="verified-badge-inline">✓ Verified</span>
                )}
              </div>
              <div className="chat-profile-type">
                {cu.type === 'business' ? '🏪 Business' : '👤 Customer'}
              </div>
            </div>
          </div>

          {cu.bio && (
            <div className="chat-profile-section">
              <div className="chat-profile-section-title">About</div>
              <p style={{ fontSize:'.87rem', color:'var(--text-muted)', lineHeight:1.6 }}>{cu.bio}</p>
            </div>
          )}

          {cu.location && (
            <div className="chat-profile-row">
              <span>📍</span>
              <span>{cu.location}</span>
            </div>
          )}

          {cu.categories && cu.categories.length > 0 && (
            <div className="chat-profile-section">
              <div className="chat-profile-section-title">Categories</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                {cu.categories.map(c => {
                  const cat = CATEGORIES.find(x => x.id === c);
                  return (
                    <span key={c} className="claim-tag">
                      {cat?.icon} {cat?.name ?? c}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {cu.contactNumbers && cu.contactNumbers.length > 0 && (
            <div className="chat-profile-section">
              <div className="chat-profile-section-title">Contact</div>
              {cu.contactNumbers.map((n, i) => (
                <a key={i} href={`tel:${n}`} className="chat-profile-row" style={{ color:'var(--primary)' }}>
                  <span>📞</span><span>{n}</span>
                </a>
              ))}
            </div>
          )}

          {/* Block / unblock — stops this user from messaging you and hides the
              conversation from your inbox. */}
          <button
            className="btn btn-ghost btn-full"
            onClick={handleBlock}
            disabled={busy}
            style={{ marginTop: 16, color: blocked ? 'var(--success)' : 'var(--danger)' }}
          >
            {busy ? '…' : blocked ? '✓ Unblock user' : '🚫 Block user'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Main chat room ─────────────────────────────── */
export default function ChatRoomPage() {
  const params     = useParams<{ id: string }>();
  const router     = useRouter();
  const { user }   = useAuth();
  const convId     = params.id;

  /* state */
  const [otherUser,   setOtherUser]   = useState<ChatUser | null>(null);
  const [messages,    setMessages]    = useState<Message[]>([]);
  const [msgLoading,  setMsgLoading]  = useState(true);
  const [text,        setText]        = useState('');
  const [sending,     setSending]     = useState(false);
  const [uploading,   setUploading]   = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [imgError,    setImgError]    = useState('');
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  /* block state: true when the caller has blocked the other user. The send
   * route also blocks if the OTHER user blocked the caller — surfaced as a
   * 403 on send, handled in sendText. */
  const [blocked,     setBlocked]     = useState(false);
  const [hasOlder,    setHasOlder]    = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const bottomRef  = useRef<HTMLDivElement>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef = useRef<any>(null);

  /* ── Load conversation details ─── */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        // viewerId is display convenience only — the server derives the real
        // viewer from the credential, so staff resolve to the owner correctly.
        const r = await fetch(`/api/conversations/${convId}`, {
          headers: await authHeaders(),
        });
        const d = await r.json();
        if (!cancelled && d.otherUser) setOtherUser(d.otherUser);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [convId, user]);

  /* ── Load my block list once, to know if THIS other user is blocked ─── */
  useEffect(() => {
    if (!user || !otherUser) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/blocks', { headers: await authHeaders() });
        const list = r.ok ? await r.json() : [];
        if (!cancelled && Array.isArray(list)) setBlocked(list.includes(otherUser.id));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [user, otherUser]);

  /* ── Load messages ─── */
  const PAGE = 50;
  const loadMessages = useCallback(async () => {
    setMsgLoading(true);
    try {
      const res  = await fetch(`/api/conversations/${convId}/messages?limit=${PAGE}`, { headers: await authHeaders() });
      const data = await res.json();
      if (Array.isArray(data)) {
        setMessages(data);
        // A full page back means there is probably more history behind it.
        setHasOlder(data.length === PAGE);
      }
    } catch { /* ignore */ }
    setMsgLoading(false);
  }, [convId]);

  /**
   * Older history. The server has always supported a `before` cursor, but the
   * client never asked — so a long conversation simply lost its beginning.
   */
  const loadOlder = useCallback(async () => {
    if (loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const oldest = messages[0]?.createdAt;
      const res  = await fetch(
        `/api/conversations/${convId}/messages?limit=${PAGE}&before=${encodeURIComponent(oldest)}`,
        { headers: await authHeaders() });
      const data = await res.json();
      if (Array.isArray(data)) {
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id));
          return [...(data as Message[]).filter(m => !seen.has(m.id)), ...prev];
        });
        setHasOlder(data.length === PAGE);
      }
    } catch { /* leave the button for another try */ }
    finally { setLoadingOlder(false); }
  }, [convId, messages, loadingOlder]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  /* ── Re-send anything stranded in the outbox ───
     Runs on open and whenever the browser regains connectivity, so a message
     written on a dead connection still arrives instead of vanishing. */
  useEffect(() => {
    if (!user) return;
    const flush = async () => {
      const sent = await flushOutbox(convId);
      if (sent > 0) { loadMessages(); setPendingCount(outboxFor(convId).length); }
    };
    flush();
    window.addEventListener('online', flush);
    const off = onOutboxChange(() => setPendingCount(outboxFor(convId).length));
    return () => { window.removeEventListener('online', flush); off(); };
  }, [convId, user, loadMessages]);

  /* ── Scroll to bottom when messages load/arrive ─── */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ── Mark messages as read ─── */
  useEffect(() => {
    if (!user || messages.length === 0) return;
    (async () => {
      fetch(`/api/conversations/${convId}/messages`, {
        method:  'PATCH',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({ readerId: user.id }),
      }).catch(() => {});
    })();
  }, [convId, user, messages]);

  /* ── Supabase Realtime subscription ─── */
  useEffect(() => {
    const sb = getSupabase();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = (sb.channel(`conv:${convId}`) as any)
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'messages',
          filter: `conversation_id=eq.${convId}`,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          const m = payload.new as Record<string, unknown>;
          const newMsg: Message = {
            id:             String(m.id),
            conversationId: String(m.conversation_id),
            senderId:       String(m.sender_id),
            content:        m.content    ? String(m.content)    : null,
            imageUrl:       m.image_url  ? String(m.image_url)  : null,
            messageType:    (m.message_type as 'text' | 'image') ?? 'text',
            readAt:         m.read_at    ? String(m.read_at)    : null,
            createdAt:      String(m.created_at),
          };
          setMessages(prev => {
            // Already have the persisted row (e.g. our own POST response landed first).
            if (prev.some(x => x.id === newMsg.id)) return prev;
            // Our own message echoed back over realtime *before* the POST response
            // resolved: reconcile it into the optimistic temp copy instead of
            // appending a duplicate — this is the "double message" the sender saw.
            const tempIdx = prev.findIndex(x =>
              x.id.startsWith('temp') &&
              x.senderId === newMsg.senderId &&
              (x.content  ?? '') === (newMsg.content  ?? '') &&
              (x.imageUrl ?? '') === (newMsg.imageUrl ?? '')
            );
            if (tempIdx !== -1) {
              const copy = [...prev];
              copy[tempIdx] = newMsg;
              return copy;
            }
            return [...prev, newMsg];
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'messages',
          filter: `conversation_id=eq.${convId}`,
        },
        // Only INSERTs were subscribed, so when the recipient read a message
        // and read_at was PATCHed, the sender's ✓ never became ✓✓ without a
        // reload — sellers assumed they were being ignored.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          const m = payload.new as Record<string, unknown>;
          const id = String(m.id);
          setMessages(prev => prev.map(x => x.id === id
            ? { ...x, readAt: m.read_at ? String(m.read_at) : null }
            : x));
        }
      )
      .subscribe();

    channelRef.current = channel;
    return () => { sb.removeChannel(channel); };
  }, [convId]);

  /* ── Send text message ─── */
  async function sendText() {
    if (!text.trim() || !user || sending) return;
    const content = text.trim();
    setText('');
    setSending(true);

    // Optimistic update
    const tempId = `temp-${Date.now()}`;
    setMessages(prev => [...prev, {
      id: tempId, conversationId: convId,
      senderId: user.id, content, imageUrl: null,
      messageType: 'text', readAt: null,
      createdAt: new Date().toISOString(),
    }]);

    await deliver(tempId, { content, imageUrl: null, messageType: 'text' });
    setSending(false);
  }

  /**
   * Push one message to the server and reconcile the optimistic bubble.
   *
   * A failure used to be swallowed entirely — no else branch — leaving a bubble
   * that looked delivered but never arrived. Now a failed send is marked, kept
   * in the outbox so it survives a reload, and retryable by tapping it.
   */
  const deliver = useCallback(async (
    tempId: string,
    msg: { content: string | null; imageUrl: string | null; messageType: 'text' | 'image' },
  ) => {
    if (!user) return;
    try {
      const res = await fetch(`/api/conversations/${convId}/messages`, {
        method:  'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({ senderId: user.id, ...msg }),
      });
      if (res.ok) {
        const saved = await res.json() as Message;
        dequeueMessage(tempId);
        setMessages(prev => prev.map(m => m.id === tempId ? saved : m));
        setPendingCount(outboxFor(convId).length);
        return;
      }
      // Refused for a reason retrying won't fix (blocked, not a participant).
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const body = await res.json().catch(() => ({}));
        dequeueMessage(tempId);
        setMessages(prev => prev.filter(m => m.id !== tempId));
        setImgError(body?.error || 'That message could not be sent.');
        return;
      }
      throw new Error('retryable');
    } catch {
      enqueueMessage({
        localId: tempId, conversationId: convId, senderId: user.id,
        content: msg.content, imageUrl: msg.imageUrl, messageType: msg.messageType,
      });
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, failed: true } : m));
      setPendingCount(outboxFor(convId).length);
    }
  }, [convId, user]);

  /** Tap a failed bubble to try again. */
  const retryMessage = useCallback(async (m: Message) => {
    setMessages(prev => prev.map(x => x.id === m.id ? { ...x, failed: false } : x));
    await deliver(m.id, {
      content: m.content, imageUrl: m.imageUrl, messageType: m.messageType,
    });
  }, [deliver]);

  /* ── Upload & send image ─── */
  async function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    // Validate
    if (!file.type.startsWith('image/')) { setImgError('Please select an image file'); return; }
    if (file.size > 10 * 1024 * 1024) { setImgError('Image must be under 10MB'); return; }
    setImgError('');
    setUploading(true);

    try {
      const sb   = getSupabase();
      const ext  = file.name.split('.').pop() ?? 'jpg';
      const path = `${user.id}/${Date.now()}.${ext}`;

      const { error: upErr } = await sb.storage
        .from('chat-images')
        .upload(path, file, { upsert: true });

      if (upErr) {
        setImgError(`Upload failed: ${upErr.message}`);
        setUploading(false);
        return;
      }

      const { data: urlData } = sb.storage.from('chat-images').getPublicUrl(path);
      const imageUrl = urlData.publicUrl;

      // Send as image message
      const tempId = `temp-img-${Date.now()}`;
      setMessages(prev => [...prev, {
        id: tempId, conversationId: convId,
        senderId: user.id, content: null, imageUrl,
        messageType: 'image', readAt: null,
        createdAt: new Date().toISOString(),
      }]);

      // Same delivery path as text: a failed image send is marked and queued
      // rather than left looking sent.
      await deliver(tempId, { content: null, imageUrl, messageType: 'image' });
    } catch {
      setImgError('Failed to send image. Make sure "chat-images" bucket exists in Supabase Storage.');
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  /* ── Format time ─── */
  function fmtTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  }

  /* ── Not logged in ─── */
  if (!user) {
    return (
      <div className="page-anim" style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'80vh', gap:12 }}>
        <div style={{ fontSize:'2rem' }}>🔐</div>
        <div style={{ fontWeight:700 }}>Sign in to chat</div>
        <button className="btn btn-primary" onClick={() => router.push('/auth/login')}>Sign In</button>
      </div>
    );
  }

  return (
    <div className="chat-room-wrap">
      {/* ── Header ─── */}
      <div className="chat-room-header">
        <button className="chat-back-btn" onClick={() => router.push('/chat')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
        </button>

        <button className="chat-header-user" onClick={() => setShowProfile(true)}>
          <div className="chat-room-avatar">
            <StoreAvatar value={otherUser?.avatar} fallback="👤" alt="Profile photo" />
            {otherUser?.verified && <span className="chat-verified-dot">✓</span>}
          </div>
          <div className="chat-header-info">
            <div className="chat-header-name">
              {otherUser?.name ?? '…'}
              {otherUser?.verified && (
                <span className="verified-badge-inline">✓</span>
              )}
            </div>
            <div className="chat-header-sub">
              {otherUser?.type === 'business' ? '🏪 Business' : '👤 Customer'}
              {' · Tap for profile'}
            </div>
          </div>
        </button>
      </div>

      {/* ── Messages ─── */}
      <div className="chat-messages-area">
        {msgLoading ? (
          <div style={{ textAlign:'center', padding:40, color:'var(--text-muted)' }}>
            <div className="spinner" style={{ margin:'0 auto 12px' }} />
            Loading messages…
          </div>
        ) : messages.length === 0 ? (
          <div className="chat-empty-state">
            <div style={{ fontSize:'3rem', marginBottom:12, width:72, height:72, borderRadius:'50%', overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <StoreAvatar value={otherUser?.avatar} fallback="💬" alt="Profile photo" />
            </div>
            <div style={{ fontWeight:700, marginBottom:6 }}>
              Start a conversation with {otherUser?.name ?? 'this person'}
            </div>
            <div style={{ fontSize:'.83rem', color:'var(--text-muted)' }}>
              Say hello! You can also send photos.
            </div>
          </div>
        ) : (
          <>
          {/* Older history — the chat used to stop dead at the newest 50. */}
          {hasOlder && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
              <button className="btn btn-ghost btn-sm" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : '↑ Load older messages'}
              </button>
            </div>
          )}
          {messages.map((msg, idx) => {
            const isMe    = msg.senderId === user.id;
            const prevMsg = idx > 0 ? messages[idx - 1] : null;
            const showTime = !prevMsg || (
              new Date(msg.createdAt).getTime() - new Date(prevMsg.createdAt).getTime() > 5 * 60 * 1000
            );

            return (
              <div key={msg.id}>
                {showTime && (
                  <div className="chat-time-divider">{fmtTime(msg.createdAt)}</div>
                )}
                <div className={`chat-msg-row${isMe ? ' me' : ' them'}`}>
                  {/* Avatar (other user only) */}
                  {!isMe && (
                    <button className="chat-msg-avatar" onClick={() => setShowProfile(true)}>
                      <StoreAvatar value={otherUser?.avatar} fallback="👤" alt="Profile photo" />
                    </button>
                  )}

                  {/* A photo message renders ONLY the photo — never the raw
                      storage URL (whether it landed in imageUrl or content). */}
                  {(() => { const img = msg.imageUrl ?? contentAsImageUrl(msg.content); return (
                  <div className={`chat-bubble${isMe ? ' me' : ' them'}`}>
                    {img ? (
                      <button
                        className="chat-bubble-img-btn"
                        onClick={() => setLightboxImg(img)}
                        aria-label="View image"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={img}
                          alt="Sent image"
                          className="chat-bubble-img"
                          onError={e => { (e.target as HTMLImageElement).style.display='none'; }}
                        />
                      </button>
                    ) : (
                      <span className="chat-bubble-text">{msg.content}</span>
                    )}
                    <span className="chat-bubble-time">
                      {fmtTime(msg.createdAt)}
                      {/* A failed send must never wear a ✓ — that's what made
                          the customer believe they had replied. */}
                      {isMe && msg.failed && ' ⚠'}
                      {isMe && !msg.failed && msg.readAt && ' ✓✓'}
                      {isMe && !msg.failed && !msg.readAt && msg.id.startsWith('temp') && ' ○'}
                      {isMe && !msg.failed && !msg.readAt && !msg.id.startsWith('temp') && ' ✓'}
                    </span>
                  </div>
                  ); })()}
                  {isMe && msg.failed && (
                    <button
                      onClick={() => retryMessage(msg)}
                      style={{
                        display: 'block', marginLeft: 'auto', marginTop: 2, padding: 0,
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--danger, #dc2626)', fontSize: '.72rem', fontWeight: 600,
                      }}
                    >
                      Not delivered · Tap to retry
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Input bar ─── */}
      <div className="chat-input-bar">
        {imgError && (
          <div style={{ padding:'4px 12px', fontSize:'.78rem', color:'var(--danger)', background:'rgba(239,68,68,.08)', borderRadius:6, margin:'0 0 6px' }}>
            {imgError}
          </div>
        )}
        <div className="chat-input-row">
          {/* Image upload button */}
          <button
            className="chat-img-btn"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            title="Send image"
          >
            {uploading ? (
              <span className="btn-spinner" style={{ width:18, height:18, borderWidth:2 }} />
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                <path d="M21 15l-5-5L5 21"/>
              </svg>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display:'none' }}
            onChange={handleImageSelect}
          />

          {/* Text input */}
          <input
            className="chat-text-input"
            placeholder="Type a message…"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } }}
            disabled={sending}
          />

          {/* Send button */}
          <button
            className="chat-send-btn"
            onClick={sendText}
            disabled={!text.trim() || sending}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Profile Modal ─── */}
      {showProfile && otherUser && (
        <ProfileModal
          user={otherUser}
          onClose={() => setShowProfile(false)}
          blocked={blocked}
          onToggleBlock={async () => {
            const next = !blocked;
            try {
              // POST takes a JSON body; DELETE takes a query param.
              const res = next
                ? await fetch('/api/blocks', {
                    method:  'POST',
                    headers: await authHeaders({ 'Content-Type': 'application/json' }),
                    body:    JSON.stringify({ blockedUid: otherUser.id }),
                  })
                : await fetch(`/api/blocks?blockedUid=${encodeURIComponent(otherUser.id)}`, {
                    method:  'DELETE',
                    headers: await authHeaders(),
                  });
              if (res.ok) { setBlocked(next); setShowProfile(false); }
            } catch { /* leave the toggle as it was */ }
          }}
        />
      )}

      {/* ── Image lightbox ─── */}
      {lightboxImg && (
        <div className="lightbox-overlay" onClick={() => setLightboxImg(null)}>
          <button className="lightbox-close" onClick={() => setLightboxImg(null)}>✕</button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxImg}
            alt="Full size"
            className="lightbox-img"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
