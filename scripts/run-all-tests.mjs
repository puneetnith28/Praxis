#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptsDir = path.resolve('scripts');
const testFiles = fs.readdirSync(scriptsDir)
  .filter(f => f.startsWith('test-') && f.endsWith('.mjs'))
  .sort();

console.log(`Discovered ${testFiles.length} test suites.`);
let passed = 0;
for (const f of testFiles) {
  const p = path.join(scriptsDir, f);
  const res = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', p], { stdio: 'inherit' });
  if (res.status === 0) {
    passed++;
  } else {
    console.error(`FAILED: ${f}`);
    process.exit(res.status || 1);
  }
}
console.log(`\nAll ${passed}/${testFiles.length} test suites passed!`);
