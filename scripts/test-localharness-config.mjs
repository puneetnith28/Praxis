#!/usr/bin/env node
// The per-agent LocalHarness config directory: init only when needed, the root
// agent carries Bedrock's MCP server, and init's refusal is reported verbatim.
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

// Never touch the real ~/.conduit: point the home directory at a temp dir.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-lh-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const {
  configDirFor,
  localHarnessEnv,
  prepareConfigDir,
  removeConfigDir,
} = await import('../src/localharness/config-dir.ts');

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-localharness.mjs');

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const calls = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'init-calls.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)); }
  catch { return []; }
};
const base = { binary: process.execPath, binaryArgs: [FAKE], baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' };
const mcp = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['E:\\bedrock\\dist\\mcp-server.js', '--agent', 'a1'], env: { CONDUIT_AUTH: 'u:p"q' } };

console.log('\nLocalHarness config directory tests\n');

try {
  // 1. Paths.
  const dir = configDirFor('agent-1');
  t(dir === path.join(home, '.conduit', 'localharness', 'agent-1'), 'lives under ~/.conduit/localharness/<agentId>');
  t(localHarnessEnv('agent-1').LOCALHARNESS_DIR === dir, 'LOCALHARNESS_DIR points at it');
  let threw = false;
  try { configDirFor('../escape'); } catch { threw = true; }
  t(threw, 'an agent id that is not id-shaped is refused');

  // 2. First prepare runs init and writes the root agent with the MCP server.
  const got = await prepareConfigDir('agent-1', { ...base, mcp });
  t(got === dir && fs.existsSync(path.join(dir, 'config.yaml')), 'init writes the config');
  t(calls(dir).length === 1 && calls(dir)[0].force === false, 'init ran once, without --force');
  const root = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'orchestrator.yaml'), 'utf-8'));
  t(root.name === 'orchestrator' && root.role && root.model === 'inherit', 'the root agent keeps the fields LocalHarness mints');
  const server = root.tools?.mcp_servers?.[0];
  t(server?.name === 'bedrock' && server.transport === 'stdio', 'the root agent attaches the bedrock MCP server over stdio');
  t(server?.command === mcp.command && server.args.join(' ') === mcp.args.join(' ') && server.env.CONDUIT_AUTH === 'u:p"q',
    'Windows paths and quotes survive the round trip');

  // 3. Unchanged settings do not re-run init.
  await prepareConfigDir('agent-1', { ...base, mcp: null });
  t(calls(dir).length === 1, 'a second prepare with the same settings skips init');
  const rootNoMcp = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'orchestrator.yaml'), 'utf-8'));
  t(rootNoMcp.tools === undefined, 'the MCP server is removed when no longer wanted');

  // 4. A model change re-initialises with --force.
  await prepareConfigDir('agent-1', { ...base, model: 'qwen3:8b', mcp: null });
  t(calls(dir).length === 2 && calls(dir)[1].force === true && calls(dir)[1].model === 'qwen3:8b',
    'a changed model re-runs init with --force');

  // 5. init's refusal comes back as one readable sentence.
  try {
    await prepareConfigDir('agent-2', { ...base, baseUrl: 'http://down.invalid:1/v1', mcp: null });
    t(false, 'an unreachable endpoint fails the prepare');
  } catch (err) {
    t(/^LocalHarness setup failed: no answer from http:\/\/down\.invalid:1\/v1/.test(err.message),
      'the failure carries init\'s own reason', err.message);
    t(!err.message.includes('\n'), 'wrapped lines are joined into one sentence');
  }
  t(!fs.existsSync(path.join(configDirFor('agent-2'), 'bedrock.json')), 'a failed init records nothing');

  // 6. A binary that cannot run.
  try {
    await prepareConfigDir('agent-3', { ...base, binary: 'no-such-localharness-binary', binaryArgs: [], mcp: null });
    t(false, 'a missing binary fails the prepare');
  } catch (err) {
    t(/Could not run `localharness init`/.test(err.message), 'a missing binary says what could not run', err.message);
  }

  // 7. Remove.
  removeConfigDir('agent-1');
  t(!fs.existsSync(dir), 'removeConfigDir deletes the directory');
  removeConfigDir('agent-1');
  t(true, 'removing twice is harmless');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
