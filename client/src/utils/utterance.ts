/**
 * UtteranceAssembler — join the fragments of one spoken sentence.
 *
 * A speech recogniser finalises at every pause, so "start the agent… called
 * gere" arrives as two or three separate final results. Dispatching each one
 * as it lands executed the first half of the sentence while the user was still
 * talking. Measured directly against a clip with a one-second pause in it: a
 * bare recogniser emitted three `FINAL` events for one intended command.
 *
 * So fragments are buffered and only released once the speaker has genuinely
 * stopped. The clock is injectable purely so this is testable without waiting
 * in real time.
 */

export interface AssemblerOptions {
  /** Quiet period after the last fragment before the utterance is complete. */
  settleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class UtteranceAssembler {
  private buf: string[] = [];
  private handle: unknown = null;
  private readonly settleMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly onComplete: (text: string) => void;

  // Fields are declared rather than using constructor parameter properties:
  // those need real codegen, and `node --experimental-strip-types` only
  // strips types — which is how this file is unit-tested.
  constructor(onComplete: (text: string) => void, opts: AssemblerOptions = {}) {
    this.onComplete = onComplete;
    this.settleMs = opts.settleMs ?? 1200;
    this.setTimer = opts.setTimer
      ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimer = opts.clearTimer
      ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Add one recognised fragment; the utterance completes after the quiet period. */
  push(fragment: string): void {
    const text = fragment.trim();
    if (!text) return;
    this.buf.push(text);
    if (this.handle !== null) this.clearTimer(this.handle);
    this.handle = this.setTimer(() => {
      this.handle = null;
      const joined = this.buf.join(' ').replace(/\s+/g, ' ').trim();
      this.buf = [];
      if (joined) this.onComplete(joined);
    }, this.settleMs);
  }

  /**
   * Restate the whole utterance so far, restarting the quiet period.
   *
   * The Web Speech API's `results` list is cumulative — every event repeats
   * all previous final results — so appending each event's contents would
   * duplicate the sentence. Callers that already hold the complete text use
   * this instead of `push`.
   */
  replace(text: string): void {
    const t = text.trim();
    if (this.handle !== null) { this.clearTimer(this.handle); this.handle = null; }
    this.buf = t ? [t] : [];
    if (!t) return;
    this.handle = this.setTimer(() => {
      this.handle = null;
      const joined = this.buf.join(' ').replace(/\s+/g, ' ').trim();
      this.buf = [];
      if (joined) this.onComplete(joined);
    }, this.settleMs);
  }

  /** Release whatever is buffered immediately (the user pressed stop). */
  flush(): void {
    if (this.handle !== null) { this.clearTimer(this.handle); this.handle = null; }
    const joined = this.buf.join(' ').replace(/\s+/g, ' ').trim();
    this.buf = [];
    if (joined) this.onComplete(joined);
  }

  /** Throw the buffer away — a conversation ended mid-sentence. */
  reset(): void {
    if (this.handle !== null) { this.clearTimer(this.handle); this.handle = null; }
    this.buf = [];
  }

  get pending(): boolean {
    return this.handle !== null;
  }
}
