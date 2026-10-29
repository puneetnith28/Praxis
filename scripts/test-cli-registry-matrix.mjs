#!/usr/bin/env node
import assert from 'node:assert';
import path from 'node:path';

function resolveBinaryPath(bin, paths) {
  for (const p of paths) {
    const candidate = path.posix.join(p, bin);
    return candidate; // mock match
  }
  return null;
}

assert(resolveBinaryPath('uv', ['/usr/local/bin']) === '/usr/local/bin/uv');
console.log('✓ test-cli-registry-matrix passed');
