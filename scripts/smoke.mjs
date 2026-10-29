#!/usr/bin/env node
/**
 * End-to-end smoke test against a running Conduit (daemon + web server).
 *
 *   npm run start:all      # in one terminal
 *   npm run smoke          # in another
 *
 * Creates a throwaway project, exercises REST + WebSocket (including starting
 * a real agent when the CLI is installed), then deletes everything it made.
 * Env: CONDUIT_URL (default http://localhost:3200), CONDUIT_AUTH=user:pass,
 *      SMOKE_CLI (default claude), SMOKE_SKIP_AGENT=1 to skip the live agent.
 */

import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** True when `cmd` is not on PATH. */
function cliMissing(cmd) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [cmd], { shell: true, stdio: 'ignore' })
    : spawnSync('which', [cmd], { stdio: 'ignore' });
  return probe.status !== 0;
}

/**
 * Pick a PTY agent type whose CLI is NOT installed, to exercise the startup
 * preflight. Returns null when every candidate is installed. (`codex` is
 * excluded: it runs on app-server, not a PTY.)
 */
function pickMissingCli() {
  const candidates = [
    { cli: 'opencode', bin: 'opencode' },
    { cli: 'gemini', bin: 'gemini' },
    { cli: 'gpt', bin: 'aider' },
    { cli: 'nemotron', bin: 'aider' },
    // Last, so machines that lack an earlier one test exactly what they did.
    // Its binary preflight is the same check whatever runtime it then uses.
    { cli: 'localharness', bin: 'localharness' },
  ];
  return candidates.find((c) => cliMissing(c.bin)) ?? null;
}

const BASE = process.env.CONDUIT_URL || 'http://localhost:3200';
const AUTH = process.env.CONDUIT_AUTH || '';
const CLI = process.env.SMOKE_CLI || 'claude';
const SKIP_AGENT = process.env.SMOKE_SKIP_AGENT === '1';

