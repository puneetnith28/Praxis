/**
 * Skills — procedures an agent loads when a request matches, in the open
 * Agent Skills format (a folder holding a SKILL.md with `name` and
 * `description` frontmatter). The idea is LocalHarness's; here it works for
 * every CLI Bedrock runs.
 *
 * Found in, highest precedence first:
 *   <project cwd>/.bedrock/skills/<skill>/SKILL.md
 *   <project cwd>/.agents/skills/<skill>/SKILL.md
 *   ~/.conduit/skills/<skill>/SKILL.md
 *
 * Each agent's instruction section lists one line per skill with the file to
 * read. A skill is text: it grants no tool, installs nothing, and changes no
 * permission. A project's skills come with the project, so read them in a
 * repository you did not write — the same caution LocalHarness gives.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveInside } from './storage-fs.js';

export interface Skill {
  name: string;
  description: string;
  /** Absolute path of its SKILL.md. */
  path: string;
  scope: 'project' | 'user';
}

/** The Agent Skills name rule: lowercase letters, digits and hyphens. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION = 1024;
/** A SKILL.md is read only for its frontmatter; refuse anything huge. */
const MAX_BYTES = 256 * 1024;
const MAX_SKILLS = 100;

/** `name` and `description` from a SKILL.md's leading `---` block, or null. */
export function parseSkillFrontmatter(text: string): { name: string; description: string } | null {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const name = fields.name || '';
  const description = (fields.description || '').replace(/\s+/g, ' ').trim();
  if (!NAME.test(name) || !description || description.length > MAX_DESCRIPTION) return null;
  return { name, description };
}

function scan(root: string, scope: Skill['scope']): Skill[] {
  const out: Skill[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  let rootReal: string;
  try { rootReal = fs.realpathSync(root); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || out.length >= MAX_SKILLS) continue;
    const file = resolveInside(root, path.join(e.name, 'SKILL.md'));
    if (!file) continue;
    try {
      // A link that leads out of the skills folder is not this folder's skill.
      const real = fs.realpathSync(file);
      if (path.relative(rootReal, real).startsWith('..')) continue;
      const st = fs.statSync(real);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      const meta = parseSkillFrontmatter(fs.readFileSync(real, 'utf-8'));
      if (meta) out.push({ ...meta, path: real, scope });
    } catch { /* unreadable — skipped */ }
  }
  return out;
}

/** Every skill visible from `cwd`, one per name; project skills shadow the user's. */
export function discoverSkills(cwd: string): Skill[] {
  const roots: Array<[string, Skill['scope']]> = [];
  for (const rel of [path.join('.bedrock', 'skills'), path.join('.agents', 'skills')]) {
    const dir = cwd ? resolveInside(cwd, rel) : null;
    if (dir) roots.push([dir, 'project']);
  }
  roots.push([path.join(os.homedir(), '.conduit', 'skills'), 'user']);
  const byName = new Map<string, Skill>();
  for (const [dir, scope] of roots) {
    for (const s of scan(dir, scope)) if (!byName.has(s.name)) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The instruction-section lines for these skills, or none at all. */
export function skillLines(skills: Skill[]): string[] {
  if (!skills.length) return [];
  return [
    '',
    '### Skills',
    'Procedures for specific kinds of work. When a request matches one, read its file and follow it.',
    'A skill is guidance only: it grants no tools and changes no permissions.',
    ...skills.map((s) => `- **${s.name}** — ${s.description} (read: ${s.path})`),
  ];
}
