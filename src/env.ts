import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Load configuration from `.env`.
 *
 * Plain `dotenv.config()` only looks at `path.resolve(process.cwd(), '.env')`,
 * which is the repo root when you run `npm run start:all` — and the *install
 * directory* when the packaged desktop app launches itself. A desktop user has
 * no repo, so every `.env` setting (BEDROCK_MODEL_ID, AWS keys, GROQ_API_KEY,
 * ANTHROPIC_API_KEY, CONDUIT_AUTH) silently fell back to its default there
 * while working fine on the web.
 *
 * So we also read `~/.conduit/.env`, which exists in both modes — Conduit
 * already owns that directory. The working directory wins where both define a
 * key, since dotenv never overwrites a variable that is already set, and a real
 * environment variable still beats both.
 *
 * Call this once, first thing, in every entry point (server, daemon).
 */
const loaded: string[] = [];

export function loadEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.join(os.homedir(), '.conduit', '.env'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    dotenv.config({ path: file });
    loaded.push(file);
  }
}

/** The `.env` files actually read, in precedence order. Surfaced in /api/health. */
export function loadedEnvFiles(): string[] {
  return [...loaded];
}

/** Where a desktop user should put their `.env` — there is no repo to put one in. */
export function userEnvPath(): string {
  return path.join(os.homedir(), '.conduit', '.env');
}

loadEnv();

export function parsePortWithBounds(raw: unknown, defaultPort: number): number {
  const p = Number(raw);
  return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : defaultPort;
}
