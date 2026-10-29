#!/usr/bin/env node
// The Keeper's LocalHarness engine against the fake ACP agent: replies, tool
// rows, the one question it may answer (trusting its own brain dir), refusal
// of every other, cancel, and a session per conversation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const asTs = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(fileURLToPath(asTs))) return { url: asTs.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-keeper-lh-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { LocalHarnessKeeper } = await import('../src/daemon/keeper-localharness.ts');
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const brainDir = path.join(home, 'brain');
fs.mkdirSync(brainDir, { recursive: true });
let prepares = 0;
const keeper = new LocalHarnessKeeper({
  brainDir,
  mcp: { command: process.execPath, args: ['mcp.js'] },
  prepare: async () => { prepares++; return { binary: process.execPath, binaryArgs: [FAKE], shell: false }; },
});
const sink = () => {
  const msgs = [];
  return { msgs, append: (role, text, tool) => msgs.push({ role, text, tool }) };
};

console.log('\nKeeper on LocalHarness\n');

try {
  const a = sink();
  await keeper.runTurn('conv-1', 'echo:Two projects, both idle.', a);
  t(a.msgs.length === 1 && a.msgs[0].role === 'assistant' && a.msgs[0].text === 'Two projects, both idle.', 'a turn returns the assistant reply', JSON.stringify(a.msgs));

  const b = sink();
  await keeper.runTurn('conv-1', 'trustme', b);
  t(b.msgs[0]?.text === 'trusted:allow_always', 'it trusts its own brain directory', JSON.stringify(b.msgs));
  t(prepares === 1, 'the session is reused within a conversation');

  const c = sink();
  await keeper.runTurn('conv-1', 'write', c);
  t(c.msgs.some((m) => m.role === 'system' && /cancelled/.test(m.text)), 'any other permission request is refused', JSON.stringify(c.msgs));

  const d = sink();
  const slow = keeper.runTurn('conv-1', 'slow', d);
  await new Promise((r) => setTimeout(r, 200));
  t(keeper.abort(), 'abort cancels a running turn');
  await slow;
  t(d.msgs.some((m) => /cancelled/.test(m.text)), 'and the turn says it was cancelled');

  const e = sink();
  await keeper.runTurn('conv-2', 'echo:fresh', e);
  t(prepares === 2 && e.msgs[0]?.text === 'fresh', 'a new conversation gets a new session');

  const failing = new LocalHarnessKeeper({
    brainDir, mcp: { command: 'x', args: [] },
    prepare: async () => { throw new Error('No local model server at http://127.0.0.1:11434/v1'); },
  });
  const f = sink();
  await failing.runTurn('conv-x', 'hello', f);
  t(f.msgs[0]?.role === 'error' && /could not start on LocalHarness: No local model server/.test(f.msgs[0].text), 'a server that is down is one error message', JSON.stringify(f.msgs));
} finally {
  keeper.stop();
  await new Promise((r) => setTimeout(r, 400));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
