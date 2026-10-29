#!/usr/bin/env node
// The LocalHarness start preflight: the local model server must answer and
// serve a usable model before an agent is started, and each refusal names the fix.
import fs from 'node:fs';
import http from 'node:http';
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

// storage.ts fixes its base dir at import time, so redirect home first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-lh-prep-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { prepareLocalHarnessAgent } = await import('../src/localharness/prepare.ts');
const { AgentStartError } = await import('../src/pty-manager.ts');
const { resetLocalModelsCache } = await import('../src/local-llm.ts');

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-localharness.mjs');
const deps = { binary: process.execPath, binaryArgs: [FAKE] };

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

let models = [];
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const agent = { id: 'agent-lh', projectId: 'p1', name: 'Local', cli: 'localharness', cwd: home, status: 'stopped' };

async function expectRefusal(name, pattern) {
  resetLocalModelsCache();
  try {
    await prepareLocalHarnessAgent(agent, deps);
    t(false, name, 'it started');
  } catch (err) {
    t(err instanceof AgentStartError && pattern.test(err.message), name, err.message);
  }
}

console.log('\nLocalHarness start preflight tests\n');

try {
  delete process.env.LOCAL_LLM_MODEL;

  process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:9/v1';
  await expectRefusal('a model server that is down stops the start, naming LOCAL_LLM_BASE_URL', /No local model server[\s\S]*LOCAL_LLM_BASE_URL/);

  process.env.LOCAL_LLM_BASE_URL = base;
  models = [];
  await expectRefusal('a server with no model says to pull one', /serves no model[\s\S]*ollama pull/);

  models = ['llama3.2', 'qwen3:8b'];
  process.env.LOCAL_LLM_MODEL = 'mistral';
  await expectRefusal('a configured model the server lacks is named, with what it does serve', /does not serve "mistral"[\s\S]*llama3\.2, qwen3:8b/);

  delete process.env.LOCAL_LLM_MODEL;
  resetLocalModelsCache();
  const ok = await prepareLocalHarnessAgent(agent, deps);
  t(ok.model === 'llama3.2' && ok.baseUrl === base, 'otherwise it uses the first model the server lists');
  t(fs.existsSync(path.join(ok.configDir, 'config.yaml')), 'and writes the agent\'s LocalHarness config');
  t(ok.configDir.startsWith(home), 'inside the (redirected) home directory');
  t(typeof ok.mcp === 'boolean', 'reports whether the MCP server was attached');

  process.env.LOCAL_LLM_BASE_URL = 'http://down.invalid:1/v1';
  resetLocalModelsCache();
  // A reachable /models but a failing init: simulate by pointing the fake init at "down".
  // (The probe hits the mock server through the override below.)
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => realFetch(String(url).replace('http://down.invalid:1/v1', base), opts);
  try {
    await expectRefusal('a failing init surfaces as a start error with its reason', /LocalHarness setup failed: no answer from/);
  } finally {
    globalThis.fetch = realFetch;
  }
} finally {
  await new Promise((r) => server.close(r));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
