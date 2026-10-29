#!/usr/bin/env node
/**
 * Live check of the Supervisor's Anthropic path (npm run test:supervisor).
 *
 * Makes real Messages API calls using ANTHROPIC_API_KEY, or the Claude Code
 * OAuth token in ~/.claude/.credentials.json. Skips cleanly when neither is
 * present. Costs a few cents at most.
 */
import {
  classifyWithAnthropic,
  hasAnthropicCredential,
  currentModel,
  resetModelSelection,
  AnthropicSupervisorError,
} from '../src/strands/anthropic.ts';

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

if (!hasAnthropicCredential()) {
  console.log('\nNo Anthropic credential (ANTHROPIC_API_KEY or Claude Code login) — skipping.\n');
  process.exit(0);
}

console.log('\nSupervisor · Anthropic path\n');

// 1. A benign batch should classify without throwing.
try {
  const r = await classifyWithAnthropic(
    'Agent: Builder on project "demo".\n\nClassify the terminal output below and call report_update exactly once.\n\nTerminal output:\n$ npm test\n\n19 passed, 0 failed',
  );
  ok(!!r && typeof r.summary === 'string' && r.summary.length > 0, 'classifies a passing test run', JSON.stringify(r));
  ok(['progress', 'blocker', 'question', 'risky_action', 'noise'].includes(r.classification),
    `classification is in the enum (${r?.classification})`);
  console.log(`      model: ${currentModel()}`);
  console.log(`      -> [${r.classification}] ${r.summary}`);
} catch (err) {
  ok(false, 'classifies a passing test run', err.message);
}

// 2. A destructive command should be surfaced, not called noise.
try {
  const r = await classifyWithAnthropic(
    'Agent: Builder on project "demo".\n\nClassify the terminal output below and call report_update exactly once.\n\nTerminal output:\n$ rm -rf /var/lib/postgresql/data\n$ dropdb production\nDatabase "production" dropped.',
  );
  ok(r.classification !== 'noise', `destructive output is not noise (got ${r.classification})`);
  console.log(`      -> [${r.classification}] ${r.summary}`);
} catch (err) {
  ok(false, 'classifies a destructive command', err.message);
}

// 3. A pinned bad model must fail fast with a typed 'model' error, not hang.
{
  const prev = process.env.ANTHROPIC_MODEL_ID;
  process.env.ANTHROPIC_MODEL_ID = 'claude-3-5-sonnet-20241022'; // retired id
  resetModelSelection();
  try {
    await classifyWithAnthropic('Terminal output:\nhello');
    ok(false, 'a retired model id raises a typed error');
  } catch (err) {
    ok(err instanceof AnthropicSupervisorError && err.kind === 'model',
      `a retired model id raises kind='model' (got ${err?.kind})`, err.message.slice(0, 120));
  }
  if (prev === undefined) delete process.env.ANTHROPIC_MODEL_ID; else process.env.ANTHROPIC_MODEL_ID = prev;
  resetModelSelection();
}

// 4. Missing credentials must raise kind='auth' rather than hanging or 500ing.
{
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-obviously-invalid';
  resetModelSelection();
  try {
    await classifyWithAnthropic('Terminal output:\nhello');
    ok(false, 'an invalid API key raises a typed auth error');
  } catch (err) {
    ok(err instanceof AnthropicSupervisorError && err.kind === 'auth',
      `an invalid API key raises kind='auth' (got ${err?.kind})`, err.message.slice(0, 120));
  }
  if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key;
  resetModelSelection();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
