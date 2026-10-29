#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureDir,
  sleepSync,
  renameWithRetry,
  writeFileAtomic,
  writeJsonAtomic,
  readJsonSync,
  appendJsonlSync,
  safeProjectName,
  resolveInside,
} from '../src/storage-fs.ts';

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\nStorage Filesystem & Atomic Helpers\n');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-storage-fs-'));

try {
  // 1. safeProjectName
  t(safeProjectName('hello-world') === 'hello-world', 'preserves valid names');
  t(safeProjectName('../../../escaping') === 'escaping', 'strips parent traversal dots');
  t(safeProjectName('foo/bar\\baz:test') === 'foobarbaztest', 'strips separators and invalid path chars');
  t(safeProjectName('') === 'project', 'falls back to project on empty input');
  t(safeProjectName('...:::') === 'project', 'falls back when all chars stripped');

  // 2. resolveInside
  const base = path.join(testDir, 'sandbox');
  ensureDir(base);
  t(resolveInside(base, 'safe.txt') === path.join(base, 'safe.txt'), 'resolves normal relative paths');
  t(resolveInside(base, 'sub/dir/safe.txt') === path.join(base, 'sub', 'dir', 'safe.txt'), 'resolves safe nested subpaths');
  t(resolveInside(base, '../escape.txt') === null, 'rejects path traversal escaping root');
  t(resolveInside(base, '/etc/passwd') === null, 'rejects absolute unix paths');
  t(resolveInside(base, 'C:\\windows\\system32') === null, 'rejects windows volume paths');
  t(resolveInside(base, 'null\0byte.txt') === null, 'rejects null byte poison attacks');
  t(resolveInside(base, '') === null, 'rejects empty rel string');

  // 3. writeFileAtomic & readJsonSync
  const jsonTarget = path.join(testDir, 'data.json');
  writeJsonAtomic(jsonTarget, { status: 'active', count: 42 });
  t(fs.existsSync(jsonTarget), 'writeJsonAtomic creates destination file');
  const parsed = readJsonSync(jsonTarget);
  t(parsed && parsed.status === 'active' && parsed.count === 42, 'readJsonSync correctly parses written JSON');

  // 4. appendJsonlSync
  const jsonlTarget = path.join(testDir, 'entries.jsonl');
  appendJsonlSync(jsonlTarget, { id: 1, msg: 'first' });
  appendJsonlSync(jsonlTarget, { id: 2, msg: 'second' });
  const lines = fs.readFileSync(jsonlTarget, 'utf-8').trim().split('\n');
  t(lines.length === 2, 'appendJsonlSync appends multiple lines');
  const parsed1 = JSON.parse(lines[0]);
  const parsed2 = JSON.parse(lines[1]);
  t(parsed1.id === 1 && parsed2.id === 2, 'JSONL lines parse accurately');

  // 5. sleepSync
  const t0 = Date.now();
  sleepSync(30);
  const elapsed = Date.now() - t0;
  t(elapsed >= 25, 'sleepSync blocks thread for expected duration');

} finally {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
