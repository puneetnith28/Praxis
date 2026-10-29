/**
 * useWakeWord — always-on wake-word listening.
 *
 * Saying the configured wake phrase arms it and the next utterance is taken as
 * a command; saying "<phrase>, <command>" in one breath fires immediately.
 *
 * Two engines, chosen by `provider` — the same split as useSpeechInput:
 *
 *  - `'browser'`: the Web Speech API. Free, but Chrome/Edge only, and it
 *    streams audio to a Google service using API keys that Electron does not
 *    ship — so it fails with `error: 'network'` on every attempt inside the
 *    desktop app. That used to be swallowed as routine and retried forever,
 *    which is why the toggle could look on while nothing worked; repeated
 *    network failures now give up and report through `onUnavailable`.
 *
 *  - `'openai'` / `'gemini'`: capture the mic ourselves, cut it into
 *    utterances with a simple energy gate, and POST each one to
 *    `/api/voice/transcribe`. No Chromium speech service involved, so this
 *    works in the desktop app. Only actual speech is uploaded, but it is still
 *    a paid API call per utterance.
 *
 * `mode` decides what a recognised utterance means:
 *  - `'wake'`         — only the wake phrase matters (the always-on default).
 *  - `'conversation'` — every utterance is a command; the caller is holding a
 *                       conversation open and does not want to repeat the
 *                       phrase before each sentence.
 *
 * While Conduit is speaking, capture is muted for the purpose of *collecting*
 * an utterance: an open mic hears our own text-to-speech and transcribes it as
 * a command, which loops and bills a request per lap.
 *
 * It is not deaf, though. The gate keeps sampling for one thing only — you
 * talking over it, loudly and for long enough that it cannot be our own audio
 * leaking back in. That cuts the speech off and starts listening, which is what
 * interrupting is supposed to do.
 */

import { useEffect, useRef, useState } from 'react';
import { subscribeSpeaking, isSpeaking, isLikelySelfEcho, stopSpeaking } from '../utils/speech';
import { UtteranceAssembler } from '../utils/utterance';
import { matchWakePhrase } from '../utils/voiceRouting';

const ARM_TIMEOUT = 9000;       // 'wake' mode: disarm if no command follows the phrase
/** Audio keeps playing briefly after onended/onend fire — let the tail pass. */
const ECHO_GUARD_MS = 400;
/**
 * How long to wait after a final transcript before treating it as complete.
 *
 * The Web Speech API emits a final result at every pause, so dispatching each
 * one immediately meant a sentence with a pause in it executed on its first
 * half. Fragments are joined until the user has genuinely stopped talking.
 */
const COMMAND_SETTLE_MS = 1200;
/** Consecutive `network` errors before we stop retrying and say so. */
const NETWORK_GIVE_UP = 3;
/** Consecutive transcription failures before we stop — each one is billable. */
const TRANSCRIBE_GIVE_UP = 3;
/**
 * Ceiling on transcriptions per minute for a cloud engine.
 *
 * A person speaking constantly does not reach this; a television in the room
 * would. It bounds what an always-on paid recogniser can spend while the user
 * is not even in the room.
 */
const MAX_UPLOADS_PER_MIN = 30;

// --- energy gate (cloud engine) ---------------------------------------
const VAD_POLL_MS = 50;
/**
 * Silence that ends an utterance. People pause mid-sentence to think, and at
 * 800ms a pause like "start the agent… called gere" was cut in two and the
 * first half dispatched as a command.
 */
const SILENCE_MS = 1500;
/** Ignore anything shorter — a cough should not cost an API call. */
const MIN_UTTERANCE_MS = 350;
/** Hard cap, so one long noise never uploads an enormous clip. */
const MAX_UTTERANCE_MS = 15_000;
/** Recycle the recorder during silence so its buffer cannot grow forever. */
const IDLE_RECYCLE_MS = 10_000;
/**
 * Two thresholds. Speech clears the higher bar to start and only the lower one
 * to continue, so the quiet tail of a word does not register as silence and
 * split a sentence in two.
 */
