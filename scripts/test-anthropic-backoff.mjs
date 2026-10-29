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

const {
  calculateBackoffDelay,
  getConsecutiveFailures,
  resetBackoff,
  shouldThrottleDueToBackoff,
} = await import('../src/strands/anthropic.ts');

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\nAnthropic Fallback Exponential Backoff Tests\n');

// 1. Initial zero failure case
t(calculateBackoffDelay(0) === 0, 'zero failures returns zero delay');

// 2. Base delay (2000ms with jitter +/- 20%)
const d1 = calculateBackoffDelay(1, 2000, 60000, 0);
t(d1 === 2000, 'first failure returns exact base 2000ms when jitter is 0');

// 3. Exponential progression
const d2 = calculateBackoffDelay(2, 2000, 60000, 0);
t(d2 === 4000, 'second failure doubles to 4000ms');

const d3 = calculateBackoffDelay(3, 2000, 60000, 0);
t(d3 === 8000, 'third failure doubles to 8000ms');

const d4 = calculateBackoffDelay(4, 2000, 60000, 0);
t(d4 === 16000, 'fourth failure doubles to 16000ms');

// 4. Max clamp at 60s
const d10 = calculateBackoffDelay(10, 2000, 60000, 0);
t(d10 === 60000, 'high failure count is clamped at 60000ms');

// 5. Jitter bounded within factor
for (let i = 0; i < 10; i++) {
  const dj = calculateBackoffDelay(1, 2000, 60000, 0.2);
  t(dj >= 1600 && dj <= 2400, 'jitter remains within +/-20% envelope');
}

// 6. Reset backoff helper
resetBackoff();
t(getConsecutiveFailures() === 0, 'resetBackoff sets consecutiveFailures to 0');
t(shouldThrottleDueToBackoff().throttled === false, 'shouldThrottleDueToBackoff is false after reset');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
