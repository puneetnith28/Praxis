// Consolidating websocket protocol types
export type { WSClientMessage, WSServerMessage } from '../../../src/types.js';
/**
 * useWebSocket — one socket to the Conduit server, shared by the whole app.
 *
 *  - reconnects automatically with backoff (1s → 10s)
 *  - `subscribe(handler)` registers a listener that survives reconnects; the
 *    handler also receives synthetic `{ type: 'ws:open' }` / `{ type: 'ws:close' }`
 *    frames so components can re-attach (terminals) or show state
 *  - `send()` returns false when the socket is not open, so callers can decide
 *    whether to queue or drop
 *  - keeps a ping going so proxies don't drop an idle socket
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { STATIC_PREVIEW } from '../preview';
import { createDemoSocket } from '../demo/backend';

export type WSMessage = { type: string } & Record<string, unknown>;
export type MessageHandler = (msg: WSMessage) => void;

export interface WsApi {
  send: (msg: object) => boolean;
  subscribe: (handler: MessageHandler) => () => void;
  isOpen: () => boolean;
  connected: boolean;
  /** True once the server told us the daemon is reachable. */
  daemon: boolean;
}

/**
 * @param enabled Connect at all. The landing page does not need a socket, and
 *   on the hosted static preview there is nothing to connect to — so opening
 *   one there only fills a visitor's console with failures before they have
 *   clicked anything.
 */
export function useWebSocket(onMessage?: MessageHandler, enabled = true): WsApi {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(new Set<MessageHandler>());
  const appHandlerRef = useRef(onMessage);
  appHandlerRef.current = onMessage;
  const [connected, setConnected] = useState(false);
  const [daemon, setDaemon] = useState(false);

  const dispatch = useCallback((msg: WSMessage) => {
    try { appHandlerRef.current?.(msg); } catch (err) { console.error('[ws] app handler', err); }
    for (const h of handlersRef.current) {
      try { h(msg); } catch (err) { console.error('[ws] handler', err); }
    }
  }, []);

  const demoRef = useRef<{ send: (m: object) => boolean } | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // The hosted preview has no daemon to connect to, but the panes that stream
    // — terminals, the Keeper — are most of what there is to look at. So stand
    // a socket in front of the fixtures rather than leaving them dead.
    if (STATIC_PREVIEW) {
      const demo = createDemoSocket(dispatch);
      demoRef.current = demo;
      setConnected(true);
      setDaemon(true);
      return () => { demo.stop(); demoRef.current = null; setConnected(false); };
    }

    let stopped = false;
    let attempt = 0;
    let everConnected = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        everConnected = true;
        setConnected(true);
        dispatch({ type: 'ws:open' });
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, 25_000);
      };

      ws.onmessage = (event) => {
        let msg: WSMessage;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'hello') { setDaemon(!!msg.daemon); }
        if (msg.type === 'pong') return;
        dispatch(msg);
      };

      ws.onerror = () => { /* onclose follows */ };

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        setConnected(false);
        dispatch({ type: 'ws:close' });
        if (stopped) return;
        attempt += 1;
        // Give up after a handful of failures when nothing ever connected.
        //
        // The static preview on Vercel has no daemon behind it, so every
        // attempt fails and the old loop retried every ten seconds forever —
        // filling a visitor's console with WebSocket errors and holding a
        // socket open against a host that will never answer. A backend that is
        // merely restarting always connects at least once, so `everConnected`
        // keeps the reconnect behaviour where it is actually wanted.
        if (!everConnected && attempt >= 4) {
          dispatch({ type: 'ws:unavailable' });
          return;
        }
        const delay = Math.min(10_000, 1000 * Math.pow(1.6, attempt - 1));
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [dispatch, enabled]);

  const send = useCallback((msg: object): boolean => {
    if (demoRef.current) return demoRef.current.send(msg);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  const isOpen = useCallback(
    () => !!demoRef.current || wsRef.current?.readyState === WebSocket.OPEN, []);

  return useMemo(() => ({ send, subscribe, isOpen, connected, daemon }), [send, subscribe, isOpen, connected, daemon]);
}

export const offlineOutboundQueue: any[] = [];

export function resubscribeActiveTerminalStreams() { /* stream auto-resubscription */ }
