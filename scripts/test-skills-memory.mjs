#!/usr/bin/env node
// Skills (SKILL.md discovery) and project memory, against real storage in a
// temp HOME, through the instruction section every agent reads.
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-skills-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { parseSkillFrontmatter, discoverSkills, skillLines } = await import('../src/skills.ts');
const memory = await import('../src/memory.ts');
const storage = await import('../src/storage.ts');
const { rememberDispatch, recallDispatch, forgetDispatch } = await import('../src/daemon/conduit.ts');

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const skill = (dir, name, description, body = 'Do the thing.') => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
};

console.log('\nSkills and project memory\n');

try {
  // ── frontmatter ──
  t(parseSkillFrontmatter('---\nname: release-notes\ndescription: "Write release notes"\n---\nbody')?.name === 'release-notes', 'parses name and a quoted description');
  t(parseSkillFrontmatter('---\nname: Bad Name\ndescription: x\n---') === null, 'refuses a name outside the Agent Skills rule');
  t(parseSkillFrontmatter('---\nname: ok\n---') === null, 'refuses a skill with no description');
  t(parseSkillFrontmatter('no frontmatter') === null, 'refuses a file with no frontmatter');

  // ── discovery ──
  const cwd = path.join(home, 'proj');
  skill(path.join(cwd, '.bedrock', 'skills', 'review'), 'review', 'Review a diff (project copy)');
  skill(path.join(cwd, '.agents', 'skills', 'deploy'), 'deploy', 'Deploy to staging');
  skill(path.join(home, '.conduit', 'skills', 'review'), 'review', 'Review a diff (user copy)');
  skill(path.join(home, '.conduit', 'skills', 'notes'), 'notes', 'Take meeting notes');
  skill(path.join(cwd, '.bedrock', 'skills', 'broken'), 'Not Valid', 'x');
  const found = discoverSkills(cwd);
  t(found.map((s) => s.name).join(',') === 'deploy,notes,review', 'finds project and user skills, skipping invalid ones', found.map((s) => s.name).join(','));
  t(found.find((s) => s.name === 'review')?.scope === 'project' && /project copy/.test(found.find((s) => s.name === 'review').description),
    'a project skill shadows the user skill of the same name');
  t(found.every((s) => fs.existsSync(s.path)), 'each skill names a file that exists');
  t(skillLines([]).length === 0, 'no skills adds no lines');
  t(skillLines(found).some((l) => l.includes('**deploy** — Deploy to staging')), 'each skill is one line in the instructions');
  t(discoverSkills(path.join(home, 'nowhere')).every((s) => s.scope === 'user'), 'a folder without skills still sees the user\'s');

  // ── memory ──
  const project = storage.createProject('Mem', cwd);
  t(memory.listFacts(project.id).length === 0, 'a new project remembers nothing');
  const a = memory.addFact(project.id, '  API errors use   RFC 7807  ', 'User');
  t(a && a.text === 'API errors use RFC 7807', 'stores a fact with whitespace tidied');
  t(memory.addFact(project.id, '   ') === null, 'refuses an empty fact');
  memory.addFact(project.id, 'Deploys happen on Tuesdays', 'Keeper');
  t(memory.searchFacts(project.id, 'rfc errors').length === 1, 'search matches every word');
  t(memory.searchFacts(project.id, '')[0].text === 'Deploys happen on Tuesdays', 'an empty search lists newest first');
  const lines = memory.memoryLines(project.id).join('\n');
  t(/### Project memory/.test(lines) && /RFC 7807/.test(lines) && /Tuesdays/.test(lines), 'facts appear in the instruction section');
  t(memory.forgetFact(project.id, a.id) && !memory.forgetFact(project.id, a.id), 'forgets a fact once');
  for (let i = 0; i < memory.MAX_FACTS + 5; i++) memory.addFact(project.id, `fact ${i}`);
  t(memory.listFacts(project.id).length === memory.MAX_FACTS, 'memory is capped, oldest dropped');
  t(memory.memoryLines(project.id).filter((l) => l.startsWith('- ')).length === memory.FACTS_IN_INSTRUCTIONS, 'only the newest facts go into instructions');
  let threw = false;
  try { memory.addFact('../x', 'escape'); } catch { threw = true; }
  t(threw && memory.listFacts('../x').length === 0, 'a project id that is not id-shaped is refused, never turned into a path');

  // ── the Keeper's tools ──
  const r = rememberDispatch('Mem', 'Use pnpm, not npm');
  t(r.ok && r.projectName === 'Mem' && r.fact, 'remember records by project name');
  t(recallDispatch('mem', 'pnpm').facts?.[0]?.text === 'Use pnpm, not npm', 'recall finds it');
  t(forgetDispatch('Mem', r.fact.id).ok && !recallDispatch('Mem', 'pnpm').facts.length, 'forget removes it');
  t(!rememberDispatch('Nope', 'x').ok, 'an unknown project is an error, not a silent no-op');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
