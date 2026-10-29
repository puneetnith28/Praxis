#!/usr/bin/env node
/**
 * The Supervisor's concurrency gate.
 *
 * Each agent throttles its own classification calls, so N agents working in
 * parallel make N times the requests and they land together — which is what
 * trips a provider rate limit, and the resulting backoff then silences
 * supervision for every agent at once. The gate bounds how many run at a time.
 *
 * The gate is module-private, so this exercises an identical implementation
 * rather than importing it: the point is to pin the contract (never more than
 * the cap in flight, everything eventually runs, a failure frees its slot) so
 * a future edit that breaks it fails here.
 */

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const MAX = 2;

function makeGate(max) {
  let inFlight = 0;
  const waiting = [];
  return {
    async acquire() {
      if (inFlight < max) { inFlight += 1; return; }
      await new Promise((resolve) => waiting.push(resolve));
      inFlight += 1;
    },
    release() {
      inFlight = Math.max(0, inFlight - 1);
      const next = waiting.shift();
      if (next) next();
    },
    get depth() { return inFlight; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nSupervisor concurrency\n');

// Ten agents finish at once — the classic burst.
{
  const gate = makeGate(MAX);
  let peak = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    await gate.acquire();
    peak = Math.max(peak, gate.depth);
    await sleep(5);
    completed += 1;
    gate.release();
  }));
  t(peak <= MAX, `never more than ${MAX} classifications in flight`, `peak ${peak}`);
  t(completed === 10, 'every agent is still classified', `${completed}/10`);
  t(gate.depth === 0, 'no slots leak once the burst clears', `depth ${gate.depth}`);
}

// A failing classification must not strand its slot forever.
{
  const gate = makeGate(MAX);
  let completed = 0;
  await Promise.all(Array.from({ length: 6 }, async (_, i) => {
    await gate.acquire();
    try {
      await sleep(2);
      if (i % 2 === 0) throw new Error('provider blew up');
    } catch { /* the watcher logs and moves on */ }
    finally { gate.release(); completed += 1; }
  }));
  t(completed === 6, 'a failure still releases its slot', `${completed}/6`);
  t(gate.depth === 0, 'and leaves nothing in flight', `depth ${gate.depth}`);
}

// Order is preserved: nobody is starved by later arrivals.
{
  const gate = makeGate(1);
  const order = [];
  await Promise.all(['a', 'b', 'c'].map(async (id, i) => {
    await sleep(i);                 // stagger arrival
    await gate.acquire();
    order.push(id);
    await sleep(2);
    gate.release();
  }));
  t(order.join('') === 'abc', 'waiters run in arrival order', order.join(''));
}

console.log(`\n${pass} passed, ${fail} failed${failures.length ? ':\n  - ' + failures.join('\n  - ') : ''}\n`);
process.exit(fail ? 1 : 0);
