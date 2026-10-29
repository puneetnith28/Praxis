// Dual-key localStorage migration for Bedrock Codex settings
export const getCodexStorage = (key: string, fallback: string = ''): string => {
  try {
    return localStorage.getItem(`bedrock_codex_${key}`) ?? localStorage.getItem(`conduit_codex_${key}`) ?? fallback;
  } catch {
    return fallback;
  }
};
export const setCodexStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(`bedrock_codex_${key}`, value);
  } catch {}
};

/**
 * CodexAgentView — structured view for a Codex agent (v2.2).
 *
 * Codex agents run on `codex app-server`, which emits structured events; the
 * daemon maps them to CodexItems. Instead of a flat terminal log, this renders
 * a real conversation: markdown agent messages, collapsible command / tool /
 * file cards, red-green diffs. Used in place of <Terminal> for cli==='codex'.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Ic from './Icons';
import { renderMarkdown } from '../utils/md';
import type { WsApi } from '../hooks/useWebSocket';
import * as api from '../api';
import type { LocalHarnessInfo } from '../api';

interface CodexItem {
  id: string;
  kind: 'message' | 'reasoning' | 'command' | 'file' | 'tool' | 'error' | 'system';
  role?: 'agent' | 'user';
  text?: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  path?: string;
  diff?: string;
  server?: string;
  tool?: string;
  args?: string;
  result?: string;
  status?: 'running' | 'done' | 'failed';
  ts: string;
}

interface Props {
  agentId: string;
  ws: WsApi;
  onFocus?: () => void;
  focused?: boolean;
  /**
   * Which structured runtime feeds this view. LocalHarness (over ACP) emits
   * the same items as Codex, but has none of Codex's model / effort / thread
   * controls — its model is set per agent — and is sent to and stopped through
   * its own messages.
   */
  variant?: 'codex' | 'localharness';
  /** LocalHarness: the agent's project, for its controls. */
  projectId?: string;
}

const MODEL_KEY = 'conduit:codex-model';
const EFFORT_KEY = 'conduit:codex-effort';

