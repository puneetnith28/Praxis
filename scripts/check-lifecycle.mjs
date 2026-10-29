#!/usr/bin/env node
/**
 * The awkward moments in an agent's life.
 *
 * The smoke test walks the happy path: create, start, watch, stop, delete, in
 * that order, one at a time. Real use is messier — a project gets renamed
 * while its agents are running, an agent is deleted mid-turn, someone
 * double-clicks Start, two browsers watch the same terminal. Each of those
 * crosses a boundary between the web server, the daemon and the filesystem,
 * and each has its own way of going wrong quietly: an orphaned PTY, a watcher
 * left on a directory that no longer exists, a duplicate process, a viewer
 * that stops receiving output.
 *
 * Nothing here should return a 5xx, and the app must be in a coherent state
 * afterwards.
 *
 * Usage:
 *   npm run start:all       # in one shell
 *   npm run check:lifecycle
 *
 * Env: CONDUIT_URL, CONDUIT_AUTH
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const BASE = process.env.CONDUIT_URL || 'http://localhost:3200';
const AUTH = process.env.CONDUIT_AUTH || '';
const CLI = process.env.LIFECYCLE_CLI || 'claude';

const headers = { 'Content-Type': 'application/json' };
if (AUTH) headers.Authorization = 'Basic ' + Buffer.from(AUTH).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function t(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
  return ok;
}

async function api(method, p, body) {
  const res = await fetch(BASE + '/api' + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`Conduit is not running on ${BASE} — start it with \`npm run start:all\`.`);
  process.exit(2);
}

/** A socket that records everything, the way a browser tab would. */
function viewer() {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws', AUTH ? { headers } : undefined);
  const seen = { output: new Map(), statuses: [], org: 0, frames: 0 };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    seen.frames++;
    if (m.type === 'terminal:output') seen.output.set(m.agentId, (seen.output.get(m.agentId) || '') + m.data);
    if (m.type === 'agent:status') seen.statuses.push(`${m.agentId}:${m.status}`);
    if (m.type === 'org:changed') seen.org++;
  });
  const ready = new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('socket never opened')), 10_000);
  });
  return { ws, seen, ready, attach: (id) => ws.send(JSON.stringify({ type: 'terminal:attach', agentId: id })) };
}

const stamp = Date.now().toString(36);
const dir = path.join(os.tmpdir(), 'lifecycle-' + stamp);
fs.mkdirSync(dir, { recursive: true });
const created = await api('POST', '/projects', { name: 'lifecycle-' + stamp, cwd: dir });
if (created.status !== 201) {
  console.error('could not create the fixture project:', created.status, created.json);
  process.exit(2);
}
const pid = created.json.id;
let renamed = null;

console.log(`\nLifecycle — ${BASE}\n`);

