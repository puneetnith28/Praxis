#!/usr/bin/env node
/**
 * Approving a gate by voice, against real storage.
 *
 * `test-approval-guard.mjs` proves the four conditions in isolation. This
 * proves the other half: that the bridge reads the gate an agent is *actually*
 * waiting on, that an approval reaches the terminal as a `y`, that a rejection
 * reaches it as an `n`, and that the words which authorised it land in
 * `audit.jsonl`. A guard that says yes to nothing real is not a guard.
 *
 * Storage is redirected to a temp directory by moving HOME before it is
 * imported — `BASE_DIR` is computed at module load. Nothing here touches the
 * user's own ~/.conduit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// `src/*.ts` imports its siblings with `.js` specifiers, which is what the
// TypeScript build wants and what `--experimental-strip-types` refuses to
// resolve. The build bundles everything into one .mjs, so there is no compiled
// module to import either. Map the specifier back to the file that exists.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const asTs = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(fileURLToPath(asTs))) return { url: asTs.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-gate-'));
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;

const storage = await import('../src/storage.ts');
const { createGateBridge } = await import('../src/voice/gate-bridge.ts');
const { ApprovalGuard } = await import('../src/voice/approval-guard.ts');

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// Confirm the redirect took, before writing anything.
if (!storage.listProjects || !fs.existsSync(TEMP_HOME)) {
  console.error('could not redirect storage to a temp home');
  process.exit(2);
}
const existing = storage.listProjects();
if (existing.length) {
  console.error(`refusing to run: storage is not isolated (${existing.length} real projects visible)`);
  process.exit(2);
}

console.log('\napprove-by-voice — against real storage\n');

// ── a project with an agent stuck on a destructive prompt ─────────────
const project = storage.createProject(
  'gatecheck', path.join(TEMP_HOME, 'work'), 'gate bridge fixture');
const agent = storage.createAgent(project.id, 'Claude', 'claude', project.cwd, 'lead');
const PROMPT = 'Run `rm -rf node_modules`? (y/n)';
storage.updateAgent(project.id, agent.id, {
  pendingGate: { prompt: PROMPT, source: 'regex' },
});

// ── a daemon that records rather than acts ────────────────────────────
const wrote = [];
const commands = [];
const daemon = {
  writeTerminal: (id, data) => wrote.push({ id, data }),
  command: (c) => commands.push(c),
  request: async () => ({ delivered: true }),
};
const broadcasts = [];
const broadcast = (m) => broadcasts.push(m);

const guard = new ApprovalGuard();
const gates = createGateBridge(daemon, broadcast, guard);

// ── finding the gate the way a voice would name it ────────────────────
t(gates.find(project.id, agent.id).found === true, 'finds the gate by ids');
t(gates.find('gatecheck', 'Claude').found === true, 'finds it by exact spoken names');
t(gates.find('gatech', 'clau').found === true, 'finds it on a partial match, as a transcriber gives');
t(gates.find('gatecheck', 'Gemini').found === false, 'an agent that does not exist is not found');
t(/no agent called/i.test(gates.find('gatecheck', 'Gemini').reason || ''),
  'and says which name it could not place');

{
  const other = storage.createAgent(project.id, 'Idle', 'gemini', project.cwd);
  const r = gates.find('gatecheck', 'Idle');
  t(r.found === false && /not waiting on anything/i.test(r.reason),
    'an agent with no pending gate says so plainly', JSON.stringify(r));
  storage.deleteAgent(project.id, other.id);
}

{
  const found = gates.find('gatecheck', 'Claude');
  t(found.found && found.gate.prompt === PROMPT,
    'and the gate carries the exact command the agent is waiting on');
}

// ── approving without having read it out ──────────────────────────────
{
  const found = gates.find('gatecheck', 'Claude');
  const r = gates.approve(found.gate);
  t(r.ok === false, 'approving before describe_gate is refused', r.message);
  t(wrote.length === 0, 'and nothing reached the terminal', JSON.stringify(wrote));
  t(storage.getAgent(project.id, agent.id).pendingGate !== undefined,
    'and the gate is still open afterwards');
}

// ── described, but nobody said the word ───────────────────────────────
{
  const found = gates.find('gatecheck', 'Claude');
  gates.noteDescribed(found.gate);
  guard.noteUserSpeech('yeah sure');
  const r = gates.approve(found.gate);
  t(r.ok === false, 'described, but "yeah sure" does not approve it', r.message);
  t(wrote.length === 0, 'still nothing reached the terminal');
}

// ── described, and said properly ──────────────────────────────────────
{
  const found = gates.find('gatecheck', 'Claude');
  gates.noteDescribed(found.gate);
  guard.noteUserSpeech('yes, approve it');
  const r = gates.approve(found.gate);
  t(r.ok === true, 'described and approved out loud → it goes through', r.message);
  t(wrote.length === 1 && wrote[0].data === 'y\r',
    'and a y reaches the agent that was waiting', JSON.stringify(wrote));
  t(storage.getAgent(project.id, agent.id).pendingGate === undefined,
    'and the gate is closed');
  t(broadcasts.some((b) => b.type === 'gate:resolved'),
    'and every viewer is told it resolved');
}

// ── the audit trail is the whole safety case ──────────────────────────
{
  const auditPath = path.join(TEMP_HOME, '.conduit', 'projects', project.id, 'audit.jsonl');
  const lines = fs.existsSync(auditPath)
    ? fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const approved = lines.find((l) => l.event === 'gate_approve');
  t(!!approved, 'the approval is written to audit.jsonl', `${lines.length} entries`);
  t(approved?.via === 'voice', 'recorded as having come from voice', JSON.stringify(approved?.via));
  t(approved?.authorisingPhrase === 'yes, approve it',
    'with the exact words that authorised it, verbatim',
    JSON.stringify(approved?.authorisingPhrase));
  t(approved?.gate?.prompt === PROMPT,
    'and the command it applied to', JSON.stringify(approved?.gate?.prompt));
}

// ── consent does not carry to the next gate ───────────────────────────
{
  storage.updateAgent(project.id, agent.id, {
    pendingGate: { prompt: 'Force-push to main? (y/n)', source: 'regex' },
  });
  const found = gates.find('gatecheck', 'Claude');
  const r = gates.approve(found.gate);
  t(r.ok === false, 'the next gate is not approved by the last one\'s consent', r.message);
  t(wrote.length === 1, 'and nothing further reached the terminal', JSON.stringify(wrote));
}

// ── rejecting needs none of it ────────────────────────────────────────
{
  const found = gates.find('gatecheck', 'Claude');
  const r = gates.reject(found.gate);
  t(r.ok === true, 'rejecting works with no ceremony at all', r.message);
  t(wrote.length === 2 && wrote[1].data === 'n\r',
    'and an n reaches the agent', JSON.stringify(wrote));
  t(storage.getAgent(project.id, agent.id).pendingGate === undefined, 'and the gate is closed');
}

// ── a non-y/n gate rejects by interrupting instead ────────────────────
{
  storage.updateAgent(project.id, agent.id, {
    pendingGate: { prompt: 'about to delete the production database', source: 'supervisor' },
  });
  const before = commands.length;
  const found = gates.find('gatecheck', 'Claude');
  const r = gates.reject(found.gate);
  t(r.ok === true, 'a Supervisor-raised gate can be rejected too');
  t(commands.length === before + 1 && commands[before].op === 'terminal:interrupt',
    'and rejecting it interrupts the agent rather than typing n',
    JSON.stringify(commands.slice(before)));
}

// ── a gate that closed underneath the conversation ────────────────────
{
  storage.updateAgent(project.id, agent.id, {
    pendingGate: { prompt: 'Delete the branch? (y/n)', source: 'regex' },
  });
  const found = gates.find('gatecheck', 'Claude');
  gates.noteDescribed(found.gate);
  guard.noteUserSpeech('approve it');
  // The user clicks Approve in the UI while still talking about it.
  storage.updateAgent(project.id, agent.id, { pendingGate: undefined });
  const r = gates.approve(found.gate);
  t(r.ok === false, 'a gate resolved elsewhere mid-sentence is not approved again', r.message);
  t(/no longer open/i.test(r.message), 'and it says the gate had closed', r.message);
}

// ── the agent moved on to a different question ────────────────────────
{
  storage.updateAgent(project.id, agent.id, {
    pendingGate: { prompt: 'Install 4 packages? (y/n)', source: 'regex' },
  });
  const found = gates.find('gatecheck', 'Claude');
  gates.noteDescribed(found.gate);
  guard.noteUserSpeech('approve it');
  storage.updateAgent(project.id, agent.id, {
    pendingGate: { prompt: 'Overwrite .env? (y/n)', source: 'regex' },
  });
  const r = gates.approve(found.gate);
  t(r.ok === false, 'consent for one command does not approve a different one', r.message);
  t(/something different/i.test(r.message), 'and it says the question changed', r.message);
  t(storage.getAgent(project.id, agent.id).pendingGate?.prompt === 'Overwrite .env? (y/n)',
    'and the new gate is still waiting');
}

// ── cleanup ───────────────────────────────────────────────────────────
storage.deleteProject(project.id, true);
try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }); } catch { /* windows holds handles */ }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('the voice path reaches real gates, and only when it should\n');
