#!/usr/bin/env node
// The Keeper's create_agent tool spells out the CLI ids by hand (its process
// cannot import the registry — see the comment in conduit-mcp-server.ts).
// This keeps the two from drifting: an agent type the Keeper cannot name is
// one it cannot create.
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

const { CLI_IDS } = await import('../src/cli-registry.ts');

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\nKeeper create_agent enum vs the CLI registry\n');

const source = fs.readFileSync(new URL('../src/conduit-mcp-server.ts', import.meta.url), 'utf-8');
const m = source.match(/cli:\s*\{[\s\S]*?enum:\s*\[([^\]]*)\]/);
t(!!m, 'finds the create_agent cli enum');
const ids = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
t(JSON.stringify([...ids].sort()) === JSON.stringify([...CLI_IDS].sort()),
  'it lists exactly the registered CLIs', `enum: ${ids.join(', ')} · registry: ${CLI_IDS.join(', ')}`);
for (const id of CLI_IDS) {
  t(new RegExp(`\\b${id} = `).test(source), `its description explains "${id}"`);
}

const persona = fs.readFileSync(new URL('../src/daemon/orchestrator.ts', import.meta.url), 'utf-8');
// The persona is a template literal, so its backticks are escaped in source.
const line = persona.split('\n').find((l) => /create_agent\\?`\s*—\s*add an agent/.test(l)) || '';
t(CLI_IDS.every((id) => line.includes(id)), 'the Keeper\'s persona names every CLI too', line.trim());

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
