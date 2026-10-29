#!/usr/bin/env node
// Agent definitions (.bedrock/agents/*.yaml) and machine-level plugins, in a temp HOME.
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-tpl-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { parseFlatYaml, readAgentTemplates } = await import('../src/agent-templates.ts');
const plugins = await import('../src/plugins.ts');

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\nAgent definitions and plugins\n');

try {
  // ── flat YAML ──
  const y = parseFlatYaml('# team\nname: "Reviewer"   # inline comment\ncli: localharness\n\nrole: Reviews diffs\n');
  t(y.name === 'Reviewer' && y.cli === 'localharness' && y.role === 'Reviews diffs', 'reads flat key: value YAML with comments and quotes');
  t(parseFlatYaml('{"name":"J","cli":"claude"}').cli === 'claude', 'reads JSON too');
  let threw = false;
  try { parseFlatYaml('name: x\n  nested: y'); } catch { threw = true; }
  t(threw, 'refuses nested YAML rather than misreading it');

  // ── a project's definitions ──
  const cwd = path.join(home, 'proj');
  const dir = path.join(cwd, '.bedrock', 'agents');
  fs.mkdirSync(path.join(cwd, 'services', 'api'), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviewer.yaml'), 'name: Reviewer\ncli: localharness\nrole: Reviews\nterminal: true\n');
  fs.writeFileSync(path.join(dir, 'api.yml'), 'name: Api\ncli: claude\ncwd: services/api\ndangerouslySkipPermissions: true\n');
  fs.writeFileSync(path.join(dir, 'bad-cli.yaml'), 'name: Ghost\ncli: skynet\n');
  fs.writeFileSync(path.join(dir, 'escape.yaml'), 'name: Escaper\ncli: gemini\ncwd: ../../outside\n');
  // Files are read alphabetically and the first definition of a name wins.
  fs.writeFileSync(path.join(dir, 'zz-dupe.yaml'), 'name: reviewer\ncli: gemini\n');
  const { templates, problems } = readAgentTemplates(cwd);
  const byName = Object.fromEntries(templates.map((x) => [x.name, x]));
  t(Object.keys(byName).sort().join(',') === 'Api,Reviewer', 'loads the valid definitions', Object.keys(byName).join(','));
  t(byName.Api?.cwd === path.join(cwd, 'services', 'api'), 'resolves cwd inside the project');
  t(byName.Reviewer?.terminal === true && byName.Api?.terminal === undefined, 'terminal only applies to LocalHarness');
  t(!('dangerouslySkipPermissions' in (byName.Api || {})), 'a definition cannot loosen a gate');
  t(problems.some((p) => /bad-cli/.test(p.file) && /not an agent type/.test(p.error)), 'an unknown cli is reported');
  t(problems.some((p) => /escape/.test(p.file) && /not a folder inside/.test(p.error)), 'a cwd outside the project is refused');
  t(problems.some((p) => /zz-dupe/.test(p.file) && /second definition/.test(p.error)), 'a later duplicate name is reported, the first kept');
  t(readAgentTemplates(path.join(home, 'empty')).templates.length === 0, 'a project without definitions has none');

  // ── plugins ──
  t(plugins.listPlugins().length === 0, 'no plugins by default');
  const pdir = path.join(home, '.conduit', 'plugins', 'recorder');
  fs.mkdirSync(pdir, { recursive: true });
  const log = path.join(home, 'events.log').replace(/\\/g, '/');
  fs.writeFileSync(path.join(pdir, 'plugin.mjs'),
    `import fs from 'node:fs';\nexport default { name: 'recorder', onEvent(e) { fs.appendFileSync(${JSON.stringify(log)}, e.event + '\\n'); } };\n`);
  fs.mkdirSync(path.join(home, '.conduit', 'plugins', 'thrower'), { recursive: true });
  fs.writeFileSync(path.join(home, '.conduit', 'plugins', 'thrower', 'plugin.mjs'), 'export default { onEvent() { throw new Error("boom"); } };\n');

  t(plugins.listPlugins().map((p) => `${p.name}:${p.enabled}`).join(',') === 'recorder:false,thrower:false', 'discovers plugins, all disabled');
  await plugins.loadPlugins();
  t(!plugins.hasPlugins(), 'a discovered plugin does not load until enabled');
  plugins.setPluginEnabled('recorder', true);
  plugins.setPluginEnabled('thrower', true);
  const loaded = await plugins.loadPlugins();
  t(loaded.every((p) => p.loaded), 'enabled plugins load', JSON.stringify(loaded));
  plugins.emitToPlugins({ kind: 'event', event: 'agent:status' });
  plugins.emitToPlugins({ kind: 'event', event: 'gate:triggered' });
  t(fs.readFileSync(log, 'utf-8') === 'agent:status\ngate:triggered\n', 'events reach the plugin, in order');
  t(true, 'a plugin that throws does not stop the others or the caller');
  plugins.setPluginEnabled('recorder', false);
  plugins.setPluginEnabled('thrower', false);
  await plugins.loadPlugins();
  t(!plugins.hasPlugins(), 'disabling unloads on reload');
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.conduit', 'settings.json'), 'utf-8'));
  t(Array.isArray(settings.plugins.enabled) && settings.plugins.enabled.length === 0, 'the choice is kept in machine settings');
  plugins.setPluginEnabled('ghost', true);
  const ghost = (await plugins.loadPlugins()).find((p) => p.name === 'ghost');
  t(ghost && !ghost.loaded && /does not exist/.test(ghost.error || ''), 'an enabled plugin with no file says so');
  let bad = false;
  try { plugins.setPluginEnabled('../evil', true); } catch { bad = true; }
  t(bad, 'a plugin name cannot be a path');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