export default function CodexAgentView({ agentId, ws, onFocus, focused, variant = 'codex', projectId }: Props) {
  const isCodex = variant === 'codex';
  const label = isCodex ? 'Codex' : 'LocalHarness';
  const [items, setItems] = useState<CodexItem[]>([]);
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) || '');
  const [effort, setEffort] = useState(() => localStorage.getItem(EFFORT_KEY) || '');
  const [models, setModels] = useState<string[]>([]);
  const [lhInfo, setLhInfo] = useState<LocalHarnessInfo | null>(null);
  const [lhError, setLhError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { try { localStorage.setItem(MODEL_KEY, model); } catch { /* ignore */ } }, [model]);
  useEffect(() => { try { localStorage.setItem(EFFORT_KEY, effort); } catch { /* ignore */ } }, [effort]);

  // Available models for the picker (codex `model/list`).
  useEffect(() => {
    if (!isCodex) return;
    let cancelled = false;
    fetch('/api/codex/models')
      .then((r) => r.json())
      .then((d) => { if (!cancelled && Array.isArray(d?.models)) setModels(d.models); })
      .catch(() => { /* picker just shows "default" */ });
    return () => { cancelled = true; };
  }, [isCodex]);

  // LocalHarness: its mode, the modes on offer and its model, refreshed while shown.
  useEffect(() => {
    if (isCodex || !projectId) return;
    let cancelled = false;
    const refresh = () => api.getLocalHarnessInfo(projectId, agentId)
      .then((i) => { if (!cancelled) setLhInfo(i); })
      .catch(() => { /* daemon restarting — keep the last */ });
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isCodex, projectId, agentId]);

  useEffect(() => {
    let attached = false;
    const attach = () => {
      if (!ws.isOpen()) return;
      setItems([]);
      ws.send({ type: 'terminal:attach', agentId });
      attached = true;
    };
    const unsubscribe = ws.subscribe((msg) => {
      if (msg.type === 'codex:item' && msg.agentId === agentId && msg.item) {
        const item = msg.item as CodexItem;
        setItems((prev) => {
          const idx = prev.findIndex((i) => i.id === item.id);
          if (idx >= 0) { const n = prev.slice(); n[idx] = item; return n; }
          return [...prev, item];
        });
      } else if (msg.type === 'ws:open') {
        attach();
      } else if (msg.type === 'ws:close') {
        attached = false;
      }
    });
    attach();
    return () => {
      unsubscribe();
      if (attached) ws.send({ type: 'terminal:detach', agentId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, ws.send, ws.subscribe, ws.isOpen]);

  useEffect(() => {
    if (focused) inputRef.current?.focus();
  }, [focused]);

  // Keep the latest item in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const submit = () => {
    const t = input.trim();
    if (!t) return;
    const ok = isCodex
      ? ws.send({
        type: 'codex:send', agentId, text: t,
        model: model || undefined, effort: effort || undefined,
      })
      : ws.send({ type: 'localharness:send', agentId, text: t });
    if (ok) setInput('');
  };

  const stopTurn = () => {
    ws.send({ type: 'localharness:cancel', agentId });
  };

  // LocalHarness's own slash commands, sent as a prompt — the way Zed sends them.
  const slash = (cmd: string) => { ws.send({ type: 'localharness:send', agentId, text: cmd }); };

  const changeMode = async (mode: string) => {
    if (!projectId) return;
    if (mode === 'unattended' && !confirm('Unattended turns every question into a yes — no approval gates for this agent. Continue?')) return;
    setLhError(null);
    try {
      await api.setLocalHarnessMode(projectId, agentId, mode);
      setLhInfo((i) => (i ? { ...i, mode } : i));
    } catch (err) { setLhError((err as Error).message); }
  };

  const startNewThread = () => {
    if (!confirm('Start a new thread? The current conversation stays on disk but this view resets.')) return;
    setItems([]);
    setExpanded(new Set());
    ws.send({ type: 'codex:new-thread', agentId });
  };

  const working = items.some((i) => i.status === 'running');

  return (
    <div className="cxv" onMouseDown={() => onFocus?.()}>
      {isCodex ? (
        <div className="cxv-toolbar">
          <select
            className="cxv-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            title="Model"
            aria-label="Model"
          >
            <option value="">Model: default</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select
            className="cxv-select"
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            title="Reasoning effort"
            aria-label="Reasoning effort"
          >
            <option value="">Reasoning: default</option>
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
          <div className="cxv-toolbar-sp" />
          <button className="cxv-newthread" onClick={startNewThread} title="Start a new thread">
            + New thread
          </button>
        </div>
      ) : (
        <div className="cxv-toolbar">
          <span className="cxv-select" style={{ border: 'none', opacity: 0.75 }} title="Model on the local server">
            {lhInfo?.model || 'local model'}
          </span>
          {lhInfo?.modes && lhInfo.modes.length > 0 && (
            <select
              className="cxv-select"
              value={lhInfo.mode || ''}
              onChange={(e) => void changeMode(e.target.value)}
              title={lhInfo.modes.find((m) => m.id === lhInfo.mode)?.description || 'Permission mode'}
              aria-label="Permission mode"
            >
              {lhInfo.modes.map((m) => <option key={m.id} value={m.id} title={m.description}>Mode: {m.name}</option>)}
            </select>
          )}
          <select className="cxv-select" value="" onChange={(e) => { if (e.target.value) slash('/effort ' + e.target.value); }} title="Reasoning effort (/effort)" aria-label="Reasoning effort">
            <option value="">Effort…</option>
            <option value="off">off</option>
            <option value="low">low</option>
            <option value="high">high</option>
            <option value="max">max</option>
          </select>
          <button className="cxv-newthread" onClick={() => slash('/pending')} title="List decisions LocalHarness parked (/pending)">Pending</button>
          {lhError && <span style={{ color: 'var(--danger, #d33)', fontSize: 12 }}>{lhError}</span>}
          <div className="cxv-toolbar-sp" />
          <button className="cxv-newthread" onClick={stopTurn} disabled={!working} title="Cancel the running turn">
            Stop
          </button>
        </div>
      )}
      <div className="cxv-body" ref={bodyRef}>
        {items.length === 0 && (
          <div className="cxv-empty">{ws.connected ? `Waiting for the ${label} agent…` : 'Reconnecting…'}</div>
        )}
        {items.map((it) => (
          <CodexItemRow
            key={it.id}
            item={it}
            open={expanded.has(it.id)}
            onToggle={() => toggle(it.id)}
          />
        ))}
        {working && (
          <div className="cxv-working">
            <span className="cxv-dot" /><span className="cxv-dot" /><span className="cxv-dot" />
            working…
          </div>
        )}
      </div>
      <div className="cxv-compose">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder={`Message this ${label} agent…  (Enter to send)`}
          rows={2}
          aria-label={`Message to ${label} agent`}
        />
        <button className="cxv-send" onClick={submit} disabled={!input.trim() || !ws.connected} title="Send" aria-label="Send">
          <Ic.send size={14} />
        </button>
      </div>
    </div>
  );
}

function CodexItemRow({ item, open, onToggle }: {
  item: CodexItem;
  open: boolean;
  onToggle: () => void;
}) {
  const it = item;

  if (it.kind === 'system') {
    return <div className="cxv-system">{it.text}</div>;
  }
  if (it.kind === 'error') {
    return <div className="cxv-error">{it.text}</div>;
  }
  if (it.kind === 'message') {
    if (it.role === 'user') {
      return <div className="cxv-msg user"><div className="cxv-bubble">{it.text}</div></div>;
    }
    return (
      <div className="cxv-msg agent">
        <div className="cxv-avatar"><Ic.bolt size={11} /></div>
        <div
          className="cxv-md"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(it.text || '') }}
        />
      </div>
    );
  }
  if (it.kind === 'reasoning') {
    return (
      <div className="cxv-card">
        <button className="cxv-card-h" onClick={onToggle} aria-expanded={open}>
          <Ic.chevR size={10} className={'cxv-chev' + (open ? ' rot' : '')} />
          <Ic.sparkles size={10} />
          <span className="cxv-card-t">Thinking</span>
        </button>
        {open && (
          <div
            className="cxv-card-b cxv-md cxv-reasoning"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(it.text || '') }}
          />
        )}
      </div>
    );
  }
  if (it.kind === 'command') {
    const show = open || it.status === 'running';
    return (
      <div className="cxv-card">
        <button className="cxv-card-h cxv-card-h-cmd" onClick={onToggle} aria-expanded={show}>
          <Ic.chevR size={10} className={'cxv-chev' + (show ? ' rot' : '')} />
          <Ic.terminal size={10} />
          <span className="cxv-card-t mono cxv-cmd-t">{it.command || '(command)'}</span>
          {it.status === 'running'
            ? <span className="cxv-badge run">running</span>
            : it.exitCode != null && (
              <span className={'cxv-badge ' + (it.exitCode === 0 ? 'ok' : 'err')}>
                exit {it.exitCode}
              </span>
            )}
        </button>
        {show && it.output && <pre className="cxv-card-b mono">{it.output.trimEnd()}</pre>}
      </div>
    );
  }
  if (it.kind === 'tool') {
    return (
      <div className="cxv-card">
        <button className="cxv-card-h" onClick={onToggle} aria-expanded={open}>
          <Ic.chevR size={10} className={'cxv-chev' + (open ? ' rot' : '')} />
          <Ic.bolt size={10} />
          <span className="cxv-card-t mono">
            {(it.server ? it.server + '/' : '') + (it.tool || 'tool')}
          </span>
          {it.status === 'running' && <span className="cxv-badge run">running</span>}
        </button>
        {open && (
          <div className="cxv-card-b">
            {it.args && <div className="cxv-kv"><span className="cxv-kv-k">args</span><pre className="mono">{it.args}</pre></div>}
            {it.result && <div className="cxv-kv"><span className="cxv-kv-k">result</span><pre className="mono">{it.result}</pre></div>}
          </div>
        )}
      </div>
    );
  }
  if (it.kind === 'file') {
    return (
      <div className="cxv-card">
        <button className="cxv-card-h" onClick={onToggle} aria-expanded={open}>
          <Ic.chevR size={10} className={'cxv-chev' + (open ? ' rot' : '')} />
          <Ic.file size={10} />
          <span className="cxv-card-t mono">{it.path || '(file)'}</span>
        </button>
        {open && it.diff && (
          <pre className="cxv-card-b cxv-diff mono">
            {it.diff.split('\n').map((line, i) => {
              let cls = '';
              if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
              else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
              else if (line.startsWith('@@')) cls = 'hunk';
              return <div key={i} className={'cxv-diff-l ' + cls}>{line || ' '}</div>;
            })}
          </pre>
        )}
      </div>
    );
  }
  return null;
}

// Memoized markdown rendering active
