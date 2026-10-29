/**
 * The agent CLIs Conduit can drive — one source of truth.
 *
 * Every place that validates, spawns, documents or lists an agent type reads
 * from here, so adding a CLI is a single edit. `binary` is what must be on
 * PATH; `install` is shown to the user when it isn't.
 */

import fs from 'fs';
import path from 'path';
import { userEnvPath } from './env.js';

export const CLI_IDS = ['claude', 'codex', 'gemini', 'opencode', 'gpt', 'nemotron', 'localharness'] as const;

export type CliId = (typeof CLI_IDS)[number];

export interface CliSpec {
  id: CliId;
  /** Human label for UI and error messages. */
  label: string;
  /** Executable that must resolve on PATH. */
  binary: string;
  /** Shown when `binary` is missing. */
  install: string;
  /** Extra env vars the CLI needs to reach its model, if any. */
  requiresEnv?: string[];
}

export const CLI_SPECS: Record<CliId, CliSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    binary: 'codex',
    install: 'npm install -g @openai/codex',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    install: 'npm install -g @google/gemini-cli',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    binary: 'opencode',
    install: 'npm install -g opencode-ai',
  },
  gpt: {
    id: 'gpt',
    label: 'GPT-OSS 120B (Groq)',
    binary: 'aider',
    install: 'uv tool install --python 3.12 aider-chat   (aider needs Python 3.10–3.12)',
    requiresEnv: ['GROQ_API_KEY'],
  },
  nemotron: {
    id: 'nemotron',
    label: 'Nemotron 3.5 Lightning (OpenRouter)',
    binary: 'aider',
    install: 'uv tool install --python 3.12 aider-chat   (aider needs Python 3.10–3.12)',
    requiresEnv: ['OPENROUTER_API_KEY'],
  },
  localharness: {
    id: 'localharness',
    label: 'LocalHarness (local model)',
    binary: 'localharness',
    // No API key: it runs on the local model server (see src/local-llm.ts),
    // which the runtime checks before starting — that needs a network probe,
    // so it cannot live in this synchronous check.
    install: 'uv tool install localharness   (LocalHarness needs Python 3.12+)',
  },
};

/**
 * CLIs that are Python tools installed with uv. A missing one is diagnosed
 * further — is uv there, is Python — because "not on PATH" alone does not say
 * which of the three to install.
 */
const PYTHON_TOOLS: Record<string, string> = {
  aider: 'uv tool install --python 3.12 aider-chat',
  localharness: 'uv tool install localharness',
};

/** Valid `cli` values, for request validation. */
export const VALID_CLIS: CliId[] = [...CLI_IDS];

export function isCliId(v: unknown): v is CliId {
  return typeof v === 'string' && (CLI_IDS as readonly string[]).includes(v);
}

/**
 * Resolve an executable on PATH, the way a shell would. On Windows a CLI is
 * usually a `.cmd` shim, so PATHEXT has to be honoured.
 */
export function findOnPath(binary: string): string | null {
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

export interface BinaryAvailability {
  available: boolean;
  binary: string;
  path?: string;
  prerequisites?: {
    python?: boolean;
    uv?: boolean;
  };
  hint?: string;
}

/**
 * Health check probe for CLI binaries and helper toolchains (uv, python).
 */
export function checkBinaryAvailability(cli: CliId): BinaryAvailability {
  const spec = CLI_SPECS[cli];
  if (!spec) {
    return { available: false, binary: cli, hint: `Unknown CLI ${cli}` };
  }

  const binaryPath = findOnPath(spec.binary);
  const pythonInstall = PYTHON_TOOLS[spec.binary];
  if (pythonInstall) {
    const hasUv = !!findOnPath('uv');
    const hasPython = !!(findOnPath('python3') || findOnPath('python'));
    const prereqs = { uv: hasUv, python: hasPython };

    if (!binaryPath) {
      const hint = spec.binary === 'aider'
        ? (hasUv
          ? 'uv is installed. Run: uv tool install --python 3.12 aider-chat'
          : 'Install uv (https://astral.sh/uv) or Python 3.10-3.12, then run: uv tool install aider-chat')
        : (hasUv
          ? `uv is installed. Run: ${pythonInstall}`
          : `Install uv (https://astral.sh/uv), then run: ${pythonInstall}`);
      return {
        available: false,
        binary: spec.binary,
        prerequisites: prereqs,
        hint,
      };
    }

    return {
      available: true,
      binary: spec.binary,
      path: binaryPath,
      prerequisites: prereqs,
    };
  }

  if (!binaryPath) {
    return {
      available: false,
      binary: spec.binary,
      hint: `Install with: ${spec.install}`,
    };
  }

  return {
    available: true,
    binary: spec.binary,
    path: binaryPath,
  };
}

export interface CliReadiness {
  ok: boolean;
  /** Absolute path to the resolved binary, when found. */
  resolved?: string;
  /** Human-readable reason, when not ok. */
  error?: string;
  /** Detailed toolchain prerequisites */
  prerequisites?: {
    python?: boolean;
    uv?: boolean;
  };
}

/**
 * Can this agent type actually start? Checks the binary is installed and that
 * any required API keys are present, so a missing dependency surfaces as a
 * clear message instead of a shell that prints "not recognized" and looks alive.
 */
export function checkCliReady(cli: CliId): CliReadiness {
  const spec = CLI_SPECS[cli];
  if (!spec) return { ok: false, error: `Unknown agent type "${cli}".` };

  const availability = checkBinaryAvailability(cli);
  if (!availability.available) {
    const extra = availability.hint ? `\n${availability.hint}` : `\nInstall it with:  ${spec.install}`;
    return {
      ok: false,
      error: `${spec.label} needs the \`${spec.binary}\` command, which is not on PATH.${extra}`,
      prerequisites: availability.prerequisites,
    };
  }

  const resolved = availability.path;
  const missing = (spec.requiresEnv || []).filter((k) => !(process.env[k] || '').trim());
  if (missing.length) {
    return {
      ok: false,
      resolved,
      prerequisites: availability.prerequisites,
      error: `${spec.label} needs ${missing.join(' and ')} set. Add ${missing.length === 1 ? 'it' : 'them'} to `
        + `${userEnvPath()} (or the .env next to the server) and restart Bedrock.`,
    };
  }

  return { ok: true, resolved, prerequisites: availability.prerequisites };
}


export const BINARY_PATH_CACHE_TTL = 60000;
