#!/usr/bin/env node
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const asTs = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(fileURLToPath(asTs))) return { url: asTs.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { killProcessTree, escalateProcessKill } = await import('../src/pty-manager.ts');

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\nProcess Tree Cleanup Tests\n');

// 1. Safe handling of invalid / non-positive PIDs
try {
  killProcessTree(0);
  killProcessTree(-1);
  killProcessTree(9999999);
  escalateProcessKill(0);
  t(true, 'killProcessTree and escalate safely ignore invalid or non-existent PIDs');
} catch (err) {
  t(false, 'killProcessTree and escalate safely ignore invalid or non-existent PIDs', String(err));
}

// 2. Real process tree spawning and group termination
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: process.platform !== 'win32',
  stdio: 'ignore',
});

const pid = child.pid;
t(typeof pid === 'number' && pid > 0, 'child process spawned with valid PID');

// Verify child is alive
let isAlive = false;
try {
  process.kill(pid, 0);
  isAlive = true;
} catch {}
t(isAlive, 'child process is running before termination');

// Terminate with killProcessTree
killProcessTree(pid, 'SIGTERM');

// Poll rather than sleep a fixed time: on Windows the kill is an asynchronous
// `taskkill /t /f`, which measured ~450-520ms here — past the 200ms this used
// to wait, so the check failed although the process did die.
let isDead = false;
for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err && err.code === 'ESRCH') { isDead = true; break; }
  }
  await new Promise((r) => setTimeout(r, 25));
}
t(isDead, 'killProcessTree successfully terminates the target process tree');
if (!isDead) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }

// 3. Escalating kill on process ignoring SIGTERM
if (process.platform !== 'win32') {
  const stubborn = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: 'ignore',
  });
  const stubbornPid = stubborn.pid;
  // Give child time to boot and register SIGTERM listener
  await new Promise((r) => setTimeout(r, 200));

  try {
    killProcessTree(stubbornPid, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    let stubbornAlive = false;
    try {
      process.kill(stubbornPid, 0);
      stubbornAlive = true;
    } catch {}
    t(stubbornAlive, 'stubborn process survives initial SIGTERM');

    // Escalate to SIGKILL with 100ms timer
    escalateProcessKill(stubbornPid, 100);
    await new Promise((r) => setTimeout(r, 250));

    let stubbornDead = false;
    try {
      process.kill(stubbornPid, 0);
    } catch (err) {
      if (err && err.code === 'ESRCH') stubbornDead = true;
    }
    t(stubbornDead, 'escalateProcessKill forcibly terminates stubborn process via SIGKILL');
  } finally {
    try { process.kill(stubbornPid, 'SIGKILL'); } catch {}
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