const headers = { 'Content-Type': 'application/json' };
if (AUTH) headers.Authorization = 'Basic ' + Buffer.from(AUTH).toString('base64');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
async function api(method, p, body) {
  const res = await fetch(BASE + '/api' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect() {
  return new Promise((resolve, reject) => {
    const url = BASE.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(url, { headers: AUTH ? { Authorization: headers.Authorization } : {} });
    const frames = [];
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
  });
}
async function waitFor(frames, pred, timeoutMs, label, from = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (let i = from; i < frames.length; i++) if (pred(frames[i])) return frames[i];
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const stamp = Date.now().toString(36);
const projName = `smoke-${stamp}`;
const projCwd = path.join(os.tmpdir(), 'conduit-smoke', projName);
let projectId = null;

try {
  console.log(`\nBedrock smoke test → ${BASE}\n`);

  // ── health ──────────────────────────────────────────────────────────
  {
    const h = await api('GET', '/health');
    ok(h.status === 200 && h.json?.ok, 'GET /api/health');
    ok(h.json?.daemon === true, 'daemon connected', JSON.stringify(h.json));
    const nf = await api('GET', '/nope');
    ok(nf.status === 404 && nf.json?.error, 'unknown /api route is a JSON 404');
  }

  // ── websocket + hello ───────────────────────────────────────────────
  const { ws, frames } = await wsConnect();
  ok(true, 'websocket connected');
  const hello = await waitFor(frames, (f) => f.type === 'hello', 3000, 'hello');
  ok(hello.daemon === true, 'hello reports daemon');
  ws.send(JSON.stringify({ type: 'ping' }));
  await waitFor(frames, (f) => f.type === 'pong', 3000, 'pong');
  ok(true, 'ping/pong');

  // ── projects ────────────────────────────────────────────────────────
  {
    const bad = await api('POST', '/projects', { name: 'x' });
    ok(bad.status === 400, 'POST /projects without cwd → 400');
    const created = await api('POST', '/projects', { name: projName, cwd: projCwd, description: 'smoke' });
    ok(created.status === 201 && created.json?.id, 'POST /projects');
    projectId = created.json.id;
    ok(fs.existsSync(projCwd), 'project cwd created on disk');
    const dup = await api('POST', '/projects', { name: projName, cwd: projCwd });
    ok(dup.status === 409, 'duplicate project name → 409');
    const list = await api('GET', '/projects');
    ok(list.json.some((p) => p.id === projectId), 'GET /projects lists it');
    await waitFor(frames, (f) => f.type === 'org:changed', 3000, 'org:changed');
    ok(true, 'org:changed broadcast on create');
    const renamed = await api('PUT', `/projects/${projectId}`, { description: 'smoke test project' });
    ok(renamed.status === 200 && renamed.json.description === 'smoke test project', 'PUT /projects/:id');
  }

  // ── agents ──────────────────────────────────────────────────────────
  let alpha = null, beta = null;
  {
    const badCli = await api('POST', `/projects/${projectId}/agents`, { name: 'Bad', cli: 'bash' });
    ok(badCli.status === 400, 'invalid cli → 400');
    const a = await api('POST', `/projects/${projectId}/agents`, { name: 'Alpha', cli: CLI, role: 'tester' });
    ok(a.status === 201 && a.json?.id, 'POST agent Alpha');
    alpha = a.json;
    const b = await api('POST', `/projects/${projectId}/agents`, { name: 'Beta', cli: 'gemini' });
    ok(b.status === 201, 'POST agent Beta');
    beta = b.json;
    const dup = await api('POST', `/projects/${projectId}/agents`, { name: 'alpha', cli: CLI });
    ok(dup.status === 409, 'duplicate agent name → 409');
    const list = await api('GET', `/projects/${projectId}/agents`);
    ok(list.json.length === 2 && list.json.every((x) => x.status === 'stopped'), 'GET agents → 2 stopped');
    const tm = await api('GET', `/projects/${projectId}/agents/${alpha.id}/teammates`);
    ok(tm.json?.teammates?.length === 1 && tm.json.teammates[0].name === 'Beta', 'teammates endpoint');
    const upd = await api('PUT', `/projects/${projectId}/agents/${beta.id}`, { role: 'reviewer', bogus: 'x' });
    ok(upd.status === 200 && upd.json.role === 'reviewer' && !('bogus' in upd.json), 'PUT agent whitelists fields');
  }

  // ── shared content + path traversal ─────────────────────────────────
  {
    const c = await api('POST', `/projects/${projectId}/content`, { filename: 'notes.md', content: '# hi' });
    ok(c.status === 201, 'POST content');
    const g = await api('GET', `/projects/${projectId}/content/notes.md`);
    ok(g.status === 200 && g.json.content === '# hi', 'GET content');
    const u = await api('PUT', `/projects/${projectId}/content/notes.md`, { content: '# hi2' });
    ok(u.status === 200 && u.json.content === '# hi2', 'PUT content');
    const nested = await api('POST', `/projects/${projectId}/content`, { filename: 'sub/deep.md', content: 'x' });
    ok(nested.status === 201, 'nested content path allowed');
    const trav1 = await api('GET', `/projects/${projectId}/content/..%2F..%2F..%2Fpackage.json`);
    ok(trav1.status === 404, 'traversal GET blocked');
    const trav2 = await api('POST', `/projects/${projectId}/content`, { filename: '../../evil.md', content: 'x' });
    ok(trav2.status === 400, 'traversal POST blocked');
    const trav3 = await api('PUT', `/projects/${projectId}/wiki/..%2F..%2Fevil.md`, { content: 'x' });
    ok(trav3.status === 400, 'traversal wiki PUT blocked');
    const abs = await api('POST', `/projects/${projectId}/content`, { filename: 'C:/Windows/evil.md', content: 'x' });
    ok(abs.status === 400, 'absolute path blocked');
    const listC = await api('GET', `/projects/${projectId}/content`);
    ok(listC.json.some((f) => f.filename === 'sub/deep.md'), 'content listing includes nested file');
    const d = await api('DELETE', `/projects/${projectId}/content/sub/deep.md`);
    ok(d.status === 204, 'DELETE content');
  }

  // ── wiki ────────────────────────────────────────────────────────────
  {
    const st = await api('GET', `/projects/${projectId}/wiki/status`);
    ok(st.json?.initialized === true, 'wiki auto-initialized with project');
    const files = await api('GET', `/projects/${projectId}/wiki`);
    ok(files.json.some((f) => f.filename === '_index.md'), 'wiki lists _index.md');
    const put = await api('PUT', `/projects/${projectId}/wiki/overview.md`, { content: '# Overview\nsmoke' });
    ok(put.status === 200, 'PUT wiki page');
    const get = await api('GET', `/projects/${projectId}/wiki/overview.md`);
    ok(get.json?.content?.includes('smoke'), 'GET wiki page');
  }

  // ── group chat ──────────────────────────────────────────────────────
  {
    const before = frames.length;
    const post = await api('POST', `/projects/${projectId}/groupchat`, { message: '@Alpha hello there' });
    ok(post.status === 201 && Array.isArray(post.json.skipped) && post.json.skipped.includes('Alpha'), 'groupchat @mention with stopped agent reports skipped');
    await waitFor(frames, (f) => f.type === 'groupchat:message' && f.payload?.role === 'user', 3000, 'groupchat ws', before);
    ok(true, 'groupchat:message broadcast');
    const list = await api('GET', `/projects/${projectId}/groupchat`);
    ok(Array.isArray(list.json?.messages) && list.json.messages.length >= 2, 'GET groupchat returns {messages}');
  }

  // ── plans ───────────────────────────────────────────────────────────
  {
    const bad = await api('POST', `/projects/${projectId}/plans`, { description: 'x' });
    ok(bad.status === 400, 'plan without fields → 400');
    const before = frames.length;
    const p = await api('POST', `/projects/${projectId}/plans`, { description: 'Ask Alpha to lint', targetAgent: 'Alpha', proposedMessage: 'run the linter' });
    ok(p.status === 201 && p.json?.id, 'POST plan');
    await waitFor(frames, (f) => f.type === 'plan:created' && f.plan?.id === p.json.id, 3000, 'plan:created', before);
    ok(true, 'plan:created broadcast');
    const list = await api('GET', `/projects/${projectId}/plans`);
    ok(list.json.some((x) => x.id === p.json.id), 'GET plans lists pending');
    const rej = await api('POST', `/projects/${projectId}/plans/${p.json.id}/resolve`, { decision: 'reject', reason: 'not now' });
    ok(rej.status === 200 && rej.json.success, 'reject plan');
    await waitFor(frames, (f) => f.type === 'plan:resolved' && f.planId === p.json.id, 3000, 'plan:resolved');
    ok(true, 'plan:resolved broadcast');
    const p2 = await api('POST', `/projects/${projectId}/plans`, { description: 'Approve path', targetAgent: 'Beta', proposedMessage: 'hello' });
    const appr = await api('POST', `/projects/${projectId}/plans/${p2.json.id}/resolve`, { decision: 'approve' });
    ok(appr.status === 200 && appr.json.delivered === false && appr.json.note, 'approve plan for stopped agent reports not delivered');
    const audit = fs.readFileSync(path.join(os.homedir(), '.conduit', 'projects', projectId, 'audit.jsonl'), 'utf-8');
    ok(audit.includes('plan_reject') && audit.includes('plan_approve'), 'audit log records decisions');
  }

  // ── gate resolve without a gate ─────────────────────────────────────
  {
    const r = await api('POST', `/projects/${projectId}/agents/${alpha.id}/gate/resolve`, { decision: 'approve' });
    ok(r.status === 409, 'gate resolve with no pending gate → 409');
  }

  // ── agent messaging (stopped recipient) ────────────────────────────
  {
    const m = await api('POST', `/projects/${projectId}/messages`, { fromAgentId: alpha.id, target: 'beta', message: 'ping' });
    ok(m.status === 200 && m.json.delivered === false && m.json.toAgentName === 'Beta', 'agent→agent message logged, not delivered when stopped');
    const act = await api('GET', `/activity?projectId=${projectId}`);
    ok(act.json.some((e) => e.event === 'agent:message'), 'activity feed has the message');
  }

  // ── live agent (real CLI) ───────────────────────────────────────────
  if (!SKIP_AGENT) {
    console.log(`\n  starting a real ${CLI} agent…`);
    ws.send(JSON.stringify({ type: 'terminal:attach', agentId: alpha.id }));
    const before = frames.length;
    const start = await api('POST', `/projects/${projectId}/agents/${alpha.id}/start`);
    ok(start.status === 200, `start ${CLI} agent`, JSON.stringify(start.json));
    if (start.status === 200) {
      await waitFor(frames, (f) => f.type === 'agent:status' && f.agentId === alpha.id && f.status !== 'stopped', 5000, 'agent:status running', before);
      ok(true, 'agent:status broadcast');
      const out = await waitFor(frames, (f) => f.type === 'terminal:output' && f.agentId === alpha.id, 15000, 'terminal output', before);
      ok(typeof out.data === 'string' && out.data.length > 0, 'terminal output streamed');
      const list = await api('GET', `/projects/${projectId}/agents`);
      ok(list.json.find((x) => x.id === alpha.id)?.status !== 'stopped', 'GET agents shows it alive');

      // Second viewer gets a private replay, not a duplicate for the first.
      const firstCount = frames.filter((f) => f.type === 'terminal:output').length;
      const v2 = await wsConnect();
      v2.ws.send(JSON.stringify({ type: 'terminal:attach', agentId: alpha.id }));
      const replay = await waitFor(v2.frames, (f) => f.type === 'terminal:output' && f.agentId === alpha.id, 8000, 'replay for second viewer');
      ok(replay.data.length > 0, 'second viewer receives scrollback replay');
      await sleep(500);
      v2.ws.close();

      // Type into it (safe: just a newline) and make sure input path works.
      ws.send(JSON.stringify({ type: 'terminal:input', agentId: alpha.id, data: '' }));
      ws.send(JSON.stringify({ type: 'terminal:resize', agentId: alpha.id, cols: 100, rows: 30 }));
      ok(true, 'input/resize accepted');

      const stop = await api('POST', `/projects/${projectId}/agents/${alpha.id}/stop`);
      ok(stop.status === 200 && stop.json.status === 'stopped', 'stop agent');
      await waitFor(frames, (f) => f.type === 'agent:status' && f.agentId === alpha.id && f.status === 'stopped', 8000, 'agent:status stopped');
      ok(true, 'agent:status stopped broadcast');
      const after = await api('GET', `/projects/${projectId}/agents`);
      ok(after.json.find((x) => x.id === alpha.id)?.status === 'stopped', 'GET agents shows stopped');
      ok(fs.existsSync(path.join(projCwd, CLI === 'claude' ? 'CLAUDE.md' : 'AGENTS.md')), 'instruction file written in cwd');
    }
    ws.send(JSON.stringify({ type: 'terminal:detach', agentId: alpha.id }));
  } else {
    console.log('  (live agent test skipped)');
  }

  // ── startup preflight ─────────────────────────────────────
  // Starting an agent whose CLI is absent must fail loudly with an install
  // hint, not open a live-looking terminal that printed "not recognized".
  //
  // There is no end-to-end approval-gate case here any more: raising one used
  // to depend on a missing CLI dropping the PTY into a plain shell, which the
  // preflight now (deliberately) prevents. `npm test` covers the gate patterns
  // directly and `npm run test:supervisor` covers the classifier live.
  const missing = pickMissingCli();
  if (!SKIP_AGENT && !missing) {
    console.log('\n  preflight: skipped — every agent CLI is installed on this machine.');
  }
  if (!SKIP_AGENT && missing) {
    console.log(`\n  preflight (cli=${missing.cli}, ${missing.bin} not installed)…`);
    const g = await api('POST', `/projects/${projectId}/agents`, { name: 'Preflight', cli: missing.cli });
    ok(g.status === 201, 'POST agent Preflight');
    const st = await api('POST', `/projects/${projectId}/agents/${g.json.id}/start`);
    ok(st.status >= 400, 'start is refused when the CLI is missing', `got ${st.status}`);
    const msg = String(st.json?.error || '');
    ok(msg.includes(missing.bin), 'error names the missing binary', msg);
    const after = await api('GET', `/projects/${projectId}/agents`);
    ok(after.json.find((x) => x.id === g.json.id)?.status === 'stopped', 'agent stays stopped');
  }

  ws.close();
} catch (err) {
  fail++;
  failures.push(String(err?.message || err));
  console.error('\n  ✗ aborted:', err);
} finally {
  if (projectId) {
    const del = await api('DELETE', `/projects/${projectId}?removeData=true`).catch(() => ({ status: 0 }));
    ok(del.status === 204, 'DELETE project (cleanup)');
    const list = await api('GET', '/projects').catch(() => ({ json: [] }));
    ok(!list.json.some((p) => p.id === projectId), 'project gone after delete');
    ok(!fs.existsSync(path.join(os.homedir(), '.conduit', 'shared_content', projName)), 'shared content removed');
  }
  try { fs.rmSync(projCwd, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${pass} passed, ${fail} failed${failures.length ? ':\n  - ' + failures.join('\n  - ') : ''}\n`);
  process.exit(fail ? 1 : 0);
}
