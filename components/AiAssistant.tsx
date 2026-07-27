'use client';

import { useEffect, useRef, useState } from 'react';
import { OPEN_ASSISTANT_EVENT } from '@/lib/assistant';
import { useRouter } from '@/lib/hashRouter';

interface Msg { role: 'user' | 'assistant'; content: string }

/**
 * Render a chat message as text with inline markdown links. Supports only
 * [text](url) — anything else is shown verbatim. Internal links (starting with
 * "/") open in-app via the hash router instead of a full page reload, so the
 * assistant can deep-link to e.g. /signup-guide. Newlines are preserved
 * (the bubble CSS uses white-space: pre-wrap).
 */
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function MessageContent({ text }: { text: string }) {
  const router = useRouter();
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  // exec() is stateful with the /g flag, so we slice forward through the string.
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index < last) continue;       // overlap guard
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [, label, href] = m;
    const internal = href.startsWith('/');
    parts.push(
      <a
        key={`l${i++}`}
        href={internal ? `#${href}` : href}
        target={internal ? undefined : '_blank'}
        rel={internal ? undefined : 'noopener noreferrer'}
        className="ai-msg-link"
        onClick={(e) => {
          if (!internal) return;
          e.preventDefault();
          router.push(href);
        }}
      >
        {label}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const GREETING: Msg = {
  role: 'assistant',
  content: 'Salaan! 👋 Waxaan ahay Hamar Mall Assistant. Weydii wax kasta oo ku saabsan sida loo isticmaalo suuqa — iibsi, iib, lacag-bixin (Sifalo Pay), dalabyo, iwm.\n\nHi! I\'m the Hamar Mall Assistant — ask me anything about using the marketplace.',
};

/**
 * Public help assistant (Gemini-powered). Available app-wide; answers how-to
 * questions about using Hamar Mall. Mounted once in the root layout. It's opened
 * from the nav menu (Sidebar / mobile drawer) via the OPEN_ASSISTANT_EVENT bus —
 * there is no longer a floating in-page button.
 */
export default function AiAssistant() {
  const [open, setOpen]       = useState(false);
  const [msgs, setMsgs]       = useState<Msg[]>([GREETING]);
  const [input, setInput]     = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The nav menu opens the assistant by dispatching OPEN_ASSISTANT_EVENT.
  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener(OPEN_ASSISTANT_EVENT, openIt);
    return () => window.removeEventListener(OPEN_ASSISTANT_EVENT, openIt);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, open, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const next = [...msgs, { role: 'user' as const, content: text }];
    setMsgs(next);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch('/api/ai/assistant', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ messages: next.filter(m => m !== GREETING) }),
      });
      const data = await res.json();
      const reply = data.noKey
        ? 'AI assistant-ka weli lama dejin. (Add a free OPENROUTER_API_KEY to enable me.)'
        : data.reply || data.error || 'Waan ka xumahay, wax baa qaldamay. Fadlan mar kale isku day.';
      setMsgs(m => [...m, { role: 'assistant', content: reply }]);
    } catch {
      setMsgs(m => [...m, { role: 'assistant', content: 'Network error — fadlan mar kale isku day.' }]);
    }
    setLoading(false);
  };

  // No floating button anymore — the assistant only shows once opened from nav.
  if (!open) return null;

  return (
    <>
      <div className="ai-panel" role="dialog" aria-label="Hamar Mall Assistant">
          <div className="ai-panel-head">
            <span className="ai-panel-title">🤖 Hamar Mall Assistant</span>
            <button className="ai-panel-close" aria-label="Close" onClick={() => setOpen(false)}>✕</button>
          </div>

          <div className="ai-panel-body" ref={scrollRef}>
            {msgs.map((m, i) => (
              <div key={i} className={`ai-msg ${m.role}`}>
                <MessageContent text={m.content} />
              </div>
            ))}
            {loading && <div className="ai-msg assistant ai-typing"><span></span><span></span><span></span></div>}
          </div>

          <div className="ai-panel-input">
            <textarea
              rows={1}
              placeholder="Qor su'aashaada…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <button className="ai-send" onClick={send} disabled={loading || !input.trim()} aria-label="Send">➤</button>
          </div>
      </div>
    </>
  );
}
