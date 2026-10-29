/**
 * Talking to the Keeper, live.
 *
 * Opens the microphone, streams raw PCM to `/ws/voice`, plays what comes back,
 * and surfaces the transcript and tool calls for the UI. Nova does the turn
 * detection, the interruption and the speech — none of the machinery in
 * `useWakeWord` / `useSpeechInput` / `utterance.ts` applies here, and this hook
 * deliberately does not reuse any of it.
 *
 * The one thing that is reused, in spirit, is the energy gate. Nova bills per
 * second of audio *sent*, and a socket that is open while you are not talking
 * would bill for the room. So the socket stays open — that is what makes it
 * answer instantly — but samples only go up the wire when there is something to
 * hear, plus a short tail so a word is never clipped mid-syllable. The
 * thresholds are the ones the existing VAD arrived at by measurement
 * (`useWakeWord.ts`), not fresh guesses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openPcmPipes, flushPlayback, playPcm, type PcmPipes } from '../audio/pcmWorklets';

/** Start talking above this; keep talking above the lower one. */
const START_LEVEL = 0.02;
const HOLD_LEVEL = 0.008;
/** Keep sending for this long after you stop, so trailing consonants survive. */
const TAIL_MS = 700;
/**
 * Send a frame at least this often even in silence. Nova drops a session after
 * 55 seconds with nothing on the wire; the server also tops this up, but doing
 * it here keeps the stream continuous rather than bursty.
 */
const KEEPALIVE_MS = 3000;

export type VoiceStatus = 'off' | 'connecting' | 'live' | 'error';

export interface RealtimeTranscriptLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface UseRealtimeVoice {
  status: VoiceStatus;
  /** Nova is talking right now. */
  speaking: boolean;
  /** You are talking right now — the gate is open. */
  hearing: boolean;
  transcript: RealtimeTranscriptLine[];
  lastTool: string | null;
  error: string | null;
  start: () => void;
  stop: () => void;
}

interface Options {
  /** Open the session. Nothing happens until this is true. */
  enabled: boolean;
  /** An agent's answer arriving minutes after it was asked. */
  onDeferred?: (text: string) => void;
}

export function useRealtimeVoice({ enabled, onDeferred }: Options): UseRealtimeVoice {
  const [status, setStatus] = useState<VoiceStatus>('off');
  const [speaking, setSpeaking] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [transcript, setTranscript] = useState<RealtimeTranscriptLine[]>([]);
  const [lastTool, setLastTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pipesRef = useRef<PcmPipes | null>(null);
  const wantRef = useRef(false);
  const deferredRef = useRef(onDeferred);
  deferredRef.current = onDeferred;

  const teardown = useCallback(() => {
    wantRef.current = false;
    try { wsRef.current?.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ }
    try { wsRef.current?.close(); } catch { /* ignore */ }
    wsRef.current = null;
    pipesRef.current?.close();
    pipesRef.current = null;
    setStatus('off');
    setSpeaking(false);
    setHearing(false);
  }, []);

  const connect = useCallback(async () => {
    if (wsRef.current || pipesRef.current) return;
    wantRef.current = true;
    setStatus('connecting');
    setError(null);

    let pipes: PcmPipes;
    try {
      pipes = await openPcmPipes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No microphone.');
      setStatus('error');
      return;
    }
    if (!wantRef.current) { pipes.close(); return; }
    pipesRef.current = pipes;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/voice`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    let voiceUntil = 0;
    let lastSentAt = 0;

    pipes.capture.port.onmessage = (e: MessageEvent) => {
      const { pcm, peak } = e.data as { pcm: ArrayBuffer; peak: number };
      if (ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();

      // Hysteresis: it takes more energy to start than to keep going, so the
      // quiet tail of a word does not close the gate mid-sentence.
      const open = now < voiceUntil ? peak > HOLD_LEVEL : peak > START_LEVEL;
      if (open) voiceUntil = now + TAIL_MS;
      const sending = now < voiceUntil;
      setHearing(sending);

      if (sending || now - lastSentAt > KEEPALIVE_MS) {
        lastSentAt = now;
        ws.send(pcm);
      }
    };

    pipes.playback.port.onmessage = (e: MessageEvent) => {
      const data = e.data as { playing?: boolean };
      if (typeof data?.playing === 'boolean') setSpeaking(data.playing);
    };

    ws.onopen = () => ws.send(JSON.stringify({ type: 'start' }));

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (pipesRef.current) playPcm(pipesRef.current.playback, ev.data);
        return;
      }
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'ready') { setStatus('live'); return; }
      if (msg.type === 'transcript') {
        setTranscript((prev) => {
          const next = [...prev, {
            id: `${Date.now()}-${prev.length}`,
            role: msg.role as 'user' | 'assistant',
            text: String(msg.text || ''),
          }];
          return next.length > 200 ? next.slice(-200) : next;
        });
        return;
      }
      if (msg.type === 'tool') { setLastTool(String(msg.name || '')); return; }
      if (msg.type === 'interrupted') {
        // Nova has stopped generating, but audio already on this side is still
        // queued. Without dropping it the user keeps hearing a sentence the
        // model abandoned — which is what makes an interruption feel ignored.
        if (pipesRef.current) flushPlayback(pipesRef.current.playback);
        setSpeaking(false);
        return;
      }
      if (msg.type === 'deferred') { deferredRef.current?.(String(msg.text || '')); return; }
      if (msg.type === 'error') {
        setError(String(msg.message || 'Voice error'));
        if (msg.fatal) setStatus('error');
        return;
      }
      if (msg.type === 'closed') setStatus(wantRef.current ? 'connecting' : 'off');
    };

    ws.onerror = () => { setError('Lost the voice connection.'); };
    ws.onclose = () => {
      if (!wantRef.current) return;
      // The server reconnects to Nova on its own; this only fires if the
      // browser-to-server hop dropped.
      setStatus('connecting');
      setTimeout(() => { if (wantRef.current) { wsRef.current = null; void connect(); } }, 1200);
    };
  }, []);

  useEffect(() => {
    if (enabled) void connect();
    else teardown();
    return () => { if (!enabled) teardown(); };
  }, [enabled, connect, teardown]);

  useEffect(() => () => teardown(), [teardown]);

  return {
    status, speaking, hearing, transcript, lastTool, error,
    start: () => { void connect(); },
    stop: teardown,
  };
}
