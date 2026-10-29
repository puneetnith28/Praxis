#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDefaultWindowState,
  validateBounds,
  loadWindowState,
  saveWindowState,
} from '../electron/window-state.ts';

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\nElectron Window State Management Tests\n');

// 1. Default window state
const def = getDefaultWindowState();
t(def.width === 1280 && def.height === 860, 'provides sensible default window dimensions');

// 2. Validate bounds on single display
const singleDisplay = [
  { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
];

const validState = validateBounds({ width: 1400, height: 900, x: 100, y: 100 }, singleDisplay);
t(validState.width === 1400 && validState.height === 900 && validState.x === 100 && validState.y === 100,
  'preserves valid coordinates inside primary display');

// 3. Multi-monitor setups
const dualDisplays = [
  { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
];

const secondaryState = validateBounds({ width: 1280, height: 860, x: 2000, y: 100 }, dualDisplays);
t(secondaryState.x === 2000 && secondaryState.y === 100,
  'preserves coordinates on connected secondary monitor');

// 4. Disconnected monitor (off-screen coordinates)
const disconnectedState = validateBounds({ width: 1280, height: 860, x: 2500, y: 100 }, singleDisplay);
t(disconnectedState.x === undefined && disconnectedState.y === undefined,
  'clears x,y coordinates when saved position is outside all active displays');

// 5. Min bounds enforcement
const smallState = validateBounds({ width: 400, height: 300 }, singleDisplay);
t(smallState.width >= 900 && smallState.height >= 600,
  'enforces minimum width and height limits');

// 6. Persistence: save and load
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-window-state-'));
const testFile = path.join(tmpDir, 'state.json');

try {
  saveWindowState({ width: 1600, height: 1000, x: 50, y: 50, isMaximized: true }, testFile);
  t(fs.existsSync(testFile), 'saveWindowState writes file to disk');

  const loaded = loadWindowState(testFile);
  t(loaded.width === 1600 && loaded.height === 1000 && loaded.x === 50 && loaded.isMaximized === true,
    'loadWindowState restores saved geometry and maximized state');

  // Corrupted file fallback
  fs.writeFileSync(testFile, 'NOT_JSON{{{', 'utf-8');
  const fallback = loadWindowState(testFile);
  t(fallback.width === 1280 && fallback.height === 860,
    'loadWindowState recovers cleanly from corrupted JSON config');
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
