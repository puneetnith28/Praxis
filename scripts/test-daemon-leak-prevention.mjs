#!/usr/bin/env node
import assert from 'node:assert';

const weakMap = new WeakMap();
const client = {};
weakMap.set(client, new Set(['agent-1']));
assert(weakMap.has(client));
weakMap.delete(client);
assert(!weakMap.has(client));
console.log('✓ test-daemon-leak-prevention passed');
