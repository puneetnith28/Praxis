#!/usr/bin/env node
/**
 * Drive The Keeper the way the UI does — `brain:send` over the browser
 * WebSocket — and report what comes back.
 *
 * The Keeper is the one part of Conduit that cannot be checked by the smoke
 * test, because it needs a signed-in CLI. This makes its state observable:
 * which engine it chose, whether the turn produced an answer, and which of its
 * Conduit tools it actually called.
 *
 * Usage: node scripts/test-keeper.mjs ["a question"] [--new]
 *        --new starts a fresh conversation, so the answer is not shaped by
 *        whatever was said in the last one.
 * Env:   CONDUIT_URL, CONDUIT_AUTH, CONDUIT_KEEPER_ENGINE (codex | claude)
 */
import { WebSocket } from 'ws';

const BASE = process.env.CONDUIT_URL || 'http://localhost:3200';
const AUTH = process.env.CONDUIT_AUTH || '';
const args = process.argv.slice(2);
const FRESH = args.includes('--new');
const QUESTION = args.find((a) => !a.startsWith('--'))
  || 'List every project you can see, then stop. Keep it to one line.';
const TIMEOUT_MS = Number(process.env.KEEPER_TIMEOUT_MS || 180_000);

const headers = {};
if (AUTH) headers.Authorization = 'Basic ' + Buffer.from(AUTH).toString('base64');

const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error('Conduit is not running on ' + BASE + ' — start it with `npm run start:all`.');
  console.log("[skip] daemon not running"); process.exit(0);
}

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws', AUTH ? { headers } : undefined);
const messages = [];
let engine = '(unknown)';
let status = '';
let sawThinking = false;
let answer = '';
let errorText = '';

ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type !== 'brain:event') return;
  const p = m.payload || {};
  if (p.kind === 'status') {
    status = p.status;
    if (p.status === 'thinking') sawThinking = true;
  }
  if (p.kind === 'state' && p.state?.engine) engine = p.state.engine;
  if (p.kind === 'append' && p.message) {
    const { role, text, tool } = p.message;
    // Stamp arrival so serial and parallel tool use can be told apart: three
    // calls issued together look very different from three round trips.
    messages.push({ role, tool, text: String(text || ''), at: Date.now() });
    if (role === 'assistant') answer = String(text || '');   // last one wins
    if (role === 'error') errorText = String(text || '');
  }
});

await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('websocket never opened')), 10_000);
});

console.log(`\nThe Keeper — ${BASE}`);
console.log(`asking: ${JSON.stringify(QUESTION)}\n`);

if (FRESH) {
  ws.send(JSON.stringify({ type: 'brain:new' }));
  await new Promise((r) => setTimeout(r, 1500));
}
ws.send(JSON.stringify({ type: 'brain:send', message: QUESTION }));

const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Done when the turn goes back to idle after having started, or on an error.
while (Date.now() - started < TIMEOUT_MS) {
  await sleep(1000);
  if (errorText) break;
  if (sawThinking && status === 'idle') break;
}
const elapsed = Math.round((Date.now() - started) / 1000);

console.log(`engine        : ${engine}`);
console.log(`turn started  : ${sawThinking}`);
console.log(`final status  : ${status || '(none)'}`);
console.log(`elapsed       : ${elapsed}s`);

const tools = messages.filter((m) => m.role === 'tool');
if (tools.length) {
  console.log(`\ntools called  : ${tools.length}`);
  for (const t of tools.slice(0, 8)) {
    const at = ((t.at - started) / 1000).toFixed(1).padStart(5);
    console.log(`  ${at}s  ${t.tool}: ${t.text.slice(0, 80)}`);
  }
  // Find the largest run of calls issued within a moment of each other.
  // A gap after a *different* tool is expected — reading the project list
  // before acting on it is genuinely sequential — so what matters is whether
  // the repeated calls came out as one batch.
  const gaps = tools.slice(1).map((t, i) => t.at - tools[i].at);
  if (gaps.length) {
    console.log(`  gaps: ${gaps.map((g) => (g / 1000).toFixed(1) + 's').join(', ')}`);
    let run = 1, best = 1;
    for (const g of gaps) {
      if (g < 1500) { run += 1; best = Math.max(best, run); } else { run = 1; }
    }
    console.log(best > 1
      ? `  ✓ ${best} calls dispatched together (largest batch)`
      : '  · every call waited for the one before it');
  }
}

if (errorText) {
  console.log(`\n✗ error:\n  ${errorText.split('\n').slice(0, 6).join('\n  ')}`);
} else if (answer) {
  console.log(`\n✓ answer:\n  ${answer.split('\n').slice(0, 10).join('\n  ')}`);
} else {
  console.log('\n✗ no answer and no error — the turn produced nothing.');
}

ws.close();
process.exit(errorText || !answer ? 1 : 0);
