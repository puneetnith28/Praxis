/**
 * The instruction block Conduit writes into a project's own repository.
 *
 * Starting an agent appends a delimited section to `CLAUDE.md` or `AGENTS.md`
 * in the agent's working directory, telling that CLI where the shared content
 * and wiki live and who its teammates are. That file belongs to the user, not
 * to Conduit — so the markers live here, in one place, and deleting a project
 * takes the section back out again rather than leaving it behind forever.
 */
import fs from 'fs';
import path from 'path';
import type { CliId } from './cli-registry.js';

export const CONDUIT_MARKER = '<!-- Conduit -->';
export const CONDUIT_END_MARKER = '<!-- End Conduit -->';
export const BEDROCK_MARKER = '<!-- Bedrock -->';
export const BEDROCK_END_MARKER = '<!-- End Bedrock -->';
/** The markers written today (see `buildConduitSection` in pty-manager). */
export const PRIMARY_MARKER = '<!-- BEDROCK_INSTRUCTIONS_START -->';
export const PRIMARY_END_MARKER = '<!-- BEDROCK_INSTRUCTIONS_END -->';

/**
 * Which file each CLI reads its project instructions from.
 *
 * Keyed by CliId, not string: a CLI added to the registry without an entry
 * here is a compile error, rather than `path.join(cwd, undefined)` at start —
 * which threw inside a catch that only logged, so the agent started knowing
 * nothing about Bedrock.
 */
export const INSTRUCTION_FILES: Record<CliId, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'AGENTS.md',
  opencode: 'AGENTS.md',
  gpt: 'AGENTS.md',
  nemotron: 'AGENTS.md',
  // The default only — see instructionFileFor.
  localharness: 'AGENTS.md',
};

/** LocalHarness's own instructions file, read when neither of the others exists. */
const LOCALHARNESS_INSTRUCTIONS = path.join('.localharness', 'INSTRUCTIONS.md');

/** Every file name Bedrock might have written into a project directory. */
export const ALL_INSTRUCTION_FILES = [...new Set([...Object.values(INSTRUCTION_FILES), LOCALHARNESS_INSTRUCTIONS])];

/**
 * The instruction file this agent will actually read, in `cwd`.
 *
 * Fixed per CLI, except LocalHarness: it reads the FIRST of CLAUDE.md,
 * AGENTS.md and .localharness/INSTRUCTIONS.md that exists
 * (localharness/config/project_records.py). In a folder that already has a
 * CLAUDE.md — another agent's, or the user's own — a section written to
 * AGENTS.md would never be seen. And where only INSTRUCTIONS.md exists,
 * creating an AGENTS.md would shadow the user's file, so the section goes
 * into INSTRUCTIONS.md instead.
 */
export function instructionFileFor(cli: CliId, cwd: string): string {
  if (cli === 'localharness') {
    for (const name of ['CLAUDE.md', 'AGENTS.md', LOCALHARNESS_INSTRUCTIONS]) {
      try {
        if (fs.statSync(path.join(cwd, name)).isFile()) return name;
      } catch { /* absent */ }
    }
  }
  return INSTRUCTION_FILES[cli];
}

/**
 * Strip Bedrock's section (and older Conduit / AgentOrg ones) from a markdown file.
 * Returns the remaining text — the caller decides whether to write it back.
 */
export function stripConduitSection(text: string): string {
  return text
    .replace(/\n*<!-- AgentOrg[^>]*-->[\s\S]*?<!-- End AgentOrg -->\n*/g, '\n')
    .replace(/\n*<!-- Conduit[^>]*-->[\s\S]*?<!-- End Conduit -->\n*/g, '\n')
    .replace(/\n*<!-- Bedrock[^>]*-->[\s\S]*?<!-- End Bedrock -->\n*/g, '\n')
    // The markers buildConduitSection writes today. The `Bedrock` pattern above
    // is case-sensitive and does not match them, so without this line every
    // start appended another copy and a delete left the section behind.
    .replace(/\n*<!-- BEDROCK_INSTRUCTIONS_START -->[\s\S]*?<!-- BEDROCK_INSTRUCTIONS_END -->\n*/g, '\n');
}

/**
 * Take Bedrock's section back out of every instruction file in `cwd`.
 *
 * If nothing is left but the heading Bedrock itself wrote, the file goes too —
 * it was ours. Anything the user wrote survives untouched. Best-effort by
 * design: a read-only file or a directory that no longer exists must not stop a
 * project from being deleted.
 *
 * Returns the paths that were changed.
 */
export function removeConduitSections(cwd: string, projectName?: string): string[] {
  const touched: string[] = [];
  for (const name of ALL_INSTRUCTION_FILES) {
    const file = path.join(cwd, name);
    try {
      if (!fs.existsSync(file)) continue;
      const before = fs.readFileSync(file, 'utf-8');
      if (!before.includes(PRIMARY_MARKER) && !before.includes(CONDUIT_MARKER)
        && !before.includes(BEDROCK_MARKER) && !before.includes('<!-- AgentOrg')) continue;
      const after = stripConduitSection(before).trim();

      // `# <project name>` on its own is the file Conduit created from nothing.
      const onlyOurHeading = projectName
        ? after === '' || after === `# ${projectName}`
        : after === '';
      if (onlyOurHeading) fs.unlinkSync(file);
      else fs.writeFileSync(file, after + '\n', 'utf-8');
      touched.push(file);
    } catch { /* best effort — never block a delete on the user's own repo */ }
  }
  return touched;
}
