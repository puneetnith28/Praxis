#!/usr/bin/env node
/**
 * ACP approval gates — a LocalHarness agent's own permission request — against
 * real storage, through the one resolver (gate-resolve.ts) and the voice bridge.
 *
 * What must hold:
 *   - an ACP gate is never auto-approved, whatever its text looks like;
 *   - resolving it sends `gate:answer` with an option the agent offered, and
 *     never types a key or interrupts;
 *   - approve can only become "always" when a person picked that option —
 *     never by default, never by voice;
 *   - regex gates are answered exactly as before.
 *
 * Storage is redirected to a temp HOME before import; nothing touches ~/.conduit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const asTs = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(fileURLToPath(asTs))) return { url: asTs.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-gate-acp-'));
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;
process.env.CONDUIT_AUTO_APPROVE = '1'; // routine auto-approval ON: ACP gates must still wait

const storage = await import('../src/storage.ts');
const { resolveGate, pickAcpOption } = await import('../src/gate-resolve.ts');
const { classifyGate } = await import('../src/gatePatterns.ts');
const { shouldAutoApprove, resetGateSettingsCache } = await import('../src/gate-policy.ts');
const { createGateBridge } = await import('../src/voice/gate-bridge.ts');
const { ApprovalGuard } = await import('../src/voice/approval-guard.ts');
resetGateSettingsCache();

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
if (storage.listProjects().length) {
  console.error('refusing to run: storage is not isolated');
  process.exit(2);
}

const OPTIONS = [
  { id: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { id: 'allow_always', name: 'Always allow in this workspace', kind: 'allow_always' },
  { id: 'reject_once', name: 'No', kind: 'reject_once' },
  { id: 'reject_always', name: 'Never allow in this workspace', kind: 'reject_always' },
];
const TRUST = [
  { id: 'allow_always', name: 'Trust this workspace', kind: 'allow_always' },
  { id: 'reject_once', name: 'Not now', kind: 'reject_once' },
];

console.log('\nACP approval gates\n');

// ── 1. choosing the option ────────────────────────────────────────────
t(pickAcpOption(OPTIONS, 'approve') === 'allow_once', 'approve defaults to allow once');
t(pickAcpOption(OPTIONS, 'approve', 'allow_always') === 'allow_always', 'approve takes "always" only when asked for');
t(pickAcpOption(OPTIONS, 'approve', 'reject_always') === 'allow_once', 'approve cannot select a reject option');
t(pickAcpOption(OPTIONS, 'approve', 'made-up') === 'allow_once', 'an id that was not offered is ignored');
t(pickAcpOption(OPTIONS, 'reject') === 'reject_once', 'reject defaults to no-this-once');
t(pickAcpOption(OPTIONS, 'reject', 'reject_always') === 'reject_always', 'reject takes "never" when asked for');
t(pickAcpOption(OPTIONS, 'reject', 'allow_always') === 'reject_once', 'reject cannot select an allow option');
t(pickAcpOption(OPTIONS, 'custom', 'allow_always') === 'reject_once', 'custom refuses the request whatever id comes with it');
t(pickAcpOption(TRUST, 'approve') === null,
  'a permanent-only approval (workspace trust) is never picked by default — refused instead');
t(pickAcpOption(TRUST, 'approve', 'allow_always') === 'allow_always', 'it is picked when the person chose it');
t(pickAcpOption([], 'approve') === null && pickAcpOption([], 'reject') === null, 'no options: refuse');

// ── 2. never auto-approved ────────────────────────────────────────────
const tricky = 'Agent (LocalHarness) asks permission:\n    $ apt-get install foo [y/N]\n\nOptions: Allow once · No';
t(classifyGate(tricky, 'regex') === 'routine', 'the same text from a terminal would be routine');
t(classifyGate(tricky, 'acp') === 'harmful', 'from an ACP agent it is always the human\'s call');
t(shouldAutoApprove(tricky, 'regex') === true && shouldAutoApprove(tricky, 'acp') === false,
  'with auto-approval on, only the terminal one would be answered automatically');

// ── fixtures ──────────────────────────────────────────────────────────
const project = storage.createProject('acpgates', path.join(TEMP_HOME, 'work'), 'acp gate fixture');
const agent = storage.createAgent(project.id, 'Local', 'localharness', project.cwd);
const commands = [];
const wrote = [];
const requests = [];
const daemon = {
  writeTerminal: (id, data) => wrote.push({ id, data }),
  command: (c) => commands.push(c),
  request: async (op, params) => { requests.push({ op, params }); return { delivered: true }; },
};
const broadcasts = [];
const broadcast = (m) => broadcasts.push(m);
const open = (prompt = 'Local (LocalHarness) asks permission:\n    write notes.md', options = OPTIONS) =>
  storage.updateAgent(project.id, agent.id, {
    pendingGate: { prompt, source: 'acp', options: options.map((o) => o.name), acpOptions: options },
  });
const reset = () => { commands.length = 0; wrote.length = 0; requests.length = 0; broadcasts.length = 0; };
const answers = () => commands.filter((c) => c.op === 'gate:answer');

// ── 3. resolving from the UI ──────────────────────────────────────────
open(); reset();
let r = resolveGate(daemon, broadcast, project.id, agent.id, 'approve');
t(r.ok && answers().length === 1 && answers()[0].optionId === 'allow_once' && answers()[0].agentId === agent.id,
  'approve sends gate:answer with allow_once', JSON.stringify(commands));
t(wrote.length === 0 && !commands.some((c) => c.op === 'terminal:interrupt'), 'and types nothing, interrupts nothing');
t(storage.getAgent(project.id, agent.id).pendingGate === undefined, 'and closes the gate');
t(broadcasts.some((b) => b.type === 'gate:resolved'), 'and tells every viewer');
t(/chose "Allow once"/.test(r.action), 'and reports what it chose', r.action);

open(); reset();
r = resolveGate(daemon, broadcast, project.id, agent.id, 'approve', { optionId: 'allow_always' });
t(answers()[0]?.optionId === 'allow_always', 'a chosen "always" goes through as chosen');

open(); reset();
r = resolveGate(daemon, broadcast, project.id, agent.id, 'reject');
t(answers()[0]?.optionId === 'reject_once', 'reject sends reject_once');
t(!commands.some((c) => c.op === 'terminal:interrupt') && !requests.some((q) => q.op === 'agent:inject'),
  'and does not interrupt or lecture the agent — refusing is the answer');

open(); reset();
r = resolveGate(daemon, broadcast, project.id, agent.id, 'custom', { customInput: 'Write it to docs/notes.md instead.' });
t(answers()[0]?.optionId === 'reject_once', 'custom refuses the request');
t(requests.some((q) => q.op === 'agent:inject' && q.params.message === 'Write it to docs/notes.md instead.'),
  'then sends the user\'s text as the agent\'s next prompt');

open(); reset();
r = resolveGate(daemon, broadcast, project.id, agent.id, 'approve', { optionId: 'reject_always' });
t(answers()[0]?.optionId === 'allow_once', 'a contradictory option id cannot turn approve into reject');

const audit = storage.readRecentAudit(project.id, 10);
t(audit.some((e) => e.event === 'gate_approve' && e.optionId === 'allow_always'), 'the audit log records the option chosen');

// ── 4. the trust question ─────────────────────────────────────────────
open('Local (LocalHarness) asks permission:\n    Trust this workspace?', TRUST); reset();
r = resolveGate(daemon, broadcast, project.id, agent.id, 'approve');
t(!r.ok && r.status === 409 && /"Trust this workspace"/.test(r.error), 'a plain approve cannot grant permanent workspace trust, and says why', JSON.stringify(r));
t(answers().length === 0 && storage.getAgent(project.id, agent.id).pendingGate?.source === 'acp',
  'nothing is sent and the gate stays open for an explicit choice');
reset();
r = resolveGate(daemon, broadcast, project.id, agent.id, 'approve', { optionId: 'allow_always' });
t(answers()[0]?.optionId === 'allow_always', 'choosing "Trust this workspace" does');

// ── 5. by voice ───────────────────────────────────────────────────────
{
  open(); reset();
  const guard = new ApprovalGuard();
  const gates = createGateBridge(daemon, broadcast, guard);
  const found = gates.find('acpgates', 'Local');
  t(found.found && found.gate.source === 'acp', 'the voice bridge finds an ACP gate');
  const early = gates.approve(found.gate);
  t(early.ok === false && answers().length === 0, 'and the four voice conditions still apply to it');
  gates.noteDescribed(found.gate);
  guard.noteUserSpeech('approve it');
  const ok = gates.approve(found.gate);
  t(ok.ok === true && answers()[0]?.optionId === 'allow_once', 'a guarded voice approval allows once — never always', JSON.stringify(answers()));
  t(wrote.length === 0, 'and types nothing');

  // The trust question, approved out loud with every condition met, still
  // cannot become a permanent grant.
  open('Local (LocalHarness) asks permission:\n    Trust this workspace?', TRUST); reset();
  const trust = gates.find('acpgates', 'Local');
  gates.noteDescribed(trust.gate);
  guard.noteUserSpeech('yes, approve it');
  const v = gates.approve(trust.gate);
  t(v.ok === false && answers().length === 0, 'a voice approval cannot grant permanent workspace trust', JSON.stringify(v));
}

// ── 6. regex gates are unchanged ──────────────────────────────────────
storage.updateAgent(project.id, agent.id, { pendingGate: { prompt: 'Overwrite file? [y/N]', source: 'regex' } });
reset();
r = resolveGate(daemon, broadcast, project.id, agent.id, 'approve');
t(wrote.length === 1 && wrote[0].data === 'y\r' && answers().length === 0, 'a terminal y/N gate is still answered by typing y');

fs.rmSync(TEMP_HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
