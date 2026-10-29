/**
 * useVoiceSession — the hands-free conversation.
 *
 * The wake word used to arm for exactly one command and then sleep, and its
 * only acknowledgement was a toast you had to be looking at. This turns it
 * into a conversation: say the phrase, hear a greeting, then keep talking
 * without pressing anything or repeating the phrase.
 *
 *   asleep ──phrase──▶ greeting ──spoken──▶ listening ──utterance──▶ dispatch
 *      ▲                                       │                        │
 *      └──── silence / "that's all" ───────────┘◀──── reply spoken ─────┘
 *
 * `useWakeWord` stays a dumb microphone; all conversation state lives here so
 * that changing it never tears down `getUserMedia` mid-sentence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWakeWord, type WakeProvider } from './useWakeWord';
import { speak, stopSpeaking, type TtsCfg } from '../utils/speech';
import { routeUtterance, type Route, type RosterAgent } from '../utils/voiceRouting';

export type SessionState = 'asleep' | 'greeting' | 'listening' | 'working';

/** Rolling silence that ends a conversation. */
const SILENCE_TIMEOUT_MS = 25_000;
/**
 * Hard stop on an open session. Every utterance in the cloud engine is a
 * billable request, so a forgotten session in a noisy room must not run all
 * day. Also bounds the wall-clock cost of a stuck state.
 */
const MAX_SESSION_MS = 10 * 60 * 1000;
const MAX_SESSION_UTTERANCES = 40;

const GREETINGS = [
  'Yes? What can I do?',
  "I'm listening.",
  'Go ahead.',
  'Yes?',
];

export interface VoiceSessionOptions {
  /** Master switch — the user's hands-free preference. */
  enabled: boolean;
  phrase: string;
  language?: string;
  provider?: WakeProvider;
  ttsCfg: TtsCfg;
  /** Every agent across every project, for name routing. */
  agents: RosterAgent[];
  selectedProjectId?: string | null;
  /** A gate is waiting — unlocks the reject vocabulary. */
  gateOpen?: boolean;
  /**
   * `true` when the wake phrase should be listened for continuously. False in
   * the desktop app, where each utterance is a paid transcription and a
   * session must be opened deliberately.
   */
  alwaysOn: boolean;
  /** Dispatch a routed command. Resolves with what to say back, if anything. */
  onRoute: (route: Route) => Promise<string | void> | string | void;
  /** Something makes listening impossible; the caller should switch off. */
  onUnavailable?: (reason: string) => void;
}

