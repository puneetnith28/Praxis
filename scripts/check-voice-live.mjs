#!/usr/bin/env node
/**
 * The live voice path, end to end, without a browser.
 *
 * `check-nova.mjs` proved Nova itself. This proves the thing between you and
 * Nova: the `/ws/voice` socket, binary audio in both directions, tool calls
 * reaching the daemon, and the events the UI will render.
 *
 * It speaks a question into the socket exactly as the microphone worklet will —
 * raw PCM16 at 16 kHz, in 20 ms frames, with silence between turns because the
 * stream must never go quiet — and asserts a spoken answer comes back.
 *
 * Usage:
 *   npm run start:all
 *   npm run check:voice-live
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';

const BASE = process.env.CONDUIT_URL || 'http://localhost:3200';
const AUTH = process.env.CONDUIT_AUTH || '';
const RATE = 16000;
const FRAME = 640;            // 320 samples = 20ms, the worklet's cadence

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function t(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
  return ok;
}

const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`Conduit is not running on ${BASE} — start it with \`npm run start:all\`.`);
  process.exit(2);
}

/** Say something, as 16 kHz mono PCM16, the way the browser will send it. */
function speak(text) {
  if (process.platform !== 'win32') return null;
  const wav = path.join(os.tmpdir(), `voice-live-${Date.now()}.wav`);
  const ps = `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $s.SetOutputToWaveFile('${wav}', $fmt)
    $s.Speak(${JSON.stringify(text)})
    $s.Dispose()`;
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    const buf = fs.readFileSync(wav);
    fs.unlinkSync(wav);
    const i = buf.indexOf(Buffer.from('data', 'ascii'));
    return i >= 0 ? buf.subarray(i + 8) : buf.subarray(44);
  } catch {
    try { fs.unlinkSync(wav); } catch { /* ignore */ }
    return null;
  }
}

const clip = speak('What projects do I have? Answer in one short sentence.');
if (!clip || clip.length < 8000) {
  console.error('Could not synthesise a test clip on this machine.');
  process.exit(2);
}

console.log(`\nLive voice — ${BASE}/ws/voice`);
console.log(`speaking ${(clip.length / 2 / RATE).toFixed(1)}s of audio\n`);

const headers = AUTH ? { Authorization: 'Basic ' + Buffer.from(AUTH).toString('base64') } : undefined;
const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws/voice', headers ? { headers } : undefined);

const seen = {
  ready: false, audioBytes: 0, firstAudioAt: null, tools: [],
  userText: '', assistantText: '', errors: [], deferred: [],
};
let clipDoneAt = null;

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    if (seen.firstAudioAt === null) seen.firstAudioAt = Date.now();
    seen.audioBytes += data.length;
    return;
  }
  let m;
  try { m = JSON.parse(data.toString()); } catch { return; }
  if (m.type === 'ready') seen.ready = true;
  else if (m.type === 'transcript') {
    if (m.role === 'user') seen.userText += m.text;
    else seen.assistantText += m.text;
  } else if (m.type === 'tool') seen.tools.push(m.name);
  else if (m.type === 'deferred') seen.deferred.push(m.text);
  else if (m.type === 'error') seen.errors.push(m.message);
});

try {
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('socket never opened')), 10_000);
  });
  t(true, 'the /ws/voice socket accepts a connection');

  ws.send(JSON.stringify({ type: 'start' }));
  for (let i = 0; i < 60 && !seen.ready; i++) await sleep(250);
  if (!t(seen.ready, 'Nova session opened', seen.errors[0] || 'no ready event in 15s')) {
    throw new Error('never became ready');
  }

  // Stream the clip at real time, then keep the line alive with silence —
  // exactly what the browser does, and what Nova needs to not stall.
  for (let i = 0; i < clip.length; i += FRAME) {
    ws.send(clip.subarray(i, Math.min(i + FRAME, clip.length)), { binary: true });
    await sleep(20);
  }
  clipDoneAt = Date.now();

  const silence = Buffer.alloc(FRAME);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && seen.audioBytes < 20000) {
    ws.send(silence, { binary: true });
    await sleep(20);
  }

  t(seen.userText.trim().length > 0, 'it transcribed what was said',
    JSON.stringify(seen.userText.slice(0, 80)));
  t(seen.tools.length > 0, 'it called a tool through the daemon',
    'answered without one');
  t(seen.audioBytes > 20000, 'spoken audio came back',
    `${seen.audioBytes} bytes`);
  t(seen.assistantText.trim().length > 0, 'and a transcript of it',
    seen.errors[0] || '(silence)');

  if (seen.firstAudioAt && clipDoneAt) {
    const ms = seen.firstAudioAt - clipDoneAt;
    console.log(`\n  heard:  "${seen.userText.trim().slice(0, 110)}"`);
    console.log(`  said:   "${seen.assistantText.trim().slice(0, 160)}"`);
    console.log(`  tools:  ${seen.tools.join(' → ')}`);
    console.log(`  audio:  ${(seen.audioBytes / 2 / 24000).toFixed(1)}s back`);
    console.log(`  replied ${Math.max(0, ms)}ms after the clip ended`);
    t(ms < 2500, 'it replies in under 2.5s through the full path', `${ms}ms`);
  }
  if (seen.errors.length) console.log(`  errors: ${seen.errors.slice(0, 2).join(' | ')}`);
} catch (err) {
  t(false, 'the run completed', String(err).slice(0, 160));
} finally {
  try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ }
  await sleep(300);
  try { ws.close(); } catch { /* ignore */ }
}

console.log(failures === 0
  ? '\nthe live voice path works end to end\n'
  : `\n${failures} problem(s)\n`);
process.exit(failures === 0 ? 0 : 1);
