#!/usr/bin/env node
/**
 * The daemon's `/org/*` API — the Keeper's hands.
 *
 * Every tool the orchestrator has, and every tool the live voice Keeper has,
 * reaches the conduit through these ten endpoints. They are not part of the
 * REST API the browser uses, so `check-ui.mjs` never touches them, and until
 * now six of the ten were exercised by nothing at all: `wiki`, `shared`,
 * `broadcast`, `inject`, `create-project` and `create-agent`.
 *
 * That is a bad gap to have. If `/org/create-project` breaks, the Keeper
 * quietly loses the ability to create projects and everything else still
 * looks fine — the failure surfaces as the Keeper saying it could not, which
 * reads like the model being unhelpful rather than like a bug.
 *
 * Loopback only, unauthenticated by design (documented in the README). This
 * talks to it the same way the MCP server does.
 *
 * Usage: node scripts/check-org.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAEMON = process.env.CONDUIT_DAEMON_URL || 'http://127.0.0.1:3210';

let failures = 0;
const problems = [];
function t(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) { failures++; problems.push(`${label}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Safe for printing anything, including undefined — which .slice() is not. */
const show = (v, n = 120) => String(JSON.stringify(v) ?? String(v)).slice(0, n);

async function org(method, p, body, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(DAEMON + p, {
      method,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { /* not json */ }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

const up = await org('GET', '/org/snapshot');
if (up.status !== 200) {
  console.error(`The daemon is not answering on ${DAEMON} — start it with \`npm run start:all\`.`);
  process.exit(2);
}

console.log(`\nDaemon org API — ${DAEMON}\n`);

const name = 'orgcheck-' + Date.now().toString(36);
const cwd = path.join(os.tmpdir(), name);
fs.mkdirSync(cwd, { recursive: true });

// ── create-project ────────────────────────────────────────────────────
{
  const r = await org('POST', '/org/create-project', { name, cwd, description: 'org API audit' });
  t(r.status === 200 && r.json?.ok === true && !!r.json?.projectId,
    'create-project makes a project', show(r.json));

  const dup = await org('POST', '/org/create-project', { name, cwd });
  t(dup.json?.ok === false, 'and a duplicate name is refused, not silently merged',
    show(dup.json));

  const bad = await org('POST', '/org/create-project', { name: '', cwd: '' });
  t(bad.json?.ok === false, 'and a nameless project is refused',
    show(bad.json));
}

const snapshot = await org('GET', '/org/snapshot');
const project = (snapshot.json?.projects || []).find((p) => p.name === name);
if (!project) {
  console.error('the project did not appear in the snapshot — cannot continue');
  process.exit(1);
}
t(true, 'snapshot shows it');

// ── create-agent ──────────────────────────────────────────────────────
{
  const r = await org('POST', '/org/create-agent', {
    project: name, name: 'Alpha', cli: 'claude', role: 'lead',
  });
  t(r.status === 200 && r.json?.ok === true, 'create-agent adds an agent',
    show(r.json));

  const bad = await org('POST', '/org/create-agent', {
    project: name, name: 'Beta', cli: 'not-a-real-cli',
  });
  t(bad.json?.ok === false, 'and an unknown CLI is refused',
    show(bad.json));

  const noProject = await org('POST', '/org/create-agent', {
    project: 'no-such-project-anywhere', name: 'Gamma', cli: 'claude',
  });
  t(noProject.json?.ok === false, 'and an agent for a project that does not exist is refused',
    show(noProject.json));
}

const after = await org('GET', '/org/snapshot');
const proj = (after.json?.projects || []).find((p) => p.name === name);
const agent = (proj?.agents || []).find((a) => a.name === 'Alpha');
t(!!agent, 'the new agent is in the snapshot with a status',
  show(proj?.agents || []));
t(agent?.status === 'stopped', 'and it starts out stopped', String(agent?.status));

// ── wiki ──────────────────────────────────────────────────────────────
{
  const r = await org('GET', `/org/wiki?project=${encodeURIComponent(name)}`);
  t(r.status === 200 && r.json && typeof r.json === 'object',
    'wiki answers for a real project', show(r.json, 100));

  const ov = await org('GET', `/org/wiki?project=${encodeURIComponent(name)}&overview=1`);
  t(ov.status === 200 && ov.json && typeof ov.json === 'object',
    'wiki overview=1 answers too', show(ov.json, 100));

  const none = await org('GET', '/org/wiki');
  t(none.status === 400, 'and wiki without a project is a 400, not a crash', String(none.status));

  const missing = await org('GET', '/org/wiki?project=no-such-project-anywhere');
  t(missing.status === 200 && missing.json,
    'a wiki for a project that does not exist answers rather than throwing',
    show(missing.json, 100));
}

// ── shared ────────────────────────────────────────────────────────────
{
  const r = await org('GET', `/org/shared?project=${encodeURIComponent(name)}`);
  t(r.status === 200 && r.json, 'shared answers for a real project',
    show(r.json, 100));

  const none = await org('GET', '/org/shared');
  t(none.status === 400, 'and shared without a project is a 400', String(none.status));

  // Path traversal through a query parameter is the obvious way in here.
  const escape = await org('GET',
    `/org/shared?project=${encodeURIComponent(name)}&file=${encodeURIComponent('../../../../.env')}`);
  const body = JSON.stringify(escape.json || '');
  t(escape.status === 200 && !/AWS_SECRET|API_KEY=/i.test(body),
    'and a file outside the project cannot be read through it',
    body.slice(0, 120));
}

// ── inject ────────────────────────────────────────────────────────────
{
  const stopped = await org('POST', '/org/inject', {
    project: name, agent: 'Alpha', message: 'hello', fromName: 'audit',
  });
  t(stopped.json?.ok === false || stopped.json?.status === 'not-running',
    'injecting into a stopped agent says so rather than pretending',
    show(stopped.json));

  const empty = await org('POST', '/org/inject', { project: name, agent: 'Alpha', message: '' });
  t(empty.status === 400, 'and an empty message is a 400', String(empty.status));

  const nobody = await org('POST', '/org/inject', {
    project: name, agent: 'NoSuchAgent', message: 'hello',
  });
  t(nobody.json?.ok === false, 'and an agent that does not exist is refused',
    show(nobody.json));
}

// ── broadcast ─────────────────────────────────────────────────────────
//
// Deliberately not broadcast to a *running* agent: that waits on a real model
// and is bounded only by the 5-minute TURN_TIMEOUT_MS, so it would measure
// Claude's response time rather than this endpoint. The contract is what
// matters here — validation, project scoping, and telling a skipped agent
// apart from a missing one.
{
  const empty = await org('POST', '/org/broadcast', { message: '' });
  t(empty.status === 400, 'broadcast with no message is a 400', String(empty.status));

  const nowhere = await org('POST', '/org/broadcast', {
    message: 'hello', project: 'no-such-project-anywhere',
  });
  t(nowhere.json?.ok === false, 'broadcast to a project that does not exist is refused',
    show(nowhere.json));

  // Scoped to this project, whose agent is stopped — so it answers at once
  // and has to account for the agent it could not reach.
  const r = await org('POST', '/org/broadcast', { message: 'ping', project: name }, 30_000);
  t(r.status === 200 && Array.isArray(r.json?.replies),
    'broadcast answers with a replies array', r.error || show(r.json, 160));
  t(Array.isArray(r.json?.skipped) && r.json.skipped.length === 1,
    'and lists the stopped agent as skipped rather than silently dropping it',
    r.error || show(r.json?.skipped));
  t(r.json?.skipped?.[0]?.reason === 'not running',
    'with the reason it was skipped', show(r.json?.skipped?.[0]));
}

// ── start-agent / stop-agent ──────────────────────────────────────────
{
  const started = await org('POST', '/org/start-agent', { project: name, agent: 'Alpha' }, 30_000);
  t(started.json?.status === 'started' || started.json?.status === 'already-running',
    'start-agent starts it', show(started.json));

  await sleep(4000);
  const again = await org('POST', '/org/start-agent', { project: name, agent: 'Alpha' }, 30_000);
  t(again.json?.status === 'already-running',
    'and starting it twice says already-running rather than spawning a second',
    show(again.json));

  const missing = await org('POST', '/org/start-agent', { project: name, agent: 'Nope' });
  t(missing.json?.status === 'not-found', 'an agent that does not exist is not-found',
    show(missing.json));
}

// ── ask-agent ─────────────────────────────────────────────────────────
{
  const missing = await org('POST', '/org/ask-agent', {
    project: name, agent: 'Nope', message: 'hello',
  }, 30_000);
  t(missing.json?.status === 'not-found' || missing.json?.ok === false,
    'ask-agent on a missing agent is not-found',
    show(missing.json));

  const empty = await org('POST', '/org/ask-agent', { project: name, agent: 'Alpha', message: '' });
  t(empty.status === 400 || empty.json?.ok === false,
    'and an empty message is refused', show(empty.json));
}

// ── stop-agent ────────────────────────────────────────────────────────
{
  const r = await org('POST', '/org/stop-agent', { project: name, agent: 'Alpha' }, 30_000);
  t(r.json?.status === 'stopped' || r.json?.status === 'already-stopped',
    'stop-agent stops it', show(r.json));

  const again = await org('POST', '/org/stop-agent', { project: name, agent: 'Alpha' }, 30_000);
  t(again.json?.status === 'already-stopped',
    'and stopping it twice says already-stopped',
    show(again.json));
}

// ── malformed input must not take the daemon down ─────────────────────
{
  for (const [p, body] of [
    ['/org/create-project', '{'],
    ['/org/create-agent', 'null'],
    ['/org/broadcast', '[]'],
    ['/org/inject', '"a string"'],
    ['/org/ask-agent', '{"project":{"toString":1}}'],
  ]) {
    const res = await fetch(DAEMON + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }).catch((e) => ({ status: 0, err: String(e) }));
    t(res.status >= 400 && res.status < 500,
      `malformed body to ${p} is a 4xx, not a 5xx`, String(res.status));
  }
  const alive = await org('GET', '/org/snapshot');
  t(alive.status === 200, 'and the daemon is still up afterwards');
}

// ── cleanup, through the web API which owns deletion ──────────────────
{
  const WEB = process.env.CONDUIT_URL || 'http://localhost:3200';
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.CONDUIT_AUTH) {
    headers.Authorization = 'Basic ' + Buffer.from(process.env.CONDUIT_AUTH).toString('base64');
  }
  await fetch(`${WEB}/api/projects/${project.id}?removeData=true`, { method: 'DELETE', headers })
    .catch(() => {});
  const gone = await org('GET', '/org/snapshot');
  t(!(gone.json?.projects || []).some((p) => p.name === name),
    'the fixture is gone from the snapshot afterwards');
}

console.log(failures === 0
  ? '\nevery org endpoint the Keeper uses behaves\n'
  : `\n${failures} problem(s):\n${problems.map((p) => '  - ' + p).join('\n')}\n`);
process.exit(failures === 0 ? 0 : 1);