const MIN_SPEECH_RMS = 0.02;
const HOLD_SPEECH_RMS = 0.008;
/**
 * Talking over Conduit while it speaks.
 *
 * Deliberately far above the normal speech gate and required to hold for a
 * moment: the microphone is open while our own audio is playing, and a barge-in
 * that fires on leakage would have Conduit cutting itself off mid-sentence
 * forever. Echo cancellation is on, so real leakage sits well under this.
 */
const BARGE_IN_RMS = 0.06;
const BARGE_IN_SUSTAIN_MS = 280;
/** After we cut our own audio there is nothing left to leak, so barely wait. */
const BARGE_GUARD_MS = 120;

export type WakeProvider = 'browser' | 'openai' | 'gemini' | 'groq';
export type ListenMode = 'wake' | 'conversation';

interface WakeOptions {
  enabled: boolean;
  /** The wake phrase to listen for, in the same language as `language`. */
  phrase: string;
  /** BCP-47 tag for recognition, e.g. "en-US". Defaults to the browser language. */
  language?: string;
  /** Which engine to listen with. Defaults to the browser's Web Speech API. */
  provider?: WakeProvider;
  /**
   * 'wake' waits for the phrase; 'conversation' treats every utterance as a
   * command. Read through a ref so changing it does not tear down the
   * microphone — re-acquiring getUserMedia mid-conversation drops audio and
   * flashes the browser's recording indicator.
   */
  mode?: ListenMode;
  onWake: () => void;
  onCommand: (text: string) => void;
  /** Listening cannot work at all — the caller should switch the toggle off. */
  onUnavailable?: (reason: string) => void;
  /**
   * Words this recogniser should expect — the wake phrase and the live agent
   * names. Cloud engines use it to bias decoding; the browser engine ignores
   * it, having no equivalent.
   */
  vocabulary?: string;
}

