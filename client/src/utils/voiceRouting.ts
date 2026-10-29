/**
 * voiceRouting — turn a spoken sentence into an action.
 *
 * Pure and dependency-free (no React, no fetch) so it can be unit-tested
 * directly under `node --experimental-strip-types`, which is where the
 * interesting cases live: transcribers mangle names, and the difference
 * between "reject" and "approve" must never come down to a lucky match.
 *
 * Safety: there is deliberately **no** approve action in the `Route` union.
 * Approving a gate can run `rm -rf`, force-push, or drop a database, and this
 * path has nothing that could make that safe: it sees one transcript, with no
 * record of what was read out, when, or whether the gate is still the same one.
 * So approve is absent here — not disabled by a flag, absent. Saying "approve"
 * produces a `refuse`, which is answered out loud.
 *
 * The live Nova path *can* approve, because it has the four things this one
 * lacks; see `src/voice/approval-guard.ts`. That guard runs on the server and
 * checks them itself. Do not add an approve action here to match it — the check
 * is what makes it safe, and there is no check on this side.
 */

export interface RosterAgent {
  id: string;
  name: string;
  role?: string;
  /** Used for the phonetic alias table — a transcriber writes "cloud" for Claude. */
  cli: string;
  projectId: string;
}

export type Route =
  | { kind: 'keeper'; text: string }
  | { kind: 'agent'; projectId: string; agentId: string; agentName: string; text: string }
  | { kind: 'control'; action: 'reject-gate' | 'stop' | 'sleep' | 'status' | 'repeat' }
  | { kind: 'refuse'; reason: string }
  | { kind: 'ambiguous'; names: string[]; text: string }
  | { kind: 'unknown'; text: string };

export interface RouteContext {
  agents: RosterAgent[];
  /** Prefer agents in the project the user is looking at. */
  selectedProjectId?: string | null;
  /** True when a gate is waiting, which unlocks the reject/approve vocabulary. */
  gateOpen?: boolean;
}

// Compared against normalised text, so these are normalised too — otherwise
// "that's all" is tested against "that s all" and never matches.
const STOP_WORDS = ['stop', 'be quiet', 'quiet', 'shut up', 'cancel that', 'nevermind', 'never mind'];
const SLEEP_WORDS = ["that's all", 'go to sleep', 'goodbye', 'bye', "that's it", "we're done", 'done for now'];
const STATUS_WORDS = ['status', "what's happening", 'what is happening', "what's going on"];
const REPEAT_WORDS = ['say that again', 'repeat that', 'repeat', 'what did you say'];
const REJECT_WORDS = ['reject', 'deny', 'decline', 'no', 'cancel it', "don't", 'stop it'];
// Matched exactly, and generously: the only outcome is a spoken refusal, so
// a false positive costs nothing while a miss leaves the user repeating
// themselves at a gate that will never accept their voice.
const APPROVE_WORDS = [
  'approve', 'approve it', 'yes', 'yes please', 'go ahead', 'do it', 'yes do it',
  'allow', 'allow it', 'accept', 'accept it', 'confirm', 'sure', 'go for it', 'ok', 'okay',
];

/**
 * What a speech-to-text engine tends to hear instead of each CLI's name.
 * Without this, "Claude" comes back as "cloud" or "Klaus" and the command
 * silently goes to the Keeper instead of the agent.
 */
