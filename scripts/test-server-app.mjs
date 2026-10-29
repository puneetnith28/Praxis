#!/usr/bin/env node
import fs from 'node:fs';
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

const { createServerApp, sttErrorStatus } = await import('../src/server-app.ts');

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\nServer App & Route Decoupling Tests\n');

// 1. sttErrorStatus helper mapping
t(sttErrorStatus('STT 400 Bad Request') === 400, 'maps 400 upstream status');
t(sttErrorStatus('STT 429 Rate Limit') === 429, 'maps 429 rate limit status');
t(sttErrorStatus('STT 415 Unsupported Media Type') === 400, 'maps 415 to 400 client error');
t(sttErrorStatus('API key not set for openai') === 503, 'maps missing API key to 503 service unavailable');
t(sttErrorStatus('Payload accepts up to 25MB') === 413, 'maps oversized payload to 413');
t(sttErrorStatus('STT 500 Internal error') === 502, 'maps 500 upstream error to 502 bad gateway');
t(sttErrorStatus('Unknown random failure') === 500, 'defaults to 500 on unexpected errors');

// 2. createServerApp instantiation
const mockDaemon = {
  isConnected: () => true,
  request: async () => ({ ok: true }),
  command: () => {},
};
const mockBroadcast = () => {};

const app = createServerApp(mockDaemon, mockBroadcast);
t(typeof app === 'function', 'createServerApp returns an Express request listener');
t(typeof app.listen === 'function', 'app exposes listen interface');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
