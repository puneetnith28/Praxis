/**
 * useVoiceAnnouncer — say the things you would otherwise have to watch for.
 *
 * Approval gates, agents that finish, and errors were all visual-only: a gate
 * opened a modal in silence while the agent sat blocked. This speaks them, so
 * Conduit can be run without looking at it.
 *
 * Discipline matters more than coverage here. A burst of agents finishing must
 * not become a wall of speech, so announcements are deduped, coalesced, rate
 * limited, and held back while the user is mid-sentence — except a gate, which
 * is blocking work and preempts.
 */

import { useEffect, useRef } from 'react';
import { speak, sanitizeForSpeech, speakableGate, type TtsCfg } from '../utils/speech';

/** Suppress a repeat of the same thing for this long. */
const DEDUPE_MS = 60_000;
/** Gather same-kind events for this long so three become one sentence. */
const COALESCE_MS = 2500;
/** At most one routine announcement per this interval. */
const MIN_GAP_MS = 5000;

export interface AnnouncerAgent {
  id: string;
  name: string;
  status: string;
  projectId: string;
}

export interface AnnouncerOptions {
  enabled: boolean;
  ttsCfg: TtsCfg;
  /** Every agent across every project. */
  agents: AnnouncerAgent[];
  /** The gate currently awaiting a decision, if any. */
  gate?: { agentName: string; projectName?: string; prompt: string; source: string } | null;
  /** Latest error text to announce once. */
  error?: string | null;
  /** True while the user is talking to us — routine news waits its turn. */
  userSpeaking: boolean;
}

export function useVoiceAnnouncer(opts: AnnouncerOptions) {
  const { enabled, ttsCfg, agents, gate, error, userSpeaking } = opts;

  const said = useRef(new Map<string, number>());
  const lastAt = useRef(0);
  const pending = useRef<string[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevAwaiting = useRef<Set<string>>(new Set());
  const seenGate = useRef<string>('');
  const cfgRef = useRef({ ttsCfg, enabled, userSpeaking });
  useEffect(() => { cfgRef.current = { ttsCfg, enabled, userSpeaking }; });

  /** True if this exact thing was announced recently. */
  const fresh = (key: string): boolean => {
    const now = Date.now();
    const at = said.current.get(key);
    if (at && now - at < DEDUPE_MS) return false;
    said.current.set(key, now);
    // Keep the map from growing without bound over a long session.
    if (said.current.size > 200) {
      for (const [k, t] of said.current) if (now - t > DEDUPE_MS) said.current.delete(k);
    }
    return true;
  };

  const flush = () => {
    flushTimer.current = null;
    const lines = pending.current;
    pending.current = [];
    if (!lines.length || !cfgRef.current.enabled) return;
    const text = lines.length === 1
      ? lines[0]
      : `${lines.length} things need you. ${lines.join(' ')}`;
    lastAt.current = Date.now();
    speak(text, cfgRef.current.ttsCfg, { priority: 2 });
  };

  /** Queue a routine announcement, coalescing with anything close behind it. */
  const announce = (text: string) => {
    if (!cfgRef.current.enabled) return;
    pending.current.push(text);
    // Backpressure: past a handful, stop enumerating and say so once.
    if (pending.current.length > 4) {
      pending.current = ['Several things need you — check the screen.'];
    }
    if (flushTimer.current) return;
    const wait = Math.max(
      COALESCE_MS,
      MIN_GAP_MS - (Date.now() - lastAt.current),
      cfgRef.current.userSpeaking ? COALESCE_MS * 2 : 0,
    );
    flushTimer.current = setTimeout(flush, wait);
  };

  // --- gates: the only announcement that preempts -----------------------
  useEffect(() => {
    if (!enabled || !gate) { if (!gate) seenGate.current = ''; return; }
    const key = `${gate.agentName}:${gate.prompt.slice(-80)}`;
    if (key === seenGate.current) return;
    seenGate.current = key;
    if (!fresh('gate:' + key)) return;

    const what = speakableGate(gate.prompt, 120);
    const where = gate.projectName ? ` in ${gate.projectName}` : '';
    const line = gate.source === 'supervisor'
      ? `Approval needed. ${gate.agentName}${where} — the Supervisor flagged something risky. ${what} Say reject to stop it, or approve it on screen.`
      : `Approval needed. ${gate.agentName}${where} is asking: ${what} Say reject to stop it, or approve it on screen.`;
    speak(line, ttsCfg, { priority: 0 });

    // Also raise an OS notification, so a blocked agent still surfaces with
    // the volume down. The bridge has existed unused since the desktop shell
    // was added.
    try {
      window.conduitDesktop?.showNotification(`${gate.agentName} needs a decision`, what);
    } catch { /* browser, or the bridge is absent */ }
  }, [enabled, gate, ttsCfg]);

  // --- agents that started waiting for you ------------------------------
  useEffect(() => {
    if (!enabled) return;
    const now = new Set(agents.filter((a) => a.status === 'awaiting_input').map((a) => a.id));
    const added = [...now].filter((id) => !prevAwaiting.current.has(id));
    prevAwaiting.current = now;
    for (const id of added) {
      const a = agents.find((x) => x.id === id);
      if (!a || !fresh('await:' + id)) continue;
      announce(`${sanitizeForSpeech(a.name, 40)} is waiting for you.`);
    }
  }, [enabled, agents]);

  // --- errors ------------------------------------------------------------
  useEffect(() => {
    if (!enabled || !error) return;
    const clean = sanitizeForSpeech(error, 200);
    if (!clean || !fresh('err:' + clean.slice(0, 60))) return;
    announce(clean);
  }, [enabled, error]);

  useEffect(() => () => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
  }, []);
}