export function useVoiceSession(opts: VoiceSessionOptions) {
  const {
    enabled, phrase, language, provider, ttsCfg, agents, selectedProjectId,
    gateOpen, alwaysOn, onRoute, onUnavailable,
  } = opts;

  const [state, setState] = useState<SessionState>('asleep');
  const stateRef = useRef<SessionState>('asleep');
  const setSession = useCallback((s: SessionState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  // Read-through refs: the microphone effect must not re-run when these change.
  const ctxRef = useRef({ agents, selectedProjectId, gateOpen, ttsCfg, onRoute });
  useEffect(() => {
    ctxRef.current = { agents, selectedProjectId, gateOpen, ttsCfg, onRoute };
  });

  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionStartedAt = useRef(0);
  const utteranceCount = useRef(0);
  const lastSpokenReply = useRef('');

  const say = useCallback((text: string, priority: 0 | 1 | 2 = 1) => {
    speak(text, ctxRef.current.ttsCfg, { priority });
  }, []);

  const endSession = useCallback((farewell?: string) => {
    if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
    utteranceCount.current = 0;
    if (stateRef.current !== 'asleep' && farewell) say(farewell);
    setSession('asleep');
  }, [say, setSession]);

  /** Restart the rolling silence timer that closes an idle conversation. */
  const armSilence = useCallback(() => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    silenceTimer.current = setTimeout(() => {
      silenceTimer.current = null;
      endSession('Going quiet.');
    }, SILENCE_TIMEOUT_MS);
  }, [endSession]);

  const beginListening = useCallback(() => {
    setSession('listening');
    armSilence();
  }, [armSilence, setSession]);

  const startSession = useCallback((greet = true) => {
    sessionStartedAt.current = Date.now();
    utteranceCount.current = 0;
    if (greet) {
      setSession('greeting');
      say(GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);
      // The mic is muted while we speak; start the clock once that is over.
      setTimeout(beginListening, 300);
    } else {
      beginListening();
    }
  }, [beginListening, say, setSession]);

  /** One spoken command: route it, dispatch it, say the outcome. */
  const handleCommand = useCallback(async (text: string) => {
    if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }

    utteranceCount.current += 1;
    if (
      utteranceCount.current > MAX_SESSION_UTTERANCES ||
      Date.now() - sessionStartedAt.current > MAX_SESSION_MS
    ) {
      endSession('Ending the voice session.');
      return;
    }

    const { agents: roster, selectedProjectId: pid, gateOpen: gate } = ctxRef.current;
    const route = routeUtterance(text, { agents: roster, selectedProjectId: pid, gateOpen: gate });

    switch (route.kind) {
      case 'control':
        if (route.action === 'stop') { stopSpeaking(); beginListening(); return; }
        if (route.action === 'sleep') { endSession('Going quiet.'); return; }
        if (route.action === 'repeat') { say(lastSpokenReply.current || 'I have not said anything yet.'); beginListening(); return; }
        break;
      case 'refuse':
        say(route.reason);
        beginListening();
        return;
      case 'ambiguous':
        say(`I know more than one ${route.names[0] ? 'agent by that name' : 'agent'}: ${route.names.join(', ')}. Which one?`);
        beginListening();
        return;
      case 'unknown':
        say("I didn't catch that.");
        beginListening();
        return;
      default:
        break;
    }

    setSession('working');
    try {
      const spoken = await ctxRef.current.onRoute(route);
      if (typeof spoken === 'string' && spoken) {
        lastSpokenReply.current = spoken;
        say(spoken);
      }
    } catch (err) {
      say(err instanceof Error ? err.message : 'That failed.');
    }
    beginListening();
  }, [beginListening, endSession, say, setSession]);

  // The microphone. In 'conversation' mode every utterance is a command; in
  // 'wake' mode only the phrase matters.
  // Tell the recogniser which words to expect. Whisper decodes conditioned on
  // this, so naming the wake phrase and the live agents is the difference
  // between "Jarvis" and "darviz".
  const vocabulary = useMemo(() => {
    const names = agents.map((a) => a.name).filter(Boolean).slice(0, 20);
    return [
      phrase.split(/[,/|]/).map((p) => p.trim()).filter(Boolean).join('. '),
      'Conduit. The Keeper.',
      names.join(', '),
      'Start the agent, stop the agent, list the agents, approve, reject, status.',
    ].filter(Boolean).join(' ');
  }, [phrase, agents]);

  const wake = useWakeWord({
    enabled: enabled && (alwaysOn || stateRef.current !== 'asleep'),
    phrase,
    language,
    provider,
    vocabulary,
    mode: state === 'asleep' ? 'wake' : 'conversation',
    onWake: () => { startSession(true); },
    onCommand: (text) => {
      // Heard the phrase and a command in one breath while asleep — skip the
      // greeting, it would only delay the answer.
      if (stateRef.current === 'asleep') {
        sessionStartedAt.current = Date.now();
        utteranceCount.current = 0;
      }
      void handleCommand(text);
    },
    onUnavailable: (reason) => {
      endSession();
      onUnavailable?.(reason);
    },
  });

  // Tear the conversation down when the master switch goes off.
  useEffect(() => {
    if (!enabled && stateRef.current !== 'asleep') endSession();
  }, [enabled, endSession]);

  useEffect(() => () => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
  }, []);

  // Voice failures are invisible by nature — you cannot see why a microphone
  // did not hear you. Expose just enough to diagnose one from the console.
  useEffect(() => {
    (window as unknown as { __conduitVoice?: unknown }).__conduitVoice = {
      state,
      listening: wake.listening,
      supported: wake.supported,
      error: wake.error,
      enabled,
      alwaysOn,
      provider,
      phrase,
      // Lets the conversation be opened from the console, and by the
      // end-to-end test, exactly as the hotkey does.
      start: () => startSession(true),
      stop: () => endSession(),
    };
  });

  return {
    state,
    /** True when the microphone listens continuously without being asked. */
    alwaysOn,
    /** Whether the microphone is actually open. */
    listening: wake.listening,
    armed: state !== 'asleep',
    supported: wake.supported,
    error: wake.error,
    /** Open a conversation without the wake phrase (button / hotkey). */
    start: () => startSession(true),
    stop: () => endSession(),
    toggle: () => { if (stateRef.current === 'asleep') startSession(true); else endSession(); },
    /** Report a reply that arrived asynchronously (a Keeper answer). */
    reportReply: (text: string) => { lastSpokenReply.current = text; },
  };
}
