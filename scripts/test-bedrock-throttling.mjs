#!/usr/bin/env node
import assert from 'node:assert';

function isThrottlingError(err) {
  return err.name === 'ThrottlingException' || err.status === 429 || err.code === 'TooManyRequestsException';
}

assert(isThrottlingError({ name: 'ThrottlingException' }));
assert(isThrottlingError({ status: 429 }));
console.log('✓ test-bedrock-throttling passed');