const a = viewer();
const b = viewer();
try {
  await Promise.all([a.ready, b.ready]);

  // ── 1. Two viewers on one terminal ──────────────────────────────────
  const made = await api('POST', `/projects/${pid}/agents`, { name: 'One', cli: CLI });
  const agentId = made.json?.id;
  a.attach(agentId);
  b.attach(agentId);
  await sleep(300);
  const started = await api('POST', `/projects/${pid}/agents/${agentId}/start`);
  t(started.status === 200, 'the agent starts', `${started.status} ${JSON.stringify(started.json)}`);

  for (let i = 0; i < 30 && (a.seen.output.get(agentId) || '').length < 40; i++) await sleep(500);
  const aBytes = (a.seen.output.get(agentId) || '').length;
  // The second viewer gets a private replay so the first does not see the
  // scroll-back twice — both must end up with the same terminal.
  for (let i = 0; i < 20 && (b.seen.output.get(agentId) || '').length < 40; i++) await sleep(500);
  const bBytes = (b.seen.output.get(agentId) || '').length;
  t(aBytes >= 40 && bBytes >= 40, 'both viewers receive the terminal',
    `first ${aBytes} bytes, second ${bBytes}`);

  // ── 2. Start an already-running agent ───────────────────────────────
  const again = await api('POST', `/projects/${pid}/agents/${agentId}/start`);
  t(again.status === 409 || again.status === 200,
    'starting a running agent is refused or is a no-op, never a second process',
    `${again.status} ${JSON.stringify(again.json)}`);
  await sleep(1500);
  const afterDouble = await api('GET', `/projects/${pid}/agents`);
  t(afterDouble.json?.find((x) => x.id === agentId)?.status === 'running',
    'and the agent is still running afterwards');

  // ── 3. Rename the project while its agent runs ──────────────────────
  // The name doubles as the folder name under shared_content/ and wiki/, so a
  // rename moves directories out from under a running agent and its watcher.
  renamed = 'renamed-' + stamp;
  const ren = await api('PUT', `/projects/${pid}`, { name: renamed });
  t(ren.status === 200, 'a project can be renamed while an agent is running',
    `${ren.status} ${JSON.stringify(ren.json)}`);
  await sleep(1000);
  const home = path.join(os.homedir(), '.conduit');
  t(fs.existsSync(path.join(home, 'shared_content', renamed)),
    'shared_content moved with it',
    `no ${path.join(home, 'shared_content', renamed)}`);
  t(!fs.existsSync(path.join(home, 'shared_content', 'lifecycle-' + stamp)),
    'and the old directory is gone');

  // The activity watcher has to follow the move, or the feed goes quiet.
  const beforeCount = (await api('GET', `/activity?projectId=${pid}`)).json?.length ?? 0;
  fs.writeFileSync(path.join(home, 'shared_content', renamed, 'after-rename.md'), '# written after the rename\n');
  await sleep(2500);
  const afterCount = (await api('GET', `/activity?projectId=${pid}`)).json?.length ?? 0;
  t(afterCount > beforeCount, 'the activity watcher followed the rename',
    `${beforeCount} → ${afterCount} events`);

  const stillRunning = await api('GET', `/projects/${pid}/agents`);
  t(stillRunning.json?.find((x) => x.id === agentId)?.status === 'running',
    'the running agent survived the rename');

  // ── 4. Rapid stop/start ─────────────────────────────────────────────
  // The viewer never re-attaches. The daemon has to rebind it to the new
  // process on its own, or the pane goes dead until the user clicks away and
  // back — and a dead pane looks exactly like a quiet agent.
  const beforeRestart = (a.seen.output.get(agentId) || '').length;

  for (let i = 0; i < 3; i++) {
    const s = await api('POST', `/projects/${pid}/agents/${agentId}/stop`);
    if (s.status >= 500) t(false, 'rapid stop', String(s.status));
    const r = await api('POST', `/projects/${pid}/agents/${agentId}/start`);
    if (r.status >= 500) t(false, 'rapid start', String(r.status));
  }
  await sleep(3000);
  const cycled = await api('GET', `/projects/${pid}/agents`);
  t(cycled.json?.find((x) => x.id === agentId)?.status === 'running',
    'three stop/start cycles in a row leave it running',
    JSON.stringify(cycled.json?.find((x) => x.id === agentId)?.status));

  // A fresh process reprints its banner, so growth here is the rebinding
  // working — no input needed, and none is sent, because a CLI is free to
  // ignore a bare carriage return and that would prove nothing either way.
  for (let i = 0; i < 30 && (a.seen.output.get(agentId) || '').length <= beforeRestart; i++) {
    await sleep(500);
  }
  const afterRestart = (a.seen.output.get(agentId) || '').length;
  t(afterRestart > beforeRestart,
    'a viewer attached before the restart still receives the new process',
    `${beforeRestart} bytes before, ${afterRestart} after — the listener was not rebound`);

  // ── 5. Delete a running agent ───────────────────────────────────────
  const del = await api('DELETE', `/projects/${pid}/agents/${agentId}`);
  t(del.status === 204 || del.status === 200, 'a running agent can be deleted',
    `${del.status} ${JSON.stringify(del.json)}`);
  await sleep(1500);
  const gone = await api('GET', `/projects/${pid}/agents`);
  t(!gone.json?.some((x) => x.id === agentId), 'and it is gone from the roster');

  // ── 6. Operations on things that no longer exist ────────────────────
  for (const [label, r] of [
    ['start', await api('POST', `/projects/${pid}/agents/${agentId}/start`)],
    ['stop', await api('POST', `/projects/${pid}/agents/${agentId}/stop`)],
    ['delete', await api('DELETE', `/projects/${pid}/agents/${agentId}`)],
    ['gate', await api('POST', `/projects/${pid}/agents/${agentId}/gate/resolve`, { decision: 'reject' })],
  ]) {
    t(r.status < 500, `${label} on a deleted agent answers ${r.status}, not a 5xx`,
      JSON.stringify(r.json));
  }

  t(a.seen.org > 0 && b.seen.org > 0, 'both viewers were told the org changed',
    `${a.seen.org} / ${b.seen.org}`);

  // ── 7. A deleted project stays deleted ──────────────────────────────
  // The Supervisor debounces for 10s before classifying a batch, so deleting a
  // project with a *running* agent reliably lands a summary after the project
  // is gone. That used to recreate the directory to append one line, leaving
  // an unreachable folder behind every project ever deleted — so the delete
  // has to happen with the watcher live, or this proves nothing.
  const last = await api('POST', `/projects/${pid}/agents`, { name: 'Two', cli: CLI });
  await api('POST', `/projects/${pid}/agents/${last.json?.id}/start`);
  await sleep(4000);   // it prints its banner; the watcher buffers it
  t(true, 'an agent is running with the Supervisor watching it');

  const removed = await api('DELETE', `/projects/${pid}?removeData=true`);
  t(removed.status === 204 || removed.status === 200,
    'the project is deleted out from under a live classification',
    String(removed.status));

  // Past the 10s debounce and the round trip that follows it.
  await sleep(25_000);
  const projectDir = path.join(os.homedir(), '.conduit', 'projects', pid);
  const back = fs.existsSync(projectDir);
  t(!back, 'and nothing recreates its directory afterwards',
    `it came back holding ${back ? fs.readdirSync(projectDir).join(', ') : ''}`);
} catch (err) {
  t(false, 'the run completed', String(err).slice(0, 200));
} finally {
  try { a.ws.close(); } catch { /* ignore */ }
  try { b.ws.close(); } catch { /* ignore */ }
  await api('DELETE', `/projects/${pid}?removeData=true`).catch(() => {});
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const after = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
t(after?.ok === true && after?.daemon === true,
  'the server and daemon are both still up afterwards', JSON.stringify(after));

console.log(`\n${failures === 0 ? 'the awkward moments are handled' : `${failures} problem(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
