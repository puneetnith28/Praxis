#!/usr/bin/env node
/**
 * Unit checks for utterance assembly — the fix for a spoken command being
 * executed before the speaker finished it.
 *
 * A recogniser finalises at every pause. Verified against a real clip with a
 * one-second gap in it: three `FINAL` events for one intended sentence. These
 * checks pin the joining behaviour, using a fake clock so they run instantly.
 */
import { UtteranceAssembler } from '../client/src/utils/utterance.ts';

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

/** A controllable clock, so "wait 1.2 seconds" costs nothing. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

console.log('\nUtterance assembly\n');

// The reported bug: a pause mid-sentence executed the first half.
{
  const clock = fakeClock();
  const out = [];
  const a = new UtteranceAssembler((t) => out.push(t), { settleMs: 1200, ...clock });
  a.push('start the agent');
  clock.advance(1000);            // the user pauses to think
  t(out.length === 0, 'a pause shorter than the settle window dispatches nothing', JSON.stringify(out));
  a.push('called gere');
  clock.advance(1200);
  t(out.length === 1, 'the sentence dispatches exactly once', `got ${out.length}`);
  t(out[0] === 'start the agent called gere', 'both halves arrive joined', JSON.stringify(out[0]));
}

// Three fragments, matching what the recogniser actually emitted for one clip.
{
  const clock = fakeClock();
  const out = [];
  const a = new UtteranceAssembler((t) => out.push(t), { settleMs: 1200, ...clock });
  for (const part of ['jarvis', 'start the agent', 'called gere']) {
    a.push(part);
    clock.advance(900);
  }
  clock.advance(1200);
  t(out.length === 1 && out[0] === 'jarvis start the agent called gere',
    'three fragments become one command', JSON.stringify(out));
}

// Genuinely separate commands must stay separate.
{
  const clock = fakeClock();
  const out = [];
  const a = new UtteranceAssembler((t) => out.push(t), { settleMs: 1200, ...clock });
  a.push('list the agents');
  clock.advance(1500);
  a.push('stop gere');
  clock.advance(1500);
  t(out.length === 2, 'a real gap keeps two commands apart', `got ${out.length}`);
  t(out[0] === 'list the agents' && out[1] === 'stop gere', 'and in order', JSON.stringify(out));
}

// replace(): the recogniser restates the whole utterance every event, so
// appending would duplicate it. This is the shape Chrome actually sends.
{
  const clock = fakeClock();
  const out = [];
  const a = new UtteranceAssembler((t) => out.push(t), { settleMs: 1200, ...clock });
  a.replace('start the agent');
  clock.advance(500);
  a.replace('start the agent called gere');       // cumulative restatement
  clock.advance(1200);
  t(out.length === 1, 'a restated utterance dispatches once', `got ${out.length}`);
  t(out[0] === 'start the agent called gere', 'without duplicating the earlier words',
    JSON.stringify(out[0]));
}

{
  const clock = fakeClock();
  const out = [];
  const a = new UtteranceAssembler((t) => out.push(t), { settleMs: 1200, ...clock });
  a.replace('one');
  clock.advance(1100);
  a.replace('one two');
  clock.advance(1100);
  a.replace('one two three');
  clock.advance(1200);
  t(out.length === 1 && out[0] === 'one two three',
    'each restatement pushes the deadline out', JSON.stringify(out));
}

{
  const clock = fakeClock();
  const out = [];
  const a = new UtteranceAssembler((t) => out.push(t), { settleMs: 1200, ...clock });
  a.replace('something');
  a.replace('');
  clock.advance(5000);
  t(out.length === 0, 'replacing with nothing cancels the pending utterance', JSON.stringify(out));
}

// Housekeeping.
{
  const clock = fakeClock();
  const out = [];
  const a = new UtteranceAssembler((t) => out.push(t), { settleMs: 1200, ...clock });
  a.push('  ');
  t(!a.pending && out.length === 0, 'blank fragments are ignored');
  a.push('half a sentence');
  t(a.pending, 'a buffered fragment reports as pending');
  a.flush();
  t(out.length === 1 && out[0] === 'half a sentence', 'flush releases immediately');
  a.push('discard me');
  a.reset();
  clock.advance(5000);
  t(out.length === 1, 'reset throws the buffer away', `got ${out.length}`);
}

console.log(`\n${pass} passed, ${fail} failed${failures.length ? ':\n  - ' + failures.join('\n  - ') : ''}\n`);
process.exit(fail ? 1 : 0);
