/**
 * Who answers an approval gate — you, or Conduit on your behalf.
 *
 * The original position was that every gate is yours. In practice most gates
 * are an agent asking "shall I create README.md?", and answering those by hand
 * all day is precisely what a control centre is supposed to spare you. If you
 * have to approve everything yourself there was no point having a Keeper.
 *
 * So gates are sorted into two tiers (`classifyGate`, in gatePatterns.ts) and
 * only one of them reaches you:
 *
 *   harmful  — expensive or impossible to undo (`rm -rf`, `git push --force`,
 *              `DROP TABLE`, `kubectl delete`), or anything the Supervisor
 *              itself flagged as risky. Always yours. Never auto-approved,
 *              whatever the settings say.
 *   routine  — the CLI is waiting on an ordinary y/n prompt. Answered for you
 *              when `autoApproveRoutine` is on, which is the default.
 *
 * An auto-approval is never silent. One line goes to the project group chat
 * saying what was asked and that it was allowed, and the full gate goes to the
 * audit log — so "what did it agree to while I was away" is one screen.
 *
 * This module owns only the setting. The classification is pure and lives with
 * the patterns, where it can be tested without touching a filesystem.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyGate } from './gatePatterns.js';
import type { GateSource } from './types.js';

export interface GateSettings {
  /** Answer ordinary y/n prompts without asking. Harmful gates ignore this. */
  autoApproveRoutine: boolean;
}

const SETTINGS_FILE = path.join(os.homedir(), '.conduit', 'settings.json');

const DEFAULTS: GateSettings = {
  // On, because that is the behaviour that makes the Keeper worth having.
  autoApproveRoutine: true,
};

let cache: GateSettings | null = null;

export function loadGateSettings(): GateSettings {
  if (cache) return cache;
  let stored: Partial<GateSettings> = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))?.gates || {};
    }
  } catch { /* unreadable or malformed — defaults are fine */ }

  // An env var wins, so a cautious deployment can turn this off for everyone
  // without editing a file each user can change back.
  const env = process.env.CONDUIT_AUTO_APPROVE;
  const fromEnv = env === undefined ? undefined : !/^(0|off|false|no)$/i.test(env);

  cache = {
    autoApproveRoutine: fromEnv ?? stored.autoApproveRoutine ?? DEFAULTS.autoApproveRoutine,
  };
  return cache;
}

export function saveGateSettings(next: Partial<GateSettings>): GateSettings {
  const merged = { ...loadGateSettings(), ...next };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    let all: Record<string, unknown> = {};
    try {
      if (fs.existsSync(SETTINGS_FILE)) all = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) || {};
    } catch { /* replace a corrupt file rather than fail the save */ }
    all.gates = merged;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2), 'utf-8');
  } catch { /* read-only home — the setting still applies for this run */ }
  cache = merged;
  return merged;
}

/**
 * Drop the cached copy. The web server owns the file; the daemon owns the
 * gates, and they are separate processes — so a save on one side has to tell
 * the other its copy is stale.
 */
export function resetGateSettingsCache(): void {
  cache = null;
}

/** True when Conduit should answer this gate itself. */
export function shouldAutoApprove(prompt: string, source: GateSource): boolean {
  if (!loadGateSettings().autoApproveRoutine) return false;
  return classifyGate(prompt, source) === 'routine';
}
