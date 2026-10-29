#!/usr/bin/env node
// A stand-in for the `localharness` CLI's `init` subcommand.
//
// `init --endpoint URL --model M --config-dir DIR --no-input [--force]` writes
// DIR/config.yaml when the endpoint "answers" and refuses otherwise, with the
// same wording the real command uses. An endpoint containing "down" is treated
// as unreachable. Every run is appended to DIR/init-calls.log so a test can
// count them.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv[0] !== 'init') {
  process.stderr.write(`fake-localharness: unsupported command ${argv[0]}\n`);
  process.exit(2);
}

const dir = opt('--config-dir');
const endpoint = opt('--endpoint');
const model = opt('--model');
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, 'init-calls.log'), JSON.stringify({ endpoint, model, force: argv.includes('--force') }) + '\n');

if (!argv.includes('--no-input')) {
  process.stderr.write('fake-localharness: refusing to prompt\n');
  process.exit(2);
}
if (endpoint.includes('down')) {
  // Rich wraps the real message across lines; keep that, the caller must join it.
  process.stdout.write('Capability probe inconclusive (attempt 1/3) — retrying\n');
  process.stdout.write(`Error: no answer from ${endpoint} (inference endpoint\nunreachable). No config was written — start the model server\nand run \`localharness init\` again.\n`);
  process.exit(1);
}
fs.writeFileSync(path.join(dir, 'config.yaml'), `version: '1'\nprovider:\n  base_url: ${endpoint}\norg:\n  default_model: ${model}\n`);
fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
process.stdout.write(`✓ Config written to ${path.join(dir, 'config.yaml')}\n`);
