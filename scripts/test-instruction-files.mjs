#!/usr/bin/env node
// The instruction section Bedrock writes into a project's CLAUDE.md / AGENTS.md
// must be replaced on every start and removed on delete — never accumulated.
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

const {
  PRIMARY_MARKER,
  PRIMARY_END_MARKER,
  INSTRUCTION_FILES,
  ALL_INSTRUCTION_FILES,
  instructionFileFor,
  stripConduitSection,
  removeConduitSections,
} = await import('../src/instruction-files.ts');
const { CLI_IDS } = await import('../src/cli-registry.ts');

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const count = (s, needle) => s.split(needle).length - 1;

console.log('\nInstruction file section tests\n');

const section = `\n${PRIMARY_MARKER}\n## Bedrock — Multi-Agent Collaboration\nbody\n\n${PRIMARY_END_MARKER}\n`;

// 1. The markers written today are stripped.
const user = '# My project\n\nThe user wrote this.\n';
const stripped = stripConduitSection(user + section);
t(!stripped.includes(PRIMARY_MARKER) && !stripped.includes(PRIMARY_END_MARKER), 'strips the current markers');
t(stripped.includes('The user wrote this.'), 'keeps what the user wrote');

// 2. Simulated restarts (strip, then append) keep exactly one section.
let file = user + section;
for (let i = 0; i < 3; i++) file = stripConduitSection(file).trimEnd() + '\n' + section;
t(count(file, PRIMARY_MARKER) === 1, 'three restarts leave one section', `found ${count(file, PRIMARY_MARKER)}`);

// 3. Older section formats are still recognised.
for (const [open, close] of [
  ['<!-- Conduit -->', '<!-- End Conduit -->'],
  ['<!-- Bedrock -->', '<!-- End Bedrock -->'],
  ['<!-- AgentOrg -->', '<!-- End AgentOrg -->'],
]) {
  const out = stripConduitSection(`${user}\n${open}\nold\n${close}\n`);
  t(!out.includes(open), `strips the legacy ${open} section`);
}

// 4. removeConduitSections on a real directory.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-instr-'));
try {
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Demo\n' + section);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), user + section);
  const touched = removeConduitSections(dir, 'Demo');
  t(touched.length === 2, 'reports both files as changed', `touched ${touched.length}`);
  t(!fs.existsSync(path.join(dir, 'AGENTS.md')), 'deletes a file that held only our heading and section');
  const kept = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
  t(kept.includes('The user wrote this.') && !kept.includes(PRIMARY_MARKER), 'keeps the user file, minus our section');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5. Every CLI has an instruction file.
t(CLI_IDS.every((cli) => typeof INSTRUCTION_FILES[cli] === 'string'), 'every registered CLI has an instruction file');

// 6. LocalHarness reads the first of CLAUDE.md, AGENTS.md, .localharness/INSTRUCTIONS.md.
const lh = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-lh-instr-'));
try {
  t(instructionFileFor('localharness', lh) === 'AGENTS.md', 'localharness defaults to AGENTS.md in an empty folder');
  fs.mkdirSync(path.join(lh, '.localharness'));
  fs.writeFileSync(path.join(lh, '.localharness', 'INSTRUCTIONS.md'), '# mine\n');
  t(instructionFileFor('localharness', lh) === path.join('.localharness', 'INSTRUCTIONS.md'),
    'with only INSTRUCTIONS.md, writes there instead of shadowing it with AGENTS.md');
  fs.writeFileSync(path.join(lh, 'AGENTS.md'), '# agents\n');
  t(instructionFileFor('localharness', lh) === 'AGENTS.md', 'AGENTS.md outranks INSTRUCTIONS.md');
  fs.writeFileSync(path.join(lh, 'CLAUDE.md'), '# claude\n');
  t(instructionFileFor('localharness', lh) === 'CLAUDE.md', 'CLAUDE.md outranks both, as LocalHarness reads it');
  t(instructionFileFor('gemini', lh) === 'AGENTS.md' && instructionFileFor('claude', lh) === 'CLAUDE.md',
    'other CLIs keep their fixed file regardless of what exists');
  t(ALL_INSTRUCTION_FILES.includes(path.join('.localharness', 'INSTRUCTIONS.md')),
    'removal also looks in .localharness/INSTRUCTIONS.md');
  // The section is taken back out of INSTRUCTIONS.md and the user's text kept.
  fs.rmSync(path.join(lh, 'CLAUDE.md'));
  fs.rmSync(path.join(lh, 'AGENTS.md'));
  fs.appendFileSync(path.join(lh, '.localharness', 'INSTRUCTIONS.md'), section);
  removeConduitSections(lh, 'Demo');
  const after = fs.readFileSync(path.join(lh, '.localharness', 'INSTRUCTIONS.md'), 'utf-8');
  t(after.includes('# mine') && !after.includes(PRIMARY_MARKER), 'removal strips our section from INSTRUCTIONS.md and keeps the user\'s');
} finally {
  fs.rmSync(lh, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
