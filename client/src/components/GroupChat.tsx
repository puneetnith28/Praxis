import { useState, useEffect, useRef } from 'react';
import Ic from './Icons';
import * as api from '../api';
import type { Agent, GroupChatMsg } from '../api';
import type { WsApi } from '../hooks/useWebSocket';

interface Props {
  projectId: string;
  agents: Agent[];
  ws: WsApi;
}

function timeAgo(ts: string): string {
  const diffMs = Date.now() - new Date(ts).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return secs + 's';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Keep the newest entries only.
 *
 * This is a control centre people leave open for days with several chatty
 * agents. Appending forever meant the array, the dedupe scan and the render
 * all grew without limit, so the feed got slower the longer the project had
 * been useful. Older entries are still on disk.
 */
const FEED_LIMIT = 500;
function capFeed<T>(next: T[]): T[] {
  return next.length > FEED_LIMIT ? next.slice(-FEED_LIMIT) : next;
}

export default function GroupChat({ projectId, agents, ws }: Props) {
  const [messages, setMessages] = useState<GroupChatMsg[]>([]);
  const [composeBody, setComposeBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);
    api.listGroupChat(projectId)
      .then((data) => { if (!cancelled) setMessages(Array.isArray(data?.messages) ? data.messages : []); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    return ws.subscribe((msg) => {
      if (msg.type !== 'groupchat:message') return;
      const payload = msg.payload as GroupChatMsg | undefined;
      if (!payload || (payload.projectId && payload.projectId !== projectId)) return;
      setMessages((prev) => (prev.some((m) => m.id === payload.id) ? prev : capFeed([...prev, payload])));
    });
  }, [projectId, ws.subscribe]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = composeBody.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.sendGroupChat(projectId, text);
      setComposeBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const running = agents.filter((a) => a.status !== 'stopped').map((a) => a.name);

  return (
    <div className="panel gc-panel" data-tour="groupchat">
      <div className="panel-h">
        <div className="panel-h-l">
          <h2>Group Chat</h2>
          <span className="panel-sub">
            Messages go to every running agent · <code>@name</code> to pick one · Supervisor summaries land here
          </span>
        </div>
      </div>
      <div className="scroll gc-list">
        {messages.length === 0 ? (
          <div className="panel-empty">
            No messages yet. Say hello — everything you type here is delivered into your running agents' terminals.
          </div>
        ) : (
          messages.map((m) => {
            const isHuman = m.role === 'human' || m.role === 'user';
            const isSystem = m.role === 'supervisor';
            const cls = ['gc-msg'];
            if (isHuman) cls.push('mine');
            if (isSystem) cls.push('system');
            if (m.classification) cls.push('c-' + m.classification);
            return (
              <div key={m.id} className={cls.join(' ')}>
                <div className="gc-meta">
                  <strong>{m.sender}</strong>
                  {m.classification && m.classification !== 'noise' && (
                    <span className={'gc-chip ' + m.classification}>{m.classification.replace('_', ' ')}</span>
                  )}
                  <span className="gc-time">{timeAgo(m.ts)}</span>
                </div>
                <div className="gc-body">{m.text || m.message}</div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>
      <div className="gc-compose">
        {error && <div className="gc-error">{error}</div>}
        <div className="gc-compose-row">
          <textarea
            ref={inputRef}
            placeholder={running.length
              ? `Message ${running.length === 1 ? running[0] : running.length + ' running agents'}…  (@name to target one)`
              : 'No agents running — start one, then say something here'}
            rows={1}
            value={composeBody}
            onChange={(e) => setComposeBody(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Group chat message"
          />
          <button
            className="send-btn primary"
            onClick={() => void handleSend()}
            disabled={sending || !composeBody.trim()}
          >
            <Ic.send size={13} /> {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
