#!/usr/bin/env node
// Local model server settings and the /models probe, against a mock server.
import fs from 'node:fs';
import http from 'node:http';
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

// Saved settings live in ~/.conduit/settings.json: use a temp home, never the real one.
import os from 'node:os';
import path from 'node:path';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-llm-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const {
  DEFAULT_LOCAL_LLM_BASE_URL,
  normalizeBaseUrl,
  localLlmSettings,
  listLocalModels,
  resetLocalModelsCache,
  pickModel,
  saveLocalLlm,
  savedLocalLlm,
  localLlmSources,
} = await import('../src/local-llm.ts');

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\nLocal model server tests\n');

// 1. URL normalisation.
t(normalizeBaseUrl('http://127.0.0.1:1234') === 'http://127.0.0.1:1234/v1', 'a bare host gets /v1');
t(normalizeBaseUrl('http://127.0.0.1:11434/v1/') === 'http://127.0.0.1:11434/v1', 'a trailing slash is dropped');
t(normalizeBaseUrl('https://box.local/openai/v1') === 'https://box.local/openai/v1', 'a custom path is kept');
t(normalizeBaseUrl('ftp://x') === null, 'non-http schemes are refused');
t(normalizeBaseUrl('http://user:pw@host/v1') === null, 'credentials in the URL are refused');
t(normalizeBaseUrl('not a url') === null && normalizeBaseUrl('') === null, 'garbage and empty are refused');

// 2. Settings from the environment.
for (const k of ['LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'LOCAL_LLM_API_KEY']) delete process.env[k];
let s = localLlmSettings();
t(s.baseUrl === DEFAULT_LOCAL_LLM_BASE_URL && !s.configured, 'defaults to Ollama, marked as not configured');
t(s.apiKey === 'none' && s.model === '', 'no key and no model by default');
process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:1234';
process.env.LOCAL_LLM_MODEL = ' qwen3 ';
s = localLlmSettings();
t(s.configured && s.baseUrl === 'http://127.0.0.1:1234/v1' && s.model === 'qwen3', 'reads and normalises the environment');
process.env.LOCAL_LLM_BASE_URL = 'garbage';
t(!localLlmSettings().configured && localLlmSettings().baseUrl === DEFAULT_LOCAL_LLM_BASE_URL,
  'an unusable URL falls back to the default and is not counted as configured');

// 2b. Saved settings (the Settings screen) — the environment still wins.
for (const k of ['LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'LOCAL_LLM_API_KEY']) delete process.env[k];
saveLocalLlm({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'saved-model', apiKey: 'sk-local' });
let sv = localLlmSettings();
t(sv.baseUrl === 'http://127.0.0.1:1234/v1' && sv.model === 'saved-model' && sv.apiKey === 'sk-local' && sv.configured, 'saved settings apply when the environment is silent');
t(localLlmSources().baseUrl === 'settings', 'and are reported as coming from settings');
process.env.LOCAL_LLM_MODEL = 'env-model';
t(localLlmSettings().model === 'env-model' && localLlmSources().model === 'env', 'an environment variable beats a saved value');
delete process.env.LOCAL_LLM_MODEL;
saveLocalLlm({ model: '', apiKey: '' });
t(savedLocalLlm().model === undefined && savedLocalLlm().apiKey === undefined && savedLocalLlm().baseUrl, 'an empty value clears just that field');
saveLocalLlm({ baseUrl: '' });

// 3. The probe, against a mock OpenAI-compatible server.
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  if (req.url === '/v1/models') {
    if (req.headers.authorization === 'Bearer wrong') { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama3.2' }, { id: 'qwen3:8b' }] }));
  } else if (req.url === '/text/models') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not an API</html>');
  } else {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  resetLocalModelsCache();
  const ok = await listLocalModels({ baseUrl: `${base}/v1`, apiKey: 'none' });
  t(ok.ok && ok.models.join(',') === 'llama3.2,qwen3:8b', 'lists the models the server serves', JSON.stringify(ok));

  const before = hits;
  await listLocalModels({ baseUrl: `${base}/v1`, apiKey: 'none' });
  t(hits === before, 'a second probe within the window is served from cache');
  await listLocalModels({ baseUrl: `${base}/v1`, apiKey: 'none' }, { fresh: true });
  t(hits === before + 1, 'fresh: true bypasses the cache');

  const denied = await listLocalModels({ baseUrl: `${base}/v1`, apiKey: 'wrong' });
  t(!denied.ok && /refused the key/.test(denied.error), 'a rejected key says so');

  const notApi = await listLocalModels({ baseUrl: `${base}/text`, apiKey: 'none' });
  t(!notApi.ok && /did not return JSON/.test(notApi.error), 'a non-API URL says it is not OpenAI-compatible');

  const missing = await listLocalModels({ baseUrl: `${base}/nope`, apiKey: 'none' });
  t(!missing.ok && /HTTP 404/.test(missing.error), 'a wrong path reports the status');

  // pickModel
  t(pickModel({ ...s, model: 'mine' }, ok) === 'mine', 'a configured model wins');
  t(pickModel({ ...s, model: '' }, ok) === 'llama3.2', 'otherwise the first listed model');
  t(pickModel({ ...s, model: '' }, { ok: true, baseUrl: base, models: [] }) === null, 'null when the server has no model');
} finally {
  await new Promise((r) => server.close(r));
}

// 4. Nothing listening.
const down = await listLocalModels({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'none' }, { fresh: true, timeoutMs: 1500 });
t(!down.ok && /No local model server/.test(down.error) && /LOCAL_LLM_BASE_URL/.test(down.error),
  'an unreachable server names the fix', down.ok ? '' : down.error);

console.log(`\n${pass} passed, ${fail} failed\n`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
