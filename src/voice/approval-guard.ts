/**
 * Approving a gate by voice, enforced by the server.
 *
 * Conduit's rule has been that approving an agent's pending action is not
 * reachable from speech at all. That was not a flag — the action was absent
 * from the routing union, because a gate can be `rm -rf`, a force-push, or a
 * dropped database, and a transcriber that writes "approve" for "of course"
 * would have been enough to run it.
 *
 * The user has asked for approve-by-voice, with a spoken confirmation. This
 * module is what makes that request safe to grant. The important design
 * decision is that **none of it is a prompt instruction**: a model told to ask
 * for confirmation will one day decide it already has it. Instead the server
 * refuses the approval unless all four of these hold:
 *
 *   1. `describe_gate` was called for this exact gate in this session — so the
 *      command was read out loud before anyone agreed to it.
 *   2. That happened within 60 seconds. Consent goes stale.
 *   3. The user's own speech since then contains an explicit approval. The
 *      phrase is matched against the **transcript stream**, not against a tool
 *      argument, so the model cannot supply its own confirmation. Bare "yes" is
 *      not enough — "yes" is what people say to almost anything.
 *   4. The gate is still open and its text is unchanged. An agent that moved on
 *      to a different prompt is a different question.
 *
 * `reject` needs none of this. Refusing is always safe and always available.
 */

// Type-only: erased at runtime, so this module stays free of imports.
import type { GateSource } from '../types.js';

/** What the server knows about a gate right now. */
export interface GateSnapshot {
  projectId: string;
  agentId: string;
  agentName: string;
  prompt: string;
  source: GateSource;
}

/** How long a spoken description stays good for. */
export const DESCRIBE_TTL_MS = 60_000;

/** How far back a confirmation may have been spoken. Same window, by design. */
export const CONFIRM_TTL_MS = DESCRIBE_TTL_MS;

export type AuthzResult =
  | { ok: true; phrase: string }
  | { ok: false; reason: string };

/**
 * An explicit approval.
 *
 * The word "approve" itself has to be there. "Yes", "yeah", "sure", "go ahead",
 * "do it" are all things people say while thinking, and a mis-heard filler word
 * must never be sufficient to run a destructive command.
 */
const APPROVES = /\b(?:approve|approved|approval)\b/i;

/**
 * ...unless it is being refused.
 *
 * "Don't approve that", "no, don't approve it", "cancel the approval" all
 * contain the word. Negation wins: if both patterns match, this is not consent.
 */
const NEGATED = /\b(?:do not|don'?t|dont|never|no|not|cancel|reject|deny|stop|hold off|wait)\b/i;

/** Cheap, stable identity for "the same question". Not a security hash. */
function fingerprint(gate: GateSnapshot): string {
  return `${gate.projectId}/${gate.agentId}/${gate.source}/${gate.prompt.trim()}`;
}

interface Described {
  at: number;
  fingerprint: string;
}

/**
 * One guard per voice session. State is deliberately per-session: consent given
 * in one conversation must not authorise anything in another.
 */
export class ApprovalGuard {
  private readonly described = new Map<string, Described>();

  /** The user's own words, newest last. Only the recent tail ever matters. */
  private readonly heard: Array<{ at: number; text: string }> = [];

  /** Injectable so the 60-second window is testable without sleeping.
   *  A parameter property would be neater, but `node --experimental-strip-types`
   *  cannot strip those, and these tests run under it. */
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Record that a gate was described out loud.
   *
   * Called by the `describe_gate` tool after it returns the command text, so
   * the timestamp is the moment the model was handed something to read.
   */
  noteDescribed(gate: GateSnapshot): void {
    this.described.set(gate.agentId, { at: this.now(), fingerprint: fingerprint(gate) });
  }

  /**
   * Record something the user said.
   *
   * Fed from the Nova transcript stream with `role: 'user'`. Assistant text
   * must never reach here — that is the whole point of condition 3.
   */
  noteUserSpeech(text: string): void {
    const clean = String(text || '').trim();
    if (!clean) return;
    this.heard.push({ at: this.now(), text: clean });
    // The window is a minute; a hundred utterances is already far more than
    // that can hold, and this session may run for hours.
    if (this.heard.length > 100) this.heard.splice(0, this.heard.length - 100);
  }

  /** Forget a gate once it has been resolved, so consent cannot be replayed. */
  clear(agentId: string): void {
    this.described.delete(agentId);
  }

  /**
   * May this gate be approved right now?
   *
   * `current` is the gate as the server sees it at this instant — `null` when
   * the agent has no pending gate any more.
   */
  authorize(agentId: string, current: GateSnapshot | null): AuthzResult {
    // 4. Still open, and still the same question.
    if (!current) {
      return { ok: false, reason: 'That gate is no longer open — nothing was approved.' };
    }

    // 1. Described in this session.
    const note = this.described.get(agentId);
    if (!note) {
      return {
        ok: false,
        reason: 'I have not read that command out yet. I will describe it first, then you can approve it.',
      };
    }

    if (note.fingerprint !== fingerprint(current)) {
      return {
        ok: false,
        reason: 'That agent is waiting on something different now. I will read out the new one first.',
      };
    }

    // 2. Recent enough.
    const age = this.now() - note.at;
    if (age > DESCRIBE_TTL_MS) {
      return {
        ok: false,
        reason: 'It has been more than a minute since I read that out. I will describe it again first.',
      };
    }

    // 3. The user said so, in their own voice, after hearing it.
    const since = this.heard.filter((h) => h.at >= note.at && this.now() - h.at <= CONFIRM_TTL_MS);
    const phrase = [...since].reverse().find((h) => APPROVES.test(h.text) && !NEGATED.test(h.text));
    if (!phrase) {
      const nearly = since.some((h) => APPROVES.test(h.text));
      return {
        ok: false,
        reason: nearly
          ? 'I heard that as a no. Say "approve it" on its own if you do want it approved.'
          : 'Say "approve it" out loud and I will. A yes on its own is not enough for this.',
      };
    }

    return { ok: true, phrase: phrase.text };
  }
}

export function cleanSpokenVoiceUtterance(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}
