'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from '@/lib/hashRouter';
import Header from '@/components/Header';
import { useAuth } from '@/context/AuthContext';
import { useStoreActor } from '@/lib/useStoreActor';
import { useRealtimePing } from '@/lib/useRealtimePing';
import { authHeaders } from '@/lib/clientAuth';
import StoreAvatar from '@/components/StoreAvatar';
import type { ChatUser, Message } from '@/lib/types';

interface ConvItem {
  id:          string;
  otherUserId: string;
  otherUser?:  ChatUser;
  lastMessage?: Pick<Message, 'content' | 'imageUrl' | 'messageType' | 'senderId' | 'createdAt'> | null;
  unreadCount: number;
  updatedAt:   string;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s <  60)  return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric' });
}

function lastMsgPreview(msg: ConvItem['lastMessage'], myId: string): string {
  if (!msg) return 'Start a conversation…';
  const prefix = msg.senderId === myId ? 'You: ' : '';
  // Any photo message previews as "📷 Photo" — never as a raw storage URL.
  if (msg.messageType === 'image' || msg.imageUrl) return `${prefix}📷 Photo`;
  const content = msg.content ?? '';
  if (/^https?:\/\/\S+$/i.test(content.trim()) && content.includes('/storage/v1/object/')) {
    return `${prefix}📷 Photo`;
  }
  return `${prefix}${content}`;
}

export default function ChatListPage() {
  const router = useRouter();
  const { loading } = useAuth();
  const actor = useStoreActor();
  // Chat threads belong to the store OWNER's account, so STAFF with the 'chat'
  // privilege work the same inbox on their behalf.
  const chatUserId  = actor.ownerUserId;
  const staffBlocked = actor.isStaff && !actor.can('chat');

  const [convs,     setConvs]     = useState<ConvItem[]>([]);
  const [convLoading, setConvLoading] = useState(true);

  const loadConversations = useCallback(async () => {
    if (!chatUserId || staffBlocked) { setConvLoading(false); return; }
    setConvLoading(true);
    try {
      // The inbox is private — the API needs the caller's credentials. Staff
      // send a cashier token; both are attached by ApiAuthInstaller, but pass
      // them explicitly so this doesn't depend on the global fetch patch.
      const res  = await fetch(`/api/conversations?userId=${chatUserId}`, {
        headers: await authHeaders(),
      });
      if (!res.ok) { setConvs([]); setConvLoading(false); return; }
      const data = await res.json();
      if (!Array.isArray(data)) { setConvs([]); setConvLoading(false); return; }

      // The counterpart profile now rides along in this one response. Fetching
      // it per conversation turned a 100-thread inbox into 300+ requests.
      setConvs(data as ConvItem[]);
    } catch {
      setConvs([]);
    }
    setConvLoading(false);
  }, [chatUserId, staffBlocked]);

  useEffect(() => { loadConversations(); }, [loadConversations]);
  // Live: an incoming message pings this user's topic → list re-sorts/unreads
  // update instantly (the open room itself streams via postgres_changes).
  useRealtimePing([chatUserId ? `user:${chatUserId}` : null], loadConversations);

  /* ── Staff without the chat grant ─── */
  if (staffBlocked) {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div className="empty-state" style={{ marginTop: 60 }}>
          <div className="empty-icon">🔒</div>
          <div className="empty-title">Chat isn&apos;t part of your role</div>
          <div className="empty-sub">Ask the store owner to grant you the Chat permission.</div>
        </div>
      </div>
    );
  }

  /* ── Nobody signed in (no owner session AND no staff session) ─── */
  if (!loading && !actor.loading && !chatUserId) {
    return (
      <div className="page-anim">
        <Header showSearch={false} />
        <div className="empty-state" style={{ marginTop: 60 }}>
          <div className="empty-icon">💬</div>
          <div className="empty-title">Sign in to chat</div>
          <div className="empty-sub">You need an account to send messages</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }}
            onClick={() => router.push('/auth/login')}>Sign In</button>
        </div>
      </div>
    );
  }

  const totalUnread = convs.reduce((n, c) => n + c.unreadCount, 0);

  return (
    <div className="page-anim">
      <Header showSearch={false} />

      <div className="page-title-bar">
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span className="page-title">💬 Messages</span>
          {totalUnread > 0 && (
            <span className="chat-unread-pill">{totalUnread}</span>
          )}
        </div>
      </div>
      <p className="page-subtitle">Your conversations</p>

      {convLoading ? (
        <div style={{ padding: 16 }}>
          {[1,2,3].map(i => (
            <div key={i} className="chat-conv-item" style={{ pointerEvents:'none' }}>
              <div className="skeleton" style={{ width:52, height:52, borderRadius:'50%', flexShrink:0 }} />
              <div style={{ flex:1, display:'flex', flexDirection:'column', gap:8 }}>
                <div className="skeleton" style={{ height:13, width:'55%', borderRadius:6 }} />
                <div className="skeleton" style={{ height:11, width:'75%', borderRadius:6 }} />
              </div>
            </div>
          ))}
        </div>
      ) : convs.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 60 }}>
          <div className="empty-icon">💬</div>
          <div className="empty-title">No conversations yet</div>
          <div className="empty-sub">
            Visit a supplier&apos;s store page and tap &ldquo;Message&rdquo; to start chatting.
          </div>
          <button className="btn btn-primary" style={{ marginTop: 16 }}
            onClick={() => router.push('/suppliers')}>Browse Suppliers</button>
        </div>
      ) : (
        <div className="chat-conv-list">
          {convs.map(c => {
            const ou = c.otherUser;
            return (
              <button
                key={c.id}
                className="chat-conv-item"
                onClick={() => router.push(`/chat/${c.id}`)}
              >
                {/* Avatar */}
                <div className="chat-conv-avatar">
                  <StoreAvatar value={ou?.avatar} fallback="👤" alt={`${ou?.name ?? 'User'} photo`} />
                  {ou?.verified && (
                    <span className="chat-verified-dot" title="Verified">✓</span>
                  )}
                </div>

                {/* Info */}
                <div className="chat-conv-info">
                  <div className="chat-conv-name-row">
                    <span className="chat-conv-name">{ou?.name ?? 'Unknown'}</span>
                    {ou?.type === 'business' && (
                      <span className="chat-conv-type">Business</span>
                    )}
                    <span className="chat-conv-time">{timeAgo(c.updatedAt)}</span>
                  </div>
                  <div className="chat-conv-preview">
                    {lastMsgPreview(c.lastMessage, chatUserId!)}
                  </div>
                </div>

                {/* Unread badge */}
                {c.unreadCount > 0 && (
                  <span className="chat-unread-badge">{c.unreadCount}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
