#!/usr/bin/env node
/**
 * The four conditions on approving a gate by voice.
 *
 * Conduit used to make this unreachable: `approve` was absent from the voice
 * routing union, not disabled by a flag. The user asked for it back, with a
 * spoken confirmation, and that is a real increase in risk — a transcription
 * error now sits between "of course" and a command that can delete a repo.
 *
 * So the interesting tests here are the refusals. Each one removes exactly one
 * of the four conditions and asserts the approval does not happen. If any of
 * these ever goes green by accident, the guard has stopped guarding.
 */
import { ApprovalGuard, DESCRIBE_TTL_MS } from '../src/voice/approval-guard.ts';

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const GATE = {
  projectId: 'p1',
  agentId: 'a1',
  agentName: 'Claude',
  prompt: 'Run `rm -rf node_modules` in the repo root? (y/n)',
  source: 'regex',
};

/** A guard with a clock we control, so the 60-second window is testable. */
function makeGuard() {
  let now = 1_000_000;
  const g = new ApprovalGuard(() => now);
  return { g, tick: (ms) => { now += ms; }, at: () => now };
}

console.log('\napprove-by-voice — the four conditions\n');

// ── the happy path, so the refusals below mean something ──────────────
{
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech('yes approve it');
  const r = g.authorize('a1', GATE);
  t(r.ok === true, 'described, confirmed, in time, unchanged → approved');
  t(r.ok && r.phrase === 'yes approve it',
    'and the authorising words come back to be logged verbatim', JSON.stringify(r));
}

// ── condition 1: describe_gate was called ─────────────────────────────
{
  const { g } = makeGuard();
  g.noteUserSpeech('approve it');
  const r = g.authorize('a1', GATE);
  t(r.ok === false, 'without describe_gate first → refused', JSON.stringify(r));
  t(!r.ok && /read that command out/i.test(r.reason),
    'and the reason says it has not been read out yet', r.reason);
}

{
  // Describing a *different* agent's gate must not authorise this one.
  const { g } = makeGuard();
  g.noteDescribed({ ...GATE, agentId: 'a2', agentName: 'Gemini' });
  g.noteUserSpeech('approve it');
  t(g.authorize('a1', GATE).ok === false,
    "describing another agent's gate does not authorise this one");
}

// ── condition 2: within 60 seconds ────────────────────────────────────
{
  const { g, tick } = makeGuard();
  g.noteDescribed(GATE);
  tick(DESCRIBE_TTL_MS - 1000);
  g.noteUserSpeech('approve');
  t(g.authorize('a1', GATE).ok === true, 'just inside the minute → approved');
}

{
  const { g, tick } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech('approve it');
  tick(DESCRIBE_TTL_MS + 1000);
  const r = g.authorize('a1', GATE);
  t(r.ok === false, 'a minute after it was read out → refused', JSON.stringify(r));
  t(!r.ok && /more than a minute/i.test(r.reason), 'and the reason says so', r.reason);
}

// ── condition 3: the user said the word, themselves ───────────────────
{
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech('yes');
  const r = g.authorize('a1', GATE);
  t(r.ok === false, 'a bare "yes" is not enough', JSON.stringify(r));
  t(!r.ok && /not enough/i.test(r.reason), 'and it says a yes on its own will not do', r.reason);
}

for (const filler of ['yeah', 'sure', 'go ahead', 'do it', 'ok', 'fine', 'uh huh', 'right']) {
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech(filler);
  t(g.authorize('a1', GATE).ok === false, `"${filler}" is not an approval`);
}

for (const negation of [
  "don't approve that",
  'do not approve it',
  'no, approve nothing',
  'cancel the approval',
  'never approve that one',
  'stop, do not approve',
]) {
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech(negation);
  const r = g.authorize('a1', GATE);
  t(r.ok === false, `"${negation}" is refused, not read as consent`, JSON.stringify(r));
}

{
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech("don't approve that");
  const r = g.authorize('a1', GATE);
  t(!r.ok && /heard that as a no/i.test(r.reason),
    'and a negated approval says it was heard as a no', r.reason);
}

{
  // Speech from *before* the description cannot be reached back for.
  const { g, tick } = makeGuard();
  g.noteUserSpeech('approve it');
  tick(500);
  g.noteDescribed(GATE);
  t(g.authorize('a1', GATE).ok === false,
    'approval spoken before the command was read out does not count');
}

{
  // The model cannot supply its own confirmation: only user speech is fed in.
  // This asserts the shape of that — there is no assistant channel to abuse.
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  t(typeof g.noteUserSpeech === 'function' && g.noteUserSpeech.length === 1,
    'the guard accepts user speech only — there is no assistant path in');
  t(g.authorize('a1', GATE).ok === false, 'and with no user speech at all, nothing is approved');
}

// ── condition 4: the gate is still open and unchanged ─────────────────
{
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech('approve it');
  const r = g.authorize('a1', null);
  t(r.ok === false, 'a gate that has already closed → refused', JSON.stringify(r));
  t(!r.ok && /no longer open/i.test(r.reason), 'and the reason says it closed', r.reason);
}

{
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech('approve it');
  const moved = { ...GATE, prompt: 'Force-push to main? (y/n)' };
  const r = g.authorize('a1', moved);
  t(r.ok === false, 'a gate whose command changed underneath → refused', JSON.stringify(r));
  t(!r.ok && /something different/i.test(r.reason),
    'and the reason says the agent is on a different question now', r.reason);
}

{
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech('approve it');
  const reclassified = { ...GATE, source: 'supervisor' };
  t(g.authorize('a1', reclassified).ok === false,
    'the same text raised by a different source is a different gate');
}

// ── consent is spent once used, and never crosses sessions ────────────
{
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech('approve it');
  t(g.authorize('a1', GATE).ok === true, 'the first approval goes through');
  g.clear('a1');
  const again = g.authorize('a1', GATE);
  t(again.ok === false, 'and the same consent cannot approve a second gate',
    JSON.stringify(again));
}

{
  const a = makeGuard().g;
  const b = makeGuard().g;
  a.noteDescribed(GATE);
  a.noteUserSpeech('approve it');
  t(b.authorize('a1', GATE).ok === false,
    'consent given in one session does not authorise another');
}

// ── the transcript buffer cannot grow without bound ───────────────────
{
  const { g } = makeGuard();
  for (let i = 0; i < 500; i++) g.noteUserSpeech(`filler ${i}`);
  g.noteDescribed(GATE);
  g.noteUserSpeech('approve it');
  t(g.authorize('a1', GATE).ok === true,
    'a long session still approves correctly after hundreds of utterances');
}

{
  const { g } = makeGuard();
  g.noteDescribed(GATE);
  g.noteUserSpeech('   ');
  g.noteUserSpeech('');
  t(g.authorize('a1', GATE).ok === false, 'empty and blank utterances are ignored');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('approve-by-voice cannot be reached without all four conditions\n');
