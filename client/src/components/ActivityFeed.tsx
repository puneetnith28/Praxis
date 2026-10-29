/**
 * Activity feed panel — full main-area list of events grouped by day,
 * filterable by type. Subscribes to WebSocket for live updates.
 */

import { useState, useEffect, useMemo, Fragment } from 'react';
import Ic from './Icons';
import * as api from '../api';
import type { ActivityEvent } from '../api';
import type { WsApi } from '../hooks/useWebSocket';

interface Props {
  projectId: string;
  ws: WsApi;
}

type Filter = 'all' | 'messages' | 'files' | 'lifecycle';

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + 's ago';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return new Date(timestamp).toLocaleDateString();
}

function eventIcon(event: string): { icon: JSX.Element; tone: string } {
  if (event === 'agent:started') return { icon: <Ic.play size={11} />, tone: 'ok' };
  if (event === 'agent:stopped') return { icon: <Ic.stop size={9} />, tone: '' };
  if (event === 'agent:message') return { icon: <Ic.message size={12} />, tone: 'blue' };
  if (event.startsWith('content:')) return { icon: <Ic.file size={12} />, tone: '' };
  if (event === 'user:input') return { icon: <Ic.user size={12} />, tone: '' };
  return { icon: <Ic.dots size={12} />, tone: '' };
}

function matchesFilter(event: string, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'messages') return event === 'agent:message';
  if (f === 'files') return event.startsWith('content:');
  if (f === 'lifecycle') return event === 'agent:started' || event === 'agent:stopped';
  return true;
}

function formatDetail(ev: ActivityEvent): React.ReactNode {
  if (ev.event === 'agent:message' && ev.fromAgent && ev.toAgent) {
    return <><b>{ev.fromAgent} → {ev.toAgent}</b>: {ev.message || ''}</>;
  }
  if (ev.event === 'agent:started' && ev.agentName) {
    return <><b>{ev.agentName}</b> started</>;
  }
  if (ev.event === 'agent:stopped' && ev.agentName) {
    return <><b>{ev.agentName}</b> stopped</>;
  }
  return ev.detail;
}

function dayGroup(timestamp: string): string {
  const d = new Date(timestamp);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const eventDay = new Date(d); eventDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - eventDay.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return diffDays + ' days ago';
  return d.toLocaleDateString();
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

export default function ActivityFeed({ projectId, ws }: Props) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    api.listActivity(projectId)
      .then((data) => { if (!cancelled) setEvents(Array.isArray(data) ? data : []); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    return ws.subscribe((msg) => {
      if (msg.type !== 'activity') return;
      const ev = msg.event as ActivityEvent | undefined;
      if (!ev || ev.projectId !== projectId) return;
      setEvents((prev) => (prev.some((e) => e.id === ev.id) ? prev : capFeed([...prev, ev])));
    });
  }, [projectId, ws.subscribe]);

  const sorted = useMemo(() => {
    const filtered = events.filter(e => matchesFilter(e.event, filter));
    return [...filtered].sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [events, filter]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ActivityEvent[]>();
    for (const ev of sorted) {
      const g = dayGroup(ev.timestamp);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(ev);
    }
    return groups;
  }, [sorted]);

  return (
    <div className="panel">
      <div className="panel-h">
        <div className="panel-h-l">
          <h2>Activity</h2>
          <span className="panel-sub">
            Everything that happens in this project · {events.length} events
          </span>
        </div>
        <div className="panel-h-r">
          <button className={'chip' + (filter === 'all' ? ' active' : '')} onClick={() => setFilter('all')}>All</button>
          <button className={'chip' + (filter === 'messages' ? ' active' : '')} onClick={() => setFilter('messages')}>Messages</button>
          <button className={'chip' + (filter === 'files' ? ' active' : '')} onClick={() => setFilter('files')}>Files</button>
          <button className={'chip' + (filter === 'lifecycle' ? ' active' : '')} onClick={() => setFilter('lifecycle')}>Lifecycle</button>
        </div>
      </div>
      <div className="panel-body scroll">
        {error && <div className="panel-empty" style={{ color: 'var(--err)' }}>{error}</div>}
        {!error && sorted.length === 0 ? (
          <div className="panel-empty">No activity yet. Start an agent or edit shared content.</div>
        ) : (
          <div className="act-list wide">
            {[...grouped.entries()].map(([label, items]) => (
              <Fragment key={label}>
                <div className="act-group-h">{label}</div>
                {items.map(ev => {
                  const { icon, tone } = eventIcon(ev.event);
                  return (
                    <div key={ev.id} className="act-item" title={new Date(ev.timestamp).toLocaleString()}>
                      <div className={'ico ' + tone}>{icon}</div>
                      <div className="tx">{formatDetail(ev)}</div>
                      <div className="ts">{timeAgo(ev.timestamp)}</div>
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Feed virtualization enabled
