/**
 * speech — the app's single voice.
 *
 * This lived inside JarvisHud, which App unmounts whenever the Command panel
 * opens, so speech died mid-sentence and never resumed. It is module state
 * with no React in it, so anything can speak: the Keeper's replies, a wake-word
 * greeting, an approval-gate announcement.
 *
 * One queue, played serially, with a generation counter for cancellation. The
 * cancellation logic is subtle and was moved here verbatim — read the comments
 * before changing it.
 */

export interface TtsCfg {
  enabled: boolean;
  /**
   * Shares the STT provider union, but only 'openai' and 'gemini' synthesise
   * server-side. Anything else — including 'groq', which Conduit uses for
   * transcription only — speaks with the browser's local voice: free,
   * offline, and unlimited.
   */
  provider: 'browser' | 'openai' | 'gemini' | 'groq';
  model: string;
  voice: string;
  speed: number;
  /** BCP-47 tag used for browser speech synthesis (falls back to the page language). */
  language?: string;
}

/** Lower number wins. Gates preempt; everything else queues in order. */
export type SpeechPriority = 0 | 1 | 2;

interface Job {
  spoken: string;
  cfg: TtsCfg;
  priority: SpeechPriority;
}

/**
 * Single global TTS queue — the Keeper's narration, greetings and
 * announcements play back in order, and `stopSpeaking()` is the only thing
 * that clears them. Each job carries the per-call config so the provider can
 * change on the fly without dropping in-flight audio.
 */
let ttsQueue: Job[] = [];
let ttsBusy = false;
let ttsCurrent: HTMLAudioElement | null = null;
/** Bumped by stopSpeaking — lets an in-flight play detect it was cancelled
 *  and prevents its `finally` from clobbering the busy flag of the next
 *  play that may already have started after the stop. */
let speakGen = 0;
/** Dedupe key against React StrictMode's effect-double-invocation in dev,
 *  which would otherwise queue every spoken line twice. */
let lastSpokenKey = '';
let lastSpokenAt = 0;

// --- speaking state, for the microphone interlock -----------------------
// An always-on mic with echo cancellation off will transcribe our own speech
// and treat it as a command. The listener subscribes here and stops cutting
// utterances while we are talking.
type SpeechListener = (speaking: boolean) => void;
const listeners = new Set<SpeechListener>();
let speaking = false;

function setSpeaking(v: boolean): void {
  if (speaking === v) return;
  speaking = v;
  for (const cb of listeners) {
    try { cb(v); } catch { /* a bad subscriber must not break playback */ }
  }
}

/** True while audio is actually playing (not merely queued). */
export function isSpeaking(): boolean {
  return speaking;
}

