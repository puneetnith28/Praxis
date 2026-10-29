#!/usr/bin/env node
/**
 * When should the Supervisor give up on Bedrock and use Anthropic instead?
 *
 * This got the wrong answer in production. The check asked only "is this a
 * credential error", so when every Bedrock model id on the account went
 * end-of-life, classification threw on every batch — forever, with a working
 * Anthropic credential sitting unused beside it. The daemon log filled with
 *
 *   [watcher] classification failed for Claude: This model version has
 *   reached the end of its life.
 *
 * and the Supervisor, which is the thing that raises approval gates, quietly
 * stopped supervising. Nothing in the UI said so.
 *
 * The strings below are real: every one was copied from an actual Bedrock
 * response on this account, not invented.
 */
import {
  isCredentialError, isModelUnavailable, isRateCapped, shouldFallBack,
} from '../src/strands/failure.ts';

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\nSupervisor failure handling\n');

// ── the failure that actually happened ────────────────────────────────
const EOL = 'This model version has reached the end of its life. Please refer to the AWS documentation for more details.';
t(shouldFallBack(EOL), 'a retired model falls back to Anthropic — the bug that started this');
t(isModelUnavailable(EOL), 'and is recognised as the model being unavailable');
t(!isCredentialError(EOL), 'and is NOT reported as a credential problem, which sent people to check valid keys');

// ── the other two walls on this account ───────────────────────────────
const DENIED = 'User: arn:aws:iam::242736648021:user/conduit-local is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0';
t(shouldFallBack(DENIED), 'an inference profile the IAM policy forbids falls back');
t(isCredentialError(DENIED), 'and reads as a credential/authorisation problem');

const CAPPED = 'Too many tokens per day, please wait before trying again.';
t(shouldFallBack(CAPPED), 'a daily token cap falls back rather than going silent');
t(isRateCapped(CAPPED), 'and is recognised as a rate cap');

// ── the classes that were already handled ─────────────────────────────
for (const [msg, label] of [
  ['The security token included in the request is invalid.', 'an invalid security token'],
  ['ExpiredTokenException: The security token included in the request is expired', 'an expired token'],
  ['Could not load credentials from any providers', 'missing credentials'],
  ['getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com', 'DNS failure'],
  ['connect ECONNREFUSED 127.0.0.1:443', 'a refused connection'],
  ['Region is missing', 'no region configured'],
  ['UnrecognizedClientException: The security token included in the request is invalid', 'an unrecognised client'],
]) {
  t(shouldFallBack(msg), `${label} falls back`);
}

for (const [msg, label] of [
  ['ThrottlingException: Rate exceeded', 'throttling'],
  ['TooManyRequestsException', 'too many requests'],
  ['ServiceQuotaExceededException', 'an exceeded quota'],
]) {
  t(shouldFallBack(msg), `${label} falls back`);
}

for (const [msg, label] of [
  ['ResourceNotFoundException: model not found', 'a missing model'],
  ['ModelNotReadyException', 'a model that is not ready'],
  ['The provided model identifier could not be found', 'an unknown model identifier'],
]) {
  t(shouldFallBack(msg), `${label} falls back`);
  t(isModelUnavailable(msg), `and ${label} reads as a model problem`);
}

// ── what must NOT trigger a fallback ──────────────────────────────────
//
// Falling back on a bug in our own prompt or parsing would hide it behind a
// second provider and double the bill for the same wrong answer.
for (const [msg, label] of [
  ['Unexpected token < in JSON at position 0', 'a parse error in our own handling'],
  ['tool report_update failed: missing field "summary"', 'a tool-shaped bug of ours'],
  ['Maximum call stack size exceeded', 'a stack overflow in our code'],
  ['Input is too long for requested model', 'a prompt we built too long'],
  ['', 'an empty message'],
]) {
  t(!shouldFallBack(msg), `${label} does NOT fall back`);
}

// ── the three tests stay distinct ─────────────────────────────────────
// They pick different advice for the user. Collapsing them is how the wrong
// hint got printed for two years' worth of a different problem.
t(!isCredentialError(EOL) && !isRateCapped(EOL),
  'a retired model is only ever a model problem');
t(!isModelUnavailable(CAPPED) && !isCredentialError(CAPPED),
  'a rate cap is only ever a rate cap');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('the Supervisor falls back whenever Bedrock cannot serve it\n');
