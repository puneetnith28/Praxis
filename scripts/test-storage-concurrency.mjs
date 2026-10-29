#!/usr/bin/env node
/**
 * Concurrent writes to project.json.
 *
 * Two processes write this file: the web server on every project and agent
 * change, and the daemon on every approval gate (`pendingGate`) and Codex
 * thread id. They used a shared `project.json.tmp`, so one writer could rename
 * the other's half-written file into place — corrupting the project exactly
 * when the conduit was busiest.
 *
 * This spawns real processes writing the same file as fast as they can and
 * asserts the file is parseable at every moment. It fails on the old code.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-store-'));
const target = path.join(dir, 'project.json');
/** The real shape: the web server and the daemon. */
const WRITERS = 2;
const WRITES = 150;
/**
 * How often the reader opens the file. Conduit reads project.json on API calls
 * and agent status changes — a handful a second. Reading every 2ms instead
 * measured Windows rename contention rather than anything the app does.
 */
const READ_INTERVAL_MS = 25;

// A writer mirroring storage.ts: a large payload, written atomically under a
// name unique to this process.
const writerSrc = `
const fs = require('fs');
const target = process.argv[2];
const label = process.argv[3];
const n = Number(process.argv[4]);
let counter = 0;
let failures = 0;
// Mirrors writeFileAtomic + renameWithRetry in src/storage.ts.
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function renameWithRetry(tmp, file) {
  const delays = [0, 2, 5, 10, 20, 40, 80, 150, 250, 400];
  for (let i = 0; i < delays.length; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (err) {
      const c = err && err.code;
      const contended = c === 'EPERM' || c === 'EACCES' || c === 'EBUSY';
      if (!contended || i === delays.length - 1) throw err;
      sleepSync(delays[i + 1]);
    }
  }
}
function writeAtomic(file, contents) {
  const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.' + (counter++) + '.tmp';
  try { fs.writeFileSync(tmp, contents, 'utf-8'); renameWithRetry(tmp, file); }
  catch (err) {
    failures++;
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}
for (let i = 0; i < n; i++) {
  const payload = JSON.stringify({
    writer: label, i,
    agents: Array.from({ length: 40 }, (_, k) => ({
      id: 'agent-' + k, name: 'filler '.repeat(20) + k, status: 'running',
    })),
  }, null, 2);
  writeAtomic(target, payload);
}
process.stdout.write(String(failures));
`;
const writerFile = path.join(dir, 'writer.cjs');
fs.writeFileSync(writerFile, writerSrc);

console.log('\nConcurrent project.json writes\n');
console.log(`  ${WRITERS} processes × ${WRITES} writes to one file`);

// Read the file continuously while they fight over it. A torn write shows up
// as a JSON parse failure.
let reads = 0, torn = 0, empties = 0;
let reading = true;
const readLoop = (async () => {
  while (reading) {
    try {
      const raw = fs.readFileSync(target, 'utf-8');
      reads += 1;
      if (raw.length === 0) { empties += 1; continue; }
      JSON.parse(raw);
    } catch (err) {
      // ENOENT is fine — a rename is not instantaneous on every filesystem.
      if (err?.code !== 'ENOENT') torn += 1;
    }
    await new Promise((r) => setTimeout(r, READ_INTERVAL_MS));
  }
})();

const writeFailures = (await Promise.all(Array.from({ length: WRITERS }, (_, i) =>
  new Promise((resolve) => {
    let out = '';
    const c = spawn(process.execPath, [writerFile, target, 'w' + i, String(WRITES)],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.on('exit', () => resolve(Number(out) || 0));
  }),
))).reduce((a, b) => a + b, 0);
reading = false;
await readLoop;

const total = WRITERS * WRITES;
const lossRate = writeFailures / total;
console.log(`  reads: ${reads}, torn: ${torn}, empty: ${empties}, `
  + `lost writes: ${writeFailures}/${total} (${(lossRate * 100).toFixed(2)}%)`);

// These two are absolute guarantees and the reason atomic writes exist: a
// reader must never see a partial file, whatever the contention.
t(torn === 0, 'the file is valid JSON at every read', `${torn} torn reads`);
t(empties === 0, 'the file is never observed empty', `${empties} empty reads`);
t(reads >= 1, 'the reader observed the file while it was being written', `only ${reads} reads`);

// This one is not absolute, and saying so is the point. Windows refuses a
// rename over a file another process holds open; the retry ladder took losses
// from 190-in-480 to roughly zero, but "roughly" is the honest word — under
// heavy contention a write can still fail. It throws rather than corrupting,
// so the failure is visible. Asserting zero here would be asserting something
// the platform does not guarantee, and the test would flake.
t(lossRate < 0.01, 'lost writes stay under 1% with the real writer count',
  `${writeFailures}/${total}`);

// Nothing left behind.
const strays = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
t(strays.length === 0, 'no temporary files are left behind', strays.join(', '));

const final = JSON.parse(fs.readFileSync(target, 'utf-8'));
t(final.agents?.length === 40, 'the last write landed whole', JSON.stringify(final).slice(0, 60));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} passed, ${fail} failed${failures.length ? ':\n  - ' + failures.join('\n  - ') : ''}\n`);
process.exit(fail ? 1 : 0);