const CLI_ALIASES: Record<string, string[]> = {
  claude: ['claude', 'cloud', 'clod', 'klaus', 'claud', 'clyde'],
  codex: ['codex', 'codecs', 'kodak', 'code x', 'cortex'],
  gemini: ['gemini', 'jiminy', 'gemeni', 'jemini'],
  opencode: ['opencode', 'open code'],
  gpt: ['gpt', 'g p t', 'chat gpt', 'gpt oss'],
  nemotron: ['nemotron', 'nemo tron', 'nemotron', 'neumotron'],
  // Not a bare "local": it is too common a word to route a command on.
  localharness: ['localharness', 'local harness', 'local harnass', 'local hardness', 'low cal harness'],
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Levenshtein, capped — we only care whether it is within a small budget. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

function startsWithAny(text: string, words: string[]): boolean {
  return words.some((raw) => {
    const w = norm(raw);
    return text === w || text.startsWith(w + ' ');
  });
}

/**
 * A control word must be the whole utterance, not a fragment of one.
 * Substring matching ended conversations on "maybe" (contains "bye") and is
 * exactly the kind of thing you cannot debug by ear.
 */
function equalsAny(text: string, words: string[]): boolean {
  return words.some((raw) => text === norm(raw));
}

/**
 * Resolve a spoken name to one agent, mirroring the server's `findAgent`
 * precedence (routes.ts) and then adding the phonetic tiers a transcript
 * needs. Ambiguity is reported, never guessed.
 */
export function matchAgent(
  spoken: string,
  agents: RosterAgent[],
  selectedProjectId?: string | null,
): { agent?: RosterAgent; ambiguous?: RosterAgent[] } {
  const want = norm(spoken);
  if (!want) return {};

  // Prefer the project in view, then fall back to everything.
  const pools = selectedProjectId
    ? [agents.filter((a) => a.projectId === selectedProjectId), agents]
    : [agents];

  for (const pool of pools) {
    if (pool.length === 0) continue;
    const tiers: RosterAgent[][] = [
      pool.filter((a) => norm(a.name) === want),
      pool.filter((a) => norm(a.role || '') === want),
      pool.filter((a) => (CLI_ALIASES[a.cli] || [a.cli]).includes(want)),
      pool.filter((a) => norm(a.name).includes(want) || norm(a.role || '').includes(want)),
      pool.filter((a) => editDistance(norm(a.name), want) <= 2),
      pool.filter((a) => (CLI_ALIASES[a.cli] || []).some((al) => editDistance(al, want) <= 2)),
    ];
    for (const tier of tiers) {
      if (tier.length === 1) return { agent: tier[0] };
      if (tier.length > 1) return { ambiguous: tier };
    }
  }
  return {};
}

/**
 * Did the user say the wake phrase, and what followed it?
 *
 * An exact substring test fails on the single most common case: a recogniser
 * writes "Travis" or "Jervis" for "Jarvis", and the wake word then appears to
 * work only sometimes. This tolerates near-misses the same way agent names do,
 * with a budget that scales to the word so short phrases stay strict.
 */
export function matchWakePhrase(text: string, phrase: string): { hit: boolean; rest: string } {
  // Several spellings may be configured, comma separated. Edit distance alone
  // cannot cover every mishearing — "Travis" is three edits from "Jarvis", and
  // allowing three would also match "harvest" — so whatever a particular
  // microphone and accent reliably produce can simply be listed.
  const alternates = phrase.split(/[,/|]/).map((a) => a.trim()).filter(Boolean);
  if (alternates.length > 1) {
    for (const alt of alternates) {
      const m = matchWakePhrase(text, alt);
      if (m.hit) return m;
    }
    return { hit: false, rest: '' };
  }

  const rawLower = text.toLowerCase();
  const phraseLower = (alternates[0] || '').toLowerCase();
  if (!phraseLower) return { hit: false, rest: '' };

  // Exact first — cheapest and most confident, and it preserves the original
  // casing of whatever followed.
  const idx = rawLower.indexOf(phraseLower);
  if (idx >= 0) {
    const rest = text.slice(idx + phraseLower.length).replace(/^[\s.,;:!?，。、：！？]+/, '').trim();
    return { hit: true, rest };
  }

  const words = norm(text).split(' ').filter(Boolean);
  const target = norm(phraseLower).split(' ').filter(Boolean);
  if (target.length === 0 || words.length < target.length) return { hit: false, rest: '' };

  for (let i = 0; i + target.length <= words.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (editDistance(words[i + j], target[j]) > wakeBudget(target[j])) { ok = false; break; }
    }
    if (ok) return { hit: true, rest: words.slice(i + target.length).join(' ').trim() };
  }
  return { hit: false, rest: '' };
}

/**
 * How wrong a heard word may be and still count as the wake phrase. Short
 * words get no slack — at three letters, one edit reaches too many real words
 * and every stray syllable would wake it.
 */
function wakeBudget(word: string): number {
  if (word.length >= 6) return 2;
  if (word.length >= 4) return 1;
  return 0;
}

/** Directed forms: "tell claude to run the tests" / "claude, run the tests". */
const DIRECTED = [
  /^(?:tell|ask|have|get)\s+(.+?)\s+(?:to\s+|that\s+)?(.+)$/i,
  /^([\p{L}\p{N} ]{2,20}?)\s*[,:]\s*(.+)$/u,
];

export function routeUtterance(raw: string, ctx: RouteContext): Route {
  const text = raw.trim();
  const n = norm(text);
  if (!n) return { kind: 'unknown', text };

  // 1. Control words first — otherwise "stop" is dispatched to the Keeper as
  //    a task, which is the opposite of what the user meant.
  if (equalsAny(n, STOP_WORDS)) return { kind: 'control', action: 'stop' };
  if (equalsAny(n, SLEEP_WORDS)) return { kind: 'control', action: 'sleep' };
  if (startsWithAny(n, REPEAT_WORDS)) return { kind: 'control', action: 'repeat' };
  if (startsWithAny(n, STATUS_WORDS)) return { kind: 'control', action: 'status' };

  // 2. A waiting gate changes what yes/no mean. Reject is allowed by voice;
  //    approve is structurally absent and answered instead.
  if (ctx.gateOpen) {
    if (equalsAny(n, REJECT_WORDS)) return { kind: 'control', action: 'reject-gate' };
    if (equalsAny(n, APPROVE_WORDS)) {
      return {
        kind: 'refuse',
        reason: 'I can’t approve that by voice. Approve it on screen, or say reject.',
      };
    }
  }

  // 3. Explicitly addressing the Keeper.
  const keeperMatch = n.match(/^(?:keeper|the keeper|bedrock|conduit)\s*[,:]?\s*(.+)$/);
  if (keeperMatch) return { kind: 'keeper', text: keeperMatch[1].trim() };

  // 4. Addressing an agent by name.
  for (const re of DIRECTED) {
    const m = text.match(re);
    if (!m) continue;
    const who = m[1].trim();
    const body = m[2].trim();
    if (!who || !body) continue;
    if (/^(?:keeper|the keeper|bedrock|conduit)$/i.test(norm(who))) {
      return { kind: 'keeper', text: body };
    }
    const found = matchAgent(who, ctx.agents, ctx.selectedProjectId);
    if (found.agent) {
      return {
        kind: 'agent',
        projectId: found.agent.projectId,
        agentId: found.agent.id,
        agentName: found.agent.name,
        text: body,
      };
    }
    if (found.ambiguous) {
      return { kind: 'ambiguous', names: found.ambiguous.map((a) => a.name), text: body };
    }
    // "Tell me the status" is not an agent — fall through to the Keeper.
  }

  // 5. Anything else is a task for the Keeper.
  return { kind: 'keeper', text };
}
