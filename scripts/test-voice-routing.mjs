#!/usr/bin/env node
/**
 * Unit checks for spoken-command routing.
 *
 * The safety case matters most: no transcript may ever produce an approve on
 * this path. (The live Nova path can approve, but only through the server-side
 * four-condition guard in `src/voice/approval-guard.ts`, which has its own
 * tests in `scripts/test-approval-guard.mjs`. This router has no such guard,
 * so it has no approve.)
 * The rest guards against the two ways voice routing fails in practice —
 * a control word being dispatched as a task, and a transcriber mangling an
 * agent's name so the command silently goes to the wrong place.
 */
import { routeUtterance, matchAgent, matchWakePhrase } from '../client/src/utils/voiceRouting.ts';

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const AGENTS = [
  { id: 'a1', name: 'Claude', cli: 'claude', projectId: 'p1', role: 'lead' },
  { id: 'a2', name: 'Gemini', cli: 'gemini', projectId: 'p1', role: 'worker' },
  { id: 'a3', name: 'Nemotron', cli: 'nemotron', projectId: 'p2' },
];
const ctx = { agents: AGENTS, selectedProjectId: 'p1' };
const gated = { ...ctx, gateOpen: true };

console.log('\nVoice routing\n');

// --- safety: approve must be unreachable -------------------------------
for (const phrase of ['approve', 'yes', 'go ahead', 'do it', 'allow it', 'confirm']) {
  const r = routeUtterance(phrase, gated);
  t(r.kind === 'refuse', `"${phrase}" is refused, never an approval`, r.kind);
}
t(
  JSON.stringify(routeUtterance('approve', gated)).includes('approve') === false ||
    routeUtterance('approve', gated).kind === 'refuse',
  'no route object carries an approve action',
);

// --- gate rejection ----------------------------------------------------
for (const phrase of ['reject', 'deny', 'decline', 'no']) {
  const r = routeUtterance(phrase, gated);
  t(r.kind === 'control' && r.action === 'reject-gate', `"${phrase}" rejects the gate`, r.kind);
}
t(routeUtterance('reject', ctx).kind === 'keeper', 'reject with no gate open is just a command');

// --- control words are not tasks ---------------------------------------
t(routeUtterance('stop', ctx).action === 'stop', '"stop" stops speech');
t(routeUtterance("that's all", ctx).action === 'sleep', '"that\'s all" ends the conversation');
t(routeUtterance('status', ctx).action === 'status', '"status" reports state');

// --- the Keeper is the default ------------------------------------------
t(routeUtterance('run the tests', ctx).kind === 'keeper', 'a bare command goes to the Keeper');
t(routeUtterance('keeper, run the tests', ctx).text === 'run the tests', 'explicit keeper prefix is stripped');

// --- addressing an agent -------------------------------------------------
const r1 = routeUtterance('tell Claude to fix the auth bug', ctx);
t(r1.kind === 'agent' && r1.agentId === 'a1' && r1.text === 'fix the auth bug',
  'tell <agent> to <task> routes to that agent', JSON.stringify(r1));

const r2 = routeUtterance('Gemini, run the linter', ctx);
t(r2.kind === 'agent' && r2.agentId === 'a2' && r2.text === 'run the linter',
  '<agent>, <task> routes to that agent', JSON.stringify(r2));

// --- transcribers mangle names -------------------------------------------
for (const heard of ['cloud', 'Klaus', 'claud']) {
  const r = routeUtterance(`tell ${heard} to run the tests`, ctx);
  t(r.kind === 'agent' && r.agentId === 'a1', `"${heard}" still reaches Claude`, JSON.stringify(r));
}
t(routeUtterance('tell jiminy to run the tests', ctx).agentId === 'a2',
  '"jiminy" still reaches Gemini');

// --- an agent in another project is still addressable --------------------
t(routeUtterance('tell Nemotron to summarise', ctx).agentId === 'a3',
  'an agent outside the selected project is reachable');

// --- ambiguity is reported, never guessed --------------------------------
const dupes = [
  { id: 'b1', name: 'Worker', cli: 'claude', projectId: 'p1' },
  { id: 'b2', name: 'Worker', cli: 'gemini', projectId: 'p1' },
];
const amb = routeUtterance('tell Worker to stop', { agents: dupes, selectedProjectId: 'p1' });
t(amb.kind === 'ambiguous' && amb.names.length === 2, 'a duplicate name asks instead of picking',
  JSON.stringify(amb));

