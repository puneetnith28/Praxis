/**
 * Messages panel — shows agent-to-agent MCP messages pulled from the
 * activity feed (agent:message events), with a composer that POSTs to the
 * same `/api/projects/:id/messages` endpoint the MCP server uses.
 */

import { useState, useEffect, useMemo } from 'react';
import Ic from './Icons';
import * as api from '../api';
import type { Agent, ActivityEvent } from '../api';
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
  return new Date(ts).toLocaleDateString();
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

export default function MessagesPanel({ projectId, agents, ws }: Props) {
  const [messages, setMessages] = useState<ActivityEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeFrom, setComposeFrom] = useState<string>('');
  const [composeTo, setComposeTo] = useState<string>('');
  const [composeBody, setComposeBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setSelectedId(null);
    setError(null);
    api.listActivity(projectId)
      .then((all) => {
        if (cancelled) return;
        const msgs = (Array.isArray(all) ? all : []).filter(e => e.event === 'agent:message');
        setMessages(msgs);
        if (msgs.length) setSelectedId(msgs[msgs.length - 1].id);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    return ws.subscribe((msg) => {
      if (msg.type !== 'activity') return;
      const ev = msg.event as ActivityEvent | undefined;
      if (!ev || ev.projectId !== projectId || ev.event !== 'agent:message') return;
      setMessages((prev) => (prev.some((m) => m.id === ev.id) ? prev : capFeed([...prev, ev])));
      setSelectedId((cur) => cur ?? ev.id);
    });
  }, [projectId, ws.subscribe]);

  // Default the composer to the first two agents; keep choices valid as agents change.
  useEffect(() => {
    const names = agents.map((a) => a.name);
    setComposeFrom((cur) => (cur && names.includes(cur)) ? cur : (names[0] || ''));
    setComposeTo((cur) => {
      const from = (composeFrom && names.includes(composeFrom)) ? composeFrom : names[0];
      if (cur && names.includes(cur) && cur !== from) return cur;
      return names.find((n) => n !== from) || '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  const sortedMessages = useMemo(() => [...messages].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()), [messages]);
  const selected = sortedMessages.find(m => m.id === selectedId);

  const handleSend = async () => {
    const body = composeBody.trim();
    if (!composeFrom || !composeTo || !body || sending) return;
    const sender = agents.find(a => a.name.toLowerCase() === composeFrom.toLowerCase());
    if (!sender) { setError('Sender not found'); return; }
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.sendAgentMessage(projectId, {
        fromAgentId: sender.id,
        fromAgentName: sender.name,
        target: composeTo,
        message: body,
      });
      setComposeBody('');
      setNotice(r.delivered
        ? `Delivered to ${r.toAgentName}.`
        : `${r.toAgentName} is not running — the message was logged but not delivered.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const composer = (
    <div className="msg-compose-full">
      {error && <div className="msg-error">{error}</div>}
      {notice && <div className="msg-notice">{notice}</div>}
      <textarea
        placeholder={agents.length < 2 ? 'Add a second agent to send messages between them' : 'Compose a message…'}
        rows={3}
        value={composeBody}
        onChange={(e) => setComposeBody(e.target.value)}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void handleSend(); }}
        disabled={agents.length < 2}
        aria-label="Message body"
      />
      <div className="msg-compose-footer">
        <div className="msg-compose-route">
          <select value={composeFrom} onChange={(e) => setComposeFrom(e.target.value)} aria-label="From agent">
            {agents.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
          <Ic.arrowR size={11} />
          <select value={composeTo} onChange={(e) => setComposeTo(e.target.value)} aria-label="To agent">
            {agents
              .filter(a => a.name !== composeFrom)
              .map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
        </div>
        <button
          className="send-btn primary"
          onClick={() => void handleSend()}
          disabled={sending || !composeBody.trim() || !composeFrom || !composeTo}
        >
          <Ic.send size={11} /> {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="panel msg-panel" data-tour="mcp">
      <div className="panel-h">
        <div className="panel-h-l">
          <h2>Messages</h2>
          <span className="panel-sub">
            Agent-to-agent handoffs via MCP · {messages.length} {messages.length === 1 ? 'message' : 'messages'}
          </span>
        </div>
      </div>
      <div className="msg-split">
        <div className="msg-col-list scroll">
          {sortedMessages.length === 0 ? (
            <div className="panel-empty" style={{ padding: 24 }}>
              No messages yet.<br />Ask an agent to "tell Backend I'm done", or compose one on the right.
            </div>
          ) : (
            sortedMessages.map(m => (
              <button
                key={m.id}
                className={'msg-row' + (selected && selected.id === m.id ? ' active' : '')}
                onClick={() => setSelectedId(m.id)}
              >
                <div className="msg-row-h">
                  <span className="from">{m.fromAgent || 'agent'}</span>
                  <span className="arrow">→</span>
                  <span className="to">{m.toAgent || 'agent'}</span>
                  <span className="ts">{timeAgo(m.timestamp)}</span>
                </div>
                <div className="msg-row-body">{m.message || m.detail}</div>
              </button>
            ))
          )}
        </div>
        <div className="msg-col-preview">
          {selected ? (
            <>
              <div className="msg-preview-h">
                <div className="msg-chip">{selected.fromAgent || 'agent'}</div>
                <Ic.arrowR size={11} />
                <div className="msg-chip">{selected.toAgent || 'agent'}</div>
                <div className="grow" />
                <span className="panel-sub">{timeAgo(selected.timestamp)}</span>
              </div>
              <div className="msg-preview-body">{selected.message || selected.detail}</div>
            </>
          ) : (
            <div className="panel-empty">Pick a message on the left, or send the first one below.</div>
          )}
          {composer}
        </div>
      </div>
    </div>
  );
}