export function useWakeWord({
  enabled, phrase, language, provider = 'browser', mode = 'wake', vocabulary,
  onWake, onCommand, onUnavailable,
}: WakeOptions) {
  const [armed, setArmed] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armedRef = useRef(false);
  const phraseRef = useRef(phrase);
  const cbRef = useRef({ onWake, onCommand, onUnavailable });
  const modeRef = useRef(mode);
  const vocabRef = useRef(vocabulary);
  useEffect(() => {
    phraseRef.current = phrase;
    modeRef.current = mode;
    vocabRef.current = vocabulary;
    cbRef.current = { onWake, onCommand, onUnavailable };
  });
  const lang = language || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en-US';

  const SR =
    typeof window !== 'undefined'
      ? (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
          .SpeechRecognition ||
        (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
      : undefined;
  const mediaSupported =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const supported = provider === 'browser' ? !!SR : mediaSupported;

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    const setArmedState = (v: boolean) => { armedRef.current = v; setArmed(v); };

    let armTimer: ReturnType<typeof setTimeout> | null = null;
    const clearArmTimer = () => { if (armTimer) { clearTimeout(armTimer); armTimer = null; } };

    // A sentence arrives in fragments — the recogniser finalises at every
    // pause. Join them and dispatch only once the user has actually stopped,
    // or "start the agent… called gere" runs as "start the agent".
    // See scripts/test-utterance.mjs for the behaviour this guarantees.
    const assembler = new UtteranceAssembler(
      (text) => cbRef.current.onCommand(text),
      { settleMs: COMMAND_SETTLE_MS },
    );
    const clearSettle = () => assembler.reset();
    const dispatchSettled = (fragment: string) => assembler.push(fragment);

    /** Shared by both engines: match the phrase, arm, or fire a command. */
    const handleTranscript = (raw: string) => {
      const text = raw.trim();
      if (!text) return;

      // Backstop for the mute interlock: if this is our own greeting coming
      // back through the microphone, drop it rather than run it as a command.
      if (isLikelySelfEcho(text)) return;

      // In a conversation the caller has already established intent — every
      // utterance is a command, with no phrase to repeat.
      if (modeRef.current === 'conversation') {
        clearArmTimer();
        setArmedState(false);
        // Saying the phrase again mid-conversation is harmless — strip it.
        const again = matchWakePhrase(text, phraseRef.current);
        const body = again.hit ? (again.rest || '') : text;
        if (body) dispatchSettled(body);
        return;
      }

      if (armedRef.current) {
        clearArmTimer();
        setArmedState(false);
        dispatchSettled(text);
        return;
      }
      const matched = matchWakePhrase(text, phraseRef.current);
      if (!matched.hit) return;
      const after = matched.rest;
      if (after) {
        cbRef.current.onCommand(after);
      } else {
        setArmedState(true);
        cbRef.current.onWake();
        clearArmTimer();
        armTimer = setTimeout(() => { armTimer = null; setArmedState(false); }, ARM_TIMEOUT);
      }
    };

    /** Give up for good, and tell the caller why. */
    const giveUp = (reason: string) => {
      if (stopped) return;
      stopped = true;
      setListening(false);
      setError(reason);
      cbRef.current.onUnavailable?.(reason);
    };

    // ── engine A: the browser's Web Speech API ───────────────────────────
    const runBrowser = () => {
      const Rec = SR as { new (): SpeechRecognitionLike } | undefined;
      if (!Rec) { giveUp('this browser has no speech recognition'); return () => {}; }

      let rec: SpeechRecognitionLike | null = null;
      let restartTimer: ReturnType<typeof setTimeout> | null = null;
      let restarts = 0;
      let networkErrors = 0;
      let muted = false;
      // Whether the current recogniser ever actually ran. Chrome ends
      // continuous recognition by itself every so often; that is a normal
      // cycle, not a failure, and backing off after it left multi-second
      // windows where the wake phrase simply was not heard — which is why it
      // worked only sometimes.
      let ranOk = false;

      const scheduleRestart = () => {
        if (stopped || restartTimer) return;
        if (ranOk) {
          // Normal end of a healthy session — get back to listening at once.
          ranOk = false;
          restarts = 0;
          restartTimer = setTimeout(() => { restartTimer = null; start(); }, 50);
          return;
        }
        // It never got going: something is wrong, so ease off.
        restarts += 1;
        const delay = Math.min(15_000, 600 * Math.pow(1.5, Math.min(restarts, 8)));
        restartTimer = setTimeout(() => { restartTimer = null; start(); }, delay);
      };

      const start = () => {
        if (stopped || muted) return;
        let r: SpeechRecognitionLike;
        try { r = new Rec(); }
        catch (err) { giveUp('could not start speech recognition: ' + String(err)); return; }
        r.lang = lang;
        r.continuous = true;
        r.interimResults = false;
        r.onstart = () => { setListening(true); setError(null); restarts = 0; ranOk = true; };
        r.onspeechstart = () => { /* no-op */ };
        r.onresult = (e: SpeechResultEvent) => {
          const last = e.results?.[e.results.length - 1];
          if (!last || !last.isFinal) return;
          networkErrors = 0;   // it is working — forget past transient failures
          handleTranscript(String(last[0]?.transcript || ''));
        };
        r.onerror = (ev: { error?: string }) => {
          const code = String(ev?.error || '');
          if (code === 'not-allowed' || code === 'service-not-allowed') {
            giveUp('microphone blocked — allow mic access, then switch the wake word back on');
            return;
          }
          if (code === 'network') {
            // One or two of these are routine. A run of them means the speech
            // service is simply not reachable from this runtime, which is
            // always the case inside the Electron app.
            networkErrors += 1;
            if (networkErrors >= NETWORK_GIVE_UP) {
              giveUp(
                'speech recognition is unavailable in the desktop app. '
                + 'Pick OpenAI or Gemini under Voice settings to use the wake word here, '
                + 'or open Conduit at localhost:3200 in Chrome or Edge.',
              );
            }
          }
          // 'no-speech' / 'aborted' are normal during continuous listening.
        };
        r.onend = () => { rec = null; setListening(false); if (!stopped) scheduleRestart(); };
        rec = r;
        try { r.start(); }
        catch { rec = null; scheduleRestart(); }
      };

      // Stop recognising while Conduit talks, or it transcribes its own voice.
      const unsub = subscribeSpeaking((speaking) => {
        if (stopped) return;
        muted = speaking;
        if (speaking) {
          if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
          try { rec?.abort(); } catch { /* ignore */ }
          rec = null;
        } else {
          // Reset the backoff. Each mute aborts recognition, which counts as
          // an early end and would otherwise ratchet the retry delay towards
          // its 15s ceiling — leaving the mic deaf for the rest of the
          // conversation after only a few exchanges.
          restarts = 0;
          setTimeout(() => { if (!stopped && !muted) start(); }, ECHO_GUARD_MS);
        }
      });

      if (!isSpeaking()) start(); else muted = true;
      return () => {
        unsub();
        if (restartTimer) clearTimeout(restartTimer);
        try { rec?.abort(); } catch { /* ignore */ }
        rec = null;
      };
    };

    // ── engine B: our own mic capture + /api/voice/transcribe ────────────
    const runCloud = () => {
      let stream: MediaStream | null = null;
      let audioCtx: AudioContext | null = null;
      let mr: MediaRecorder | null = null;
      let vadTimer: ReturnType<typeof setInterval> | null = null;
      let unsubSpeaking: (() => void) | null = null;
      let chunks: BlobPart[] = [];
      let segmentStart = 0;
      let speechStart = 0;
      let lastVoiceAt = 0;
      let noiseFloor = 0.005;
      let mime = '';
      let muted = false;
      let unmuteAt = 0;

      /**
       * Send one utterance for transcription. Consecutive failures stop the
       * whole thing: an exhausted quota or a bad key would otherwise upload
       * every utterance forever, and each one is a billable request.
       */
      let failures = 0;
      let uploadTimes: number[] = [];
      let rateWarned = false;
      const transcribe = async (blob: Blob) => {
        if (stopped || blob.size === 0) return;

        // Rate ceiling: sustained speech nearby (a TV, a meeting) would
        // otherwise upload continuously on a metered API.
        const now = Date.now();
        uploadTimes = uploadTimes.filter((t) => now - t < 60_000);
        if (uploadTimes.length >= MAX_UPLOADS_PER_MIN) {
          if (!rateWarned) {
            rateWarned = true;
            setError('too much speech nearby — pausing transcription for a moment');
          }
          return;
        }
        uploadTimes.push(now);
        rateWarned = false;
        const fail = (msg: string) => {
          failures += 1;
          setError(msg);
          if (failures >= TRANSCRIBE_GIVE_UP) {
            giveUp(`speech-to-text keeps failing — ${msg.slice(0, 200)}`);
          }
        };
        try {
          const params = new URLSearchParams();
          if (lang) params.set('language', lang);
          const vocab = vocabRef.current;
          if (vocab) params.set('vocab', vocab);
          const q = params.toString() ? `?${params}` : '';
          const res = await fetch('/api/voice/transcribe' + q, {
            method: 'POST',
            headers: { 'Content-Type': blob.type || 'audio/webm' },
            body: blob,
          });
          if (!res.ok) {
            let msg = `transcribe ${res.status}`;
            try { const j = await res.json(); if (j?.error) msg = String(j.error); } catch { /* ignore */ }
            fail(msg);
            return;
          }
          failures = 0;
          setError(null);
          const j = (await res.json()) as { text?: string };
          if (j.text) handleTranscript(j.text);
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      };

      /** Close the current recording and start a fresh one. */
      const cut = (send: boolean) => {
        const rec = mr;
        if (!rec || !stream) return;
        const spoke = speechStart > 0;
        const durationMs = spoke ? Date.now() - speechStart : 0;
        speechStart = 0;
        rec.onstop = () => {
          const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
          chunks = [];
          if (send && spoke && durationMs >= MIN_UTTERANCE_MS) void transcribe(blob);
          if (!stopped) beginSegment();
        };
        try { rec.stop(); } catch { /* already stopped */ }
        mr = null;
      };

      const beginSegment = () => {
        if (stopped || !stream) return;
        let rec: MediaRecorder;
        try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
        catch (err) { giveUp('could not record audio: ' + String(err)); return; }
        chunks = [];
        segmentStart = Date.now();
        rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        rec.onerror = () => { /* the VAD loop will recycle */ };
        mr = rec;
        // A timeslice keeps chunks flowing so a cut never waits on a flush.
        rec.start(250);
        setListening(true);
      };

      (async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            // Echo cancellation stays on: this microphone is open while our
            // own speaker plays. Noise suppression and AGC do NOT — they are
            // tuned for phone calls, and they strip exactly what a recogniser
            // needs, swallowing the low-energy consonant a wake word starts
            // with ("Jarvis" heard as "darviz", "Pookie" as "okay"). The
            // push-to-talk path has always disabled all three for this reason.
            audio: {
              echoCancellation: true,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
        } catch {
          giveUp('microphone blocked — allow mic access, then switch the wake word back on');
          return;
        }
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }

        mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
          .find((m) => MediaRecorder.isTypeSupported(m)) || '';

        const Ctx = window.AudioContext
          || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        audioCtx = new Ctx();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);

        beginSegment();
        setError(null);

        // Muting during playback is the primary defence against the app
        // hearing itself. Discard whatever is buffered rather than uploading
        // a clip of our own speech.
        let bargeStart = 0;
        let bargedIn = false;

        unsubSpeaking = subscribeSpeaking((speaking) => {
          if (stopped) return;
          if (speaking) {
            muted = true;
            bargeStart = 0;
            speechStart = 0;
            cut(false);
          } else {
            // A barge-in already silenced the audio, and the user is mid-word.
            // Waiting the full echo guard would clip the front of what they
            // said, which is where the wake phrase and the verb live.
            unmuteAt = Date.now() + (bargedIn ? BARGE_GUARD_MS : ECHO_GUARD_MS);
            bargedIn = false;
            // The adaptive floor drifts upward on any leakage; re-seed it so
            // the gate does not go deaf to normal speech.
            noiseFloor = 0.005;
            muted = false;
          }
        });

        vadTimer = setInterval(() => {
          if (stopped || !mr) return;
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          const nowMs = Date.now();

          // Speaking: the only thing worth detecting is you interrupting.
          if (muted) {
            if (rms > BARGE_IN_RMS) {
              if (!bargeStart) bargeStart = nowMs;
              if (nowMs - bargeStart >= BARGE_IN_SUSTAIN_MS) {
                bargeStart = 0;
                bargedIn = true;
                // Flips `speaking` false, which unmutes through the handler
                // above — so there is one place that decides when we listen.
                stopSpeaking();
              }
            } else {
              bargeStart = 0;
            }
            return;
          }
          if (nowMs < unmuteAt) return;

          const now = nowMs;
          const startGate = Math.max(MIN_SPEECH_RMS, noiseFloor * 2.5);
          const holdGate = Math.max(HOLD_SPEECH_RMS, noiseFloor * 1.5);
          const speaking = speechStart ? rms > holdGate : rms > startGate;
          if (speaking) {
            if (!speechStart) speechStart = now;
            lastVoiceAt = now;
          } else if (!speechStart) {
            // Only adapt the floor while quiet, so speech cannot raise it.
            noiseFloor = noiseFloor * 0.95 + rms * 0.05;
          }

          if (speechStart && now - speechStart > MAX_UTTERANCE_MS) { cut(true); return; }
          if (speechStart && !speaking && now - lastVoiceAt > SILENCE_MS) { cut(true); return; }
          if (!speechStart && now - segmentStart > IDLE_RECYCLE_MS) cut(false);
        }, VAD_POLL_MS);
      })();

      return () => {
        unsubSpeaking?.();
        if (vadTimer) clearInterval(vadTimer);
        try { mr?.stop(); } catch { /* ignore */ }
        mr = null;
        chunks = [];
        try { void audioCtx?.close(); } catch { /* ignore */ }
        stream?.getTracks().forEach((t) => t.stop());
        stream = null;
      };
    };

    const teardown = provider === 'browser' ? runBrowser() : runCloud();

    return () => {
      stopped = true;
      clearArmTimer();
      clearSettle();
      setArmedState(false);
      setListening(false);
      teardown();
    };
  }, [SR, enabled, lang, provider]);

  return { supported, armed, listening, error };
}

// Minimal structural types for the Web Speech API (not in lib.dom for webkit).
interface SpeechResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: () => void;
  onspeechstart: () => void;
  onresult: (e: SpeechResultEvent) => void;
  onerror: (e: { error?: string }) => void;
  onend: () => void;
  start: () => void;
  abort: () => void;
}