// --- an unknown name falls through, it does not vanish -------------------
t(routeUtterance('tell me the time', ctx).kind === 'keeper',
  'an unmatched name falls through to the Keeper rather than being dropped');

// --- control words must not fire on fragments -------------------------
t(routeUtterance('maybe run the tests later', ctx).kind === 'keeper',
  '"maybe" does not end the session even though it contains "bye"');
t(routeUtterance('no idea what that means', gated).kind === 'keeper',
  'a sentence starting with "no" is not a gate rejection');
t(routeUtterance('stop the dev server', ctx).kind === 'keeper',
  '"stop the dev server" is a command, not the stop control');
t(routeUtterance('yes we should refactor that', gated).kind === 'keeper',
  'a sentence starting with "yes" is not an approval attempt');

// --- the wake phrase, as a recogniser actually hears it ------------------
// Exact matching made the wake word work "only sometimes": one mis-heard
// letter and nothing happened at all.
for (const heard of ['jarvis', 'Jarvis', 'JARVIS', 'jervis', 'javis', 'jarvis.', 'jarvus']) {
  t(matchWakePhrase(heard, 'jarvis').hit, `"${heard}" wakes it`);
}
// "Travis" is three edits away — the same distance as "harvest", which must
// never wake it. Listing the spelling is the way out.
t(!matchWakePhrase('travis', 'jarvis').hit, '"travis" does not wake it by default');
t(matchWakePhrase('travis start the agent', 'jarvis, travis').hit,
  'until it is listed as an alternate');
t(matchWakePhrase('travis start the agent', 'jarvis, travis').rest === 'start the agent',
  'and the command still survives');
t(matchWakePhrase('jarvis stop', 'jarvis, travis').hit, 'the first spelling still works');
t(matchWakePhrase('jarvis list the agents', 'jarvis').rest === 'list the agents',
  'the command after the phrase is kept',
  JSON.stringify(matchWakePhrase('jarvis list the agents', 'jarvis').rest));
t(matchWakePhrase('Jarvis. Start the agent', 'jarvis').rest === 'Start the agent',
  'punctuation between phrase and command is stripped',
  JSON.stringify(matchWakePhrase('Jarvis. Start the agent', 'jarvis').rest));
t(matchWakePhrase('hey jarvis what is running', 'jarvis').rest === 'what is running',
  'the phrase can appear mid-sentence');
t(matchWakePhrase('jarvis', 'jarvis').rest === '',
  'the phrase alone leaves no command');

// Must NOT wake — a wake word that fires on ordinary speech is worse than one
// that misses.
for (const heard of ['harvest the logs', 'service is down', 'java version', 'the car is red']) {
  t(!matchWakePhrase(heard, 'jarvis').hit, `"${heard}" does not wake it`);
}
t(!matchWakePhrase('', 'jarvis').hit, 'silence does not wake it');
t(!matchWakePhrase('anything at all', '').hit, 'an empty phrase never matches');

// A short custom phrase stays strict, or every syllable would trigger it.
t(matchWakePhrase('ok computer', 'ok').hit, 'a short phrase matches exactly');
t(!matchWakePhrase('of computer', 'ok').hit, 'a short phrase tolerates no slack');

// --- matchAgent directly --------------------------------------------------
t(matchAgent('claude', AGENTS, 'p1').agent?.id === 'a1', 'matchAgent exact name');
t(matchAgent('lead', AGENTS, 'p1').agent?.id === 'a1', 'matchAgent by role');
t(!matchAgent('zzzz', AGENTS, 'p1').agent, 'matchAgent misses cleanly');

// --- a LocalHarness agent, reached by its CLI name as spoken --------------
{
  const withLocal = [...AGENTS, { id: 'a4', name: 'Scout', cli: 'localharness', projectId: 'p1' }];
  t(matchAgent('local harness', withLocal, 'p1').agent?.id === 'a4', 'matchAgent finds a LocalHarness agent as "local harness"');
  t(matchAgent('localharness', withLocal, 'p1').agent?.id === 'a4', 'and as one word');
  t(matchAgent('local', withLocal, 'p1').agent?.id !== 'a4', 'but not on a bare "local"');
}

console.log(`\n${pass} passed, ${fail} failed${failures.length ? ':\n  - ' + failures.join('\n  - ') : ''}\n`);
process.exit(fail ? 1 : 0);
