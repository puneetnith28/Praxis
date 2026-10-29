#!/usr/bin/env node
// The Keeper's ask_agent against a LocalHarness agent: the reply of exactly
// that turn comes back, and a cancelled turn or a crash says so instead.
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-lh-dispatch-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const storage = await import('../src/storage.ts');
const lh = await import('../src/daemon/localharness-agents.ts');
const { askAgentDispatch } = await import('../src/daemon/conduit.ts');

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');
const prepared = {
  configDir: path.join(home, 'cfg'), baseUrl: 'http://127.0.0.1:11434/v1', model: 'test-model',
  binary: process.execPath, binaryArgs: [FAKE], shell: false, mcp: false,
};

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\nask_agent → LocalHarness\n');

const cwd = path.join(home, 'proj');
fs.mkdirSync(cwd, { recursive: true });
const project = storage.createProject('Dispatch', cwd);
const agent = storage.createAgent(project.id, 'Local', 'localharness', cwd);

try {
  const stopped = await askAgentDispatch('Dispatch', 'Local', 'hello');
  t(stopped.status === 'not-running', 'a stopped agent is reported as not running');

  await lh.startAgent(agent, () => {}, prepared);
  const t0 = Date.now();
  const r = await askAgentDispatch('Dispatch', 'Local', 'echo:42');
  t(r.ok && r.status === 'replied', 'a running agent replies', JSON.stringify(r));
  t(r.reply === '42', 'with the text of exactly that turn', r.reply);
  t(lh.getItems(agent.id).some((i) => i.role === 'user' && i.text === '[Message from Bedrock Orchestrator]: echo:42'),
    'sent attributed to the orchestrator');
  t(Date.now() - t0 < 10_000, 'without the 16-second boot wait other CLIs get');
  t(r.cli === 'localharness' && r.agentName === 'Local', 'naming the agent it asked');

  const refused = await askAgentDispatch('Dispatch', 'Local', 'write');
  t(!refused.ok && refused.status === 'no-reply' && /cancelled/.test(refused.error || ''),
    'a turn cut short by a refused permission says so, and not to resend', JSON.stringify(refused));

  const crashed = await askAgentDispatch('Dispatch', 'Local', 'crash');
  t(!crashed.ok && crashed.status === 'crashed' && /do not resend/.test(crashed.error || ''),
    'a crash mid-turn is reported as crashed', JSON.stringify(crashed));
} finally {
  for (const id of lh.getRunningAgentIds()) lh.stopAgent(id);
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
