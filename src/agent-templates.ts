/**
 * Agents defined in a project's own files — LocalHarness's "agents are YAML",
 * for Bedrock. A project declares its team in
 *
 *   <project cwd>/.bedrock/agents/<name>.yaml   (or .yml / .json)
 *
 *   name: Reviewer
 *   cli: localharness
 *   role: Reviews every diff before it lands
 *   cwd: services/api          # optional, relative to the project
 *   terminal: false            # optional, LocalHarness only
 *
 * and "Import agents" creates the ones the project does not have yet. Only
 * flat `key: value` YAML is read — enough for these five fields, and no YAML
 * library to trust. A definition is data: it can name a CLI the registry
 * knows and a folder inside the project, nothing else. It cannot set
 * --dangerously-skip-permissions or any other flag that loosens a gate.
 */
import fs from 'fs';
import path from 'path';
import { isCliId, type CliId } from './cli-registry.js';
import { resolveInside } from './storage-fs.js';

export interface AgentTemplate {
  /** The file it came from, relative to the project. */
  file: string;
  name: string;
  cli: CliId;
  role?: string;
  /** Absolute, and inside the project. */
  cwd: string;
  terminal?: boolean;
}

export interface TemplateProblem {
  file: string;
  error: string;
}

const MAX_FILES = 50;
const MAX_BYTES = 16 * 1024;

/** Flat `key: value` lines (comments and blank lines ignored), or a JSON object. */
export function parseFlatYaml(text: string): Record<string, string> {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)]));
  }
  const out: Record<string, string> = {};
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) throw new Error(`cannot read line "${raw.trim()}" — only flat "key: value" lines are supported`);
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Validate one parsed definition against the project. */
export function toTemplate(fields: Record<string, string>, file: string, projectCwd: string): AgentTemplate {
  const name = (fields.name || '').trim();
  if (!name || name.length > 80) throw new Error('name is required (at most 80 characters)');
  const cli = (fields.cli || '').trim().toLowerCase();
  if (!isCliId(cli)) throw new Error(`cli "${fields.cli || ''}" is not an agent type Bedrock knows`);
  let cwd = path.resolve(projectCwd);
  if (fields.cwd && fields.cwd.trim() && fields.cwd.trim() !== '.') {
    const inside = resolveInside(projectCwd, fields.cwd.trim());
    if (!inside) throw new Error(`cwd "${fields.cwd}" is not a folder inside the project`);
    cwd = inside;
  }
  const role = fields.role ? fields.role.trim().slice(0, 200) : undefined;
  const terminal = cli === 'localharness' && /^(true|yes|on|1)$/i.test(fields.terminal || '') ? true : undefined;
  return { file, name, cli, ...(role ? { role } : {}), cwd, ...(terminal ? { terminal } : {}) };
}

/** Every definition in the project's .bedrock/agents, and the files that could not be read. */
export function readAgentTemplates(projectCwd: string): { templates: AgentTemplate[]; problems: TemplateProblem[] } {
  const templates: AgentTemplate[] = [];
  const problems: TemplateProblem[] = [];
  const dir = resolveInside(projectCwd, path.join('.bedrock', 'agents'));
  if (!dir) return { templates, problems };
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => /\.(ya?ml|json)$/i.test(n)).sort().slice(0, MAX_FILES); }
  catch { return { templates, problems }; }
  const seen = new Set<string>();
  for (const n of names) {
    const rel = path.join('.bedrock', 'agents', n);
    try {
      const file = resolveInside(dir, n);
      if (!file) throw new Error('not a file inside .bedrock/agents');
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_BYTES) throw new Error('not a small regular file');
      const t = toTemplate(parseFlatYaml(fs.readFileSync(file, 'utf-8')), rel, projectCwd);
      if (seen.has(t.name.toLowerCase())) throw new Error(`a second definition of "${t.name}"`);
      seen.add(t.name.toLowerCase());
      templates.push(t);
    } catch (err) {
      problems.push({ file: rel, error: (err as Error).message });
    }
  }
  return { templates, problems };
}
