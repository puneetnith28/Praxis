#!/usr/bin/env node
/**
 * Does a mid-sentence pause cut a spoken command in half?
 *
 * The one voice behaviour that cannot be unit-tested: it needs a real
 * recogniser, a real microphone and the real app. A clip is played through
 * Chromium's fake audio device — "Jarvis", a pause, "start the agent", a
 * one-second pause, "called gere" — and the app's outgoing commands are
 * intercepted rather than run. Correct behaviour is exactly one dispatch
 * carrying the whole sentence.
 *
 * Needs: a running Conduit, a cloud STT provider configured, and the clip at
 * %TEMP%/voice-test/paused.wav (see the voice notes in README).
 *
 * Usage: node scripts/check-voice-pause.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const PORT = 9801;
const WAV = path.join(os.tmpdir(), 'voice-test', 'paused.wav');
const bin = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!bin || !fs.existsSync(WAV)) { console.error('missing browser or clip'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-'));
const child = spawn(bin, [
  '--no-first-run', '--no-default-browser-check',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${WAV}`,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1100,760', 'http://localhost:3200/#console',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = l.find((t) => t.type === 'page' && String(t.url).includes('localhost:3200'))?.webSocketDebuggerUrl || null;
  } catch { /* not up */ }
  if (!wsUrl) await sleep(500);
}
if (!wsUrl) { child.kill(); console.error('no page target'); process.exit(2); }

const cdp = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
cdp.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => cdp.on('open', r));
const call = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); cdp.send(JSON.stringify({ id: i, method: m, params: p })); });
const evalJs = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: `(async () => (${expr}))()`, returnByValue: true, awaitPromise: true });
  if (r?.result?.exceptionDetails) return 'THREW: ' + r.result.exceptionDetails.text;
  return r?.result?.result?.value ?? null;
};

await sleep(2500);
await evalJs('localStorage.setItem("conduit:wake","1")');
await evalJs('localStorage.setItem("conduit:wake-phrase","jarvis")');
await call('Page.enable', {});
await call('Page.reload', {});
await sleep(8000);

// Record every command the app tries to dispatch, without letting it run.
await evalJs(`(() => {
  window.__cmds = []; window.__toasts = [];
  const s = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    try {
      if (typeof d === 'string' && d.includes('brain:send')) {
        window.__cmds.push(JSON.parse(d).message);
        return;                       // swallow: we are measuring, not running
      }
    } catch {}
    return s.call(this, d);
  };
  const mo = new MutationObserver(() => {
    for (const el of document.querySelectorAll('[class*=toast]')) {
      const t = (el.textContent || '').trim();
      if (t && !window.__toasts.includes(t)) window.__toasts.push(t);
    }
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  return true;
})()`);

console.log('\nMid-sentence pause — does the command survive intact?\n');
console.log('  clip: "Jarvis" … 1.5s … "start the agent" … 1.0s … "called gere"');
console.log('  listening 45s…\n');

for (let i = 1; i <= 9; i++) {
  await sleep(5000);
  const cmds = JSON.parse(await evalJs('JSON.stringify(window.__cmds||[])') || '[]');
  if (cmds.length) console.log(`  t+${i * 5}s  dispatched ${cmds.length}: ${JSON.stringify(cmds)}`);
}

const cmds = JSON.parse(await evalJs('JSON.stringify(window.__cmds||[])') || '[]');
const toasts = JSON.parse(await evalJs('JSON.stringify(window.__toasts||[])') || '[]');
console.log(`\n  commands dispatched : ${cmds.length}`);
for (const c of cmds) console.log(`    · ${JSON.stringify(c)}`);
console.log(`  toasts              : ${JSON.stringify(toasts.slice(0, 3))}`);

// What matters is that the pause did not split the sentence: exactly one
// dispatch, carrying both halves. The transcription of "gere" itself varies —
// it is not a real word — so the assertion is on structure, not spelling.
const one = cmds.length === 1;
const hasFirst = one && /start the agent/i.test(cmds[0]);
const hasSecond = one && cmds[0].trim().split(/\s+/).length > 3;
const joined = one && hasFirst && hasSecond;
console.log(`  ${one ? '✓' : '✗'} dispatched exactly once (not split by the pause)`);
console.log(`  ${hasFirst ? '✓' : '✗'} the first half is present`);
console.log(`  ${hasSecond ? '✓' : '✗'} speech after the pause is present`);
console.log(`\n  ${joined ? '✓' : '✗'} the sentence arrived as one whole command`);

cdp.close();
child.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(joined ? 0 : 1);