/** Subscribe to playback start/stop. Returns an unsubscribe. */
export function subscribeSpeaking(cb: SpeechListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** What we have said recently, so a self-heard transcript can be discarded. */
const recentlySpoken: { text: string; at: number }[] = [];
const SELF_ECHO_WINDOW_MS = 10_000;

function rememberSpoken(text: string): void {
  recentlySpoken.push({ text: text.toLowerCase(), at: Date.now() });
  while (recentlySpoken.length > 4) recentlySpoken.shift();
}

/**
 * Backstop for the echo interlock: did we just say this? Compares token
 * overlap, because a transcriber will not return our words exactly. This
 * fires *after* a billable transcription, so it is a safety net, not the
 * primary defence — that is muting the mic during playback.
 */
export function isLikelySelfEcho(text: string): boolean {
  const now = Date.now();
  const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (words.length === 0) return false;
  for (const r of recentlySpoken) {
    if (now - r.at > SELF_ECHO_WINDOW_MS) continue;
    const mine = new Set(r.text.split(/\W+/).filter((w) => w.length > 2));
    if (mine.size === 0) continue;
    const hits = words.filter((w) => mine.has(w)).length;
    if (hits / words.length >= 0.7) return true;
  }
  return false;
}

if (typeof window !== 'undefined') {
  // Small diagnostic surface — voice failures are otherwise invisible.
  (window as unknown as { __conduitSpeech?: unknown }).__conduitSpeech = {
    isSpeaking: () => speaking,
    queued: () => ttsQueue.length,
    busy: () => ttsBusy,
  };
}

export function stopSpeaking() {
  ttsQueue = [];
  ttsBusy = false;
  speakGen++;
  if (ttsCurrent) {
    const a = ttsCurrent;
    ttsCurrent = null;
    try { a.pause(); } catch { /* ignore */ }
  }
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  setSpeaking(false);
}

/** Pull the Keeper's explicit spoken-summary line (`🔊 …`) out of a reply. */
const SPOKEN_RE = /🔊[ \t]*([^\n]+)/;

/** Distill the speakable line out of a Keeper reply. */
export function extractSpoken(text: string): string {
  let spoken = '';
  const marked = text.match(SPOKEN_RE);
  if (marked) {
    spoken = marked[1].replace(/[*_`#>]/g, '').trim();
  } else {
    const clean = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_#>]/g, '')
      .replace(/^\s*[-•]\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    const sentences = clean.split(/(?<=[。.!?！?])\s*/).filter((s) => s.trim());
    spoken = sentences.slice(0, 2).join('') || clean;
  }
  return capSpokenLength(spoken);
}

/**
 * Keep a spoken line short enough to listen to.
 *
 * The prompt asks the Keeper for one sentence, but a model that ignores that
 * would otherwise monologue for half a minute — and under the half-duplex mic
 * interlock the user cannot interrupt it. Cut at a sentence boundary so the
 * result still sounds finished, rather than stopping mid-word.
 */
export function capSpokenLength(text: string, max = 240): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const sentences = t.split(/(?<=[。.!?！?])\s*/).filter(Boolean);
  let out = '';
  for (const sentence of sentences) {
    if (out && (out + sentence).length > max) break;
    out += sentence;
  }
  return (out || t.slice(0, max)).trim();
}

/**
 * Make arbitrary text safe to send to a speech engine.
 *
 * This is a cost and safety control, not cosmetics: gate prompts are raw
 * terminal tails written by an agent, and `/api/voice/tts` bills per character
 * with a 2000-char server cap. Unsanitised, a noisy build log becomes a long,
 * unintelligible, metered utterance.
 */
export function sanitizeForSpeech(raw: string, max = 300): string {
  const clean = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')      // ANSI escapes
    .replace(/```[\s\S]*?```/g, ' ')             // fenced code
    .replace(/[─-╿]/g, ' ')            // box drawing
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? clean.slice(0, max).trim() + '…' : clean;
}

/**
 * The question inside an approval gate.
 *
 * `PendingGate.prompt` is the last 1500 characters of the agent's terminal
 * (see `triggerGate` in src/strands/watcher.ts), not a sentence — reading it
 * aloud is useless. The question is at the end, so take the last meaningful
 * line.
 */
export function speakableGate(prompt: string, max = 140): string {
  const lines = sanitizeForSpeech(prompt, 4000)
    .split(/(?<=[?:])\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.length ? lines[lines.length - 1] : '';
  return sanitizeForSpeech(tail || prompt, max);
}

export interface SpeakOptions {
  /**
   * Run the Keeper-reply distillation (🔊 line, else the first two
   * sentences). Off by default — a greeting or an announcement is already
   * exactly what should be said, and distilling would truncate it.
   */
  distill?: boolean;
  priority?: SpeechPriority;
  /** Suppress if the same key was spoken within the last second. */
  dedupeKey?: string;
}

export function speak(text: string, cfg: TtsCfg, opts: SpeakOptions = {}): void {
  if (!cfg.enabled) return;   // master TTS off
  const spoken = (opts.distill ? extractSpoken(text) : sanitizeForSpeech(text, 500)).trim();
  if (!spoken) return;

  // React StrictMode double-invokes effects in dev; a brain-event reflow can
  // also drop the same reply through twice. Skip if we already queued this
  // exact line in the last second.
  const key = opts.dedupeKey || spoken;
  const now = Date.now();
  if (key === lastSpokenKey && now - lastSpokenAt < 1000) return;
  lastSpokenKey = key;
  lastSpokenAt = now;

  const priority = opts.priority ?? 1;
  const job: Job = { spoken, cfg, priority };
  if (priority === 0) {
    // A gate is blocking an agent — say it next, ahead of chatter.
    stopSpeaking();
    ttsQueue.push(job);
  } else {
    ttsQueue.push(job);
  }
  void processTtsQueue();
}

/** Generous upper bound on how long one utterance can take to play. */
function playBudgetMs(text: string): number {
  return Math.min(60_000, 5_000 + text.length * 120);
}

async function processTtsQueue(): Promise<void> {
  if (ttsBusy || ttsQueue.length === 0) return;
  ttsBusy = true;
  const myGen = speakGen;
  const job = ttsQueue.shift()!;
  setSpeaking(true);
  rememberSpoken(job.spoken);
  try {
    const play = job.cfg.provider === 'openai' || job.cfg.provider === 'gemini'
      ? playApi(job.spoken, job.cfg)
      : playBrowser(job.spoken, job.cfg);
    // Never await playback unconditionally. The microphone is muted while we
    // believe we are speaking, so an utterance that never reports finishing
    // would leave the app permanently deaf.
    await Promise.race([
      play,
      new Promise<void>((r) => setTimeout(() => {
        console.warn('[tts] playback did not finish in time — giving up on it');
        r();
      }, playBudgetMs(job.spoken))),
    ]);
  } catch (err) {
    console.warn('[tts] failed:', err);
  } finally {
    // If stopSpeaking ran during this play, a fresh processTtsQueue may
    // already own ttsBusy — don't touch it (would let another play start
    // concurrent with the new one and overlap audio).
    if (myGen === speakGen) {
      ttsBusy = false;
      if (ttsQueue.length > 0) void processTtsQueue();
      else setSpeaking(false);
    }
  }
}

async function playApi(text: string, cfg: TtsCfg): Promise<void> {
  // Snapshot the generation at start of this play. If stopSpeaking bumps the
  // counter while we're in an await (fetch / blob), abandon the play before
  // creating an Audio element — otherwise the OLD playApi would still build
  // and play its audio concurrent with whatever started after the stop.
  const myGen = speakGen;
  const r = await fetch('/api/voice/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, provider: cfg.provider, model: cfg.model, voice: cfg.voice, speed: cfg.speed }),
  });
  if (myGen !== speakGen) return; // cancelled during fetch
  if (!r.ok) throw new Error(`tts ${r.status}: ${await r.text().catch(() => '')}`);
  const blob = await r.blob();
  if (myGen !== speakGen) return; // cancelled during blob assembly
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  if (myGen !== speakGen) { URL.revokeObjectURL(url); return; }
  ttsCurrent = a;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (ttsCurrent === a) ttsCurrent = null;
      resolve();
    };
    a.onended = done;
    a.onerror = done;
    // External pause (stopSpeaking) needs to release the promise too; without
    // this the await hangs forever and the queue stalls.
    a.onpause = () => { if (!a.ended) done(); };
    a.play().catch(done);
  });
}

/**
 * The browser populates its voice list asynchronously.
 *
 * `getVoices()` returns an empty array on a cold page — measured 0
 * synchronously against 23 after `voiceschanged` — so picking immediately
 * silently fell through to whatever default the browser felt like, which is
 * how a machine with Microsoft Aria ended up speaking as Microsoft David.
 */
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const ready = synth.getVoices();
    if (ready.length) { resolve(ready); return; }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(synth.getVoices());
    };
    synth.addEventListener?.('voiceschanged', done, { once: true });
    // Some engines never fire the event; do not hang the queue on it.
    setTimeout(done, 1500);
  });
}

/** Modern neural voices announce themselves in the name. */
const LIFELIKE = /natural|neural|online|premium|enhanced|wavenet|studio/i;
/** The old formant-synthesis voices — intelligible, obviously synthetic. */
const ROBOTIC = /\b(david|zira|mark|hazel|susan|sam|anna|desktop)\b/i;

/**
 * Rank voices rather than taking the first language match.
 *
 * `find(v => v.lang === 'en-US')` returned whichever the browser happened to
 * list first, which is normally a legacy local voice — so the good voices
 * already installed went unused.
 */
export function pickVoice(
  voices: SpeechSynthesisVoice[],
  lang: string,
  preferredName?: string,
): SpeechSynthesisVoice | undefined {
  if (preferredName) {
    const exact = voices.find((v) => v.name === preferredName);
    if (exact) return exact;
  }
  const want = lang.toLowerCase();
  const base = want.split('-')[0];

  let best: SpeechSynthesisVoice | undefined;
  let bestScore = -Infinity;
  for (const v of voices) {
    const vlang = v.lang.toLowerCase().replace('_', '-');
    let score: number;
    if (vlang === want) score = 100;
    else if (vlang.startsWith(base)) score = 60;
    else continue;                       // a different language is never right

    if (LIFELIKE.test(v.name)) score += 40;
    if (ROBOTIC.test(v.name)) score -= 30;
    if (v.default) score += 5;

    if (score > bestScore) { bestScore = score; best = v; }
  }
  return best;
}

async function playBrowser(text: string, cfg: TtsCfg): Promise<void> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const myGen = speakGen;
  const synth = window.speechSynthesis;
  const lang = cfg.language || navigator.language || 'en-US';
  const voices = await loadVoices();
  if (myGen !== speakGen) return;        // cancelled while the list loaded
  return new Promise((resolve) => {
    // If we were cancelled while waiting for the queue, don't queue more.
    if (myGen !== speakGen) { resolve(); return; }
    const voice = pickVoice(voices, lang, cfg.voice);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = Math.max(0.5, Math.min(2, cfg.speed || 1));
    if (voice) u.voice = voice;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
  });
}
