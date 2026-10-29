/**
 * The local model server Bedrock can use — Ollama, LM Studio, vLLM or
 * llama.cpp, reached through the one thing they all serve: an
 * OpenAI-compatible API.
 *
 * Three features share it, so it is configured once:
 *   - LocalHarness agents (written into each agent's LocalHarness config),
 *   - the Supervisor's `local` backend,
 *   - the Keeper's LocalHarness engine.
 *
 *   LOCAL_LLM_BASE_URL   default http://127.0.0.1:11434/v1 (Ollama)
 *   LOCAL_LLM_MODEL      default: the first model the server lists
 *   LOCAL_LLM_API_KEY    default: none — local servers usually take no key
 */
import './env.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const DEFAULT_LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434/v1';

/**
 * What the Settings screen saved, in ~/.conduit/settings.json under
 * `localLlm`. An environment variable still wins over it — the same order
 * .env already follows — and the screen says which one is in effect.
 */
export interface SavedLocalLlm {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Overrides SUPERVISOR_PROVIDER when that is unset. */
  supervisorProvider?: string;
}

function settingsFile(): string {
  return path.join(os.homedir(), '.conduit', 'settings.json');
}

export function savedLocalLlm(): SavedLocalLlm {
  try {
    const v = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))?.localLlm;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Save (merge) the Settings screen's values. Empty strings clear a field. */
export function saveLocalLlm(next: SavedLocalLlm): SavedLocalLlm {
  let all: Record<string, any> = {};
  try { all = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) || {}; } catch { /* new file */ }
  const merged: Record<string, string> = { ...(all.localLlm || {}) };
  for (const [k, v] of Object.entries(next)) {
    if (typeof v !== 'string') continue;
    if (v.trim()) merged[k] = v.trim(); else delete merged[k];
  }
  all.localLlm = merged;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(all, null, 2), 'utf-8');
  resetLocalModelsCache();
  return merged;
}

/** Which source each value comes from — for the Settings screen. */
export function localLlmSources(): Record<'baseUrl' | 'model' | 'apiKey' | 'supervisorProvider', 'env' | 'settings' | 'default'> {
  const saved = savedLocalLlm();
  const src = (envKey: string, savedVal?: string) =>
    (process.env[envKey] || '').trim() ? 'env' as const : (savedVal || '').trim() ? 'settings' as const : 'default' as const;
  return {
    baseUrl: src('LOCAL_LLM_BASE_URL', saved.baseUrl),
    model: src('LOCAL_LLM_MODEL', saved.model),
    apiKey: src('LOCAL_LLM_API_KEY', saved.apiKey),
    supervisorProvider: src('SUPERVISOR_PROVIDER', saved.supervisorProvider),
  };
}

export interface LocalLlmSettings {
  /** OpenAI-compatible base URL, ending in /v1. */
  baseUrl: string;
  /** Model id, or '' to use the first one the server lists. */
  model: string;
  /** 'none' when the server takes no key. */
  apiKey: string;
  /**
   * Whether the user pointed Bedrock at a server on purpose. The default
   * URL is only a guess, so anything that would change behaviour on its own
   * — the Supervisor's auto ladder — waits for an explicit setting.
   */
  configured: boolean;
}

/**
 * Normalise a base URL: http(s) only, no trailing slash, and `/v1` added when
 * only a host was given (`http://127.0.0.1:1234` → `…:1234/v1`). Returns null
 * for anything that is not a usable URL.
 */
export function normalizeBaseUrl(raw: string): string | null {
  const text = (raw || '').trim();
  if (!text) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null; // a key belongs in LOCAL_LLM_API_KEY, not the URL
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname) pathname = '/v1';
  return `${url.protocol}//${url.host}${pathname}`;
}

export function localLlmSettings(): LocalLlmSettings {
  const saved = savedLocalLlm();
  const rawUrl = (process.env.LOCAL_LLM_BASE_URL || '').trim() || (saved.baseUrl || '').trim();
  const baseUrl = normalizeBaseUrl(rawUrl) || DEFAULT_LOCAL_LLM_BASE_URL;
  return {
    baseUrl,
    model: (process.env.LOCAL_LLM_MODEL || '').trim() || (saved.model || '').trim(),
    apiKey: (process.env.LOCAL_LLM_API_KEY || '').trim() || (saved.apiKey || '').trim() || 'none',
    configured: !!normalizeBaseUrl(rawUrl),
  };
}

export type LocalModelsResult =
  | { ok: true; baseUrl: string; models: string[] }
  | { ok: false; baseUrl: string; error: string };

/** A probe answer is reused this long, so a preflight per agent start stays cheap. */
const PROBE_CACHE_MS = 10_000;
const probeCache = new Map<string, { at: number; result: LocalModelsResult }>();

/** Forget cached probes (tests, and after the settings change). */
export function resetLocalModelsCache(): void {
  probeCache.clear();
}

/**
 * Ask the server which models it serves (`GET <base>/models`). Never throws:
 * an unreachable or wrong server comes back as `{ ok: false, error }` with a
 * sentence a person can act on.
 */
export async function listLocalModels(
  settings: Pick<LocalLlmSettings, 'baseUrl' | 'apiKey'> = localLlmSettings(),
  opts: { timeoutMs?: number; fresh?: boolean } = {},
): Promise<LocalModelsResult> {
  const { baseUrl, apiKey } = settings;
  const key = `${baseUrl}\n${apiKey}`;
  const hit = probeCache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < PROBE_CACHE_MS) return hit.result;

  const result = await probe(baseUrl, apiKey, opts.timeoutMs ?? 3_000);
  probeCache.set(key, { at: Date.now(), result });
  return result;
}

async function probe(baseUrl: string, apiKey: string, timeoutMs: number): Promise<LocalModelsResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey && apiKey !== 'none') headers.authorization = `Bearer ${apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = (err as Error)?.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000}s` : 'nothing is listening';
    return {
      ok: false,
      baseUrl,
      error: `No local model server at ${baseUrl} (${why}). Start Ollama or LM Studio, `
        + 'or set LOCAL_LLM_BASE_URL to the server you run.',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, baseUrl, error: `The model server at ${baseUrl} refused the key (HTTP ${res.status}). Check LOCAL_LLM_API_KEY.` };
  }
  if (!res.ok) {
    return { ok: false, baseUrl, error: `The model server at ${baseUrl} answered HTTP ${res.status} for /models — is that an OpenAI-compatible /v1 URL?` };
  }
  let body: unknown;
  try { body = await res.json(); } catch {
    return { ok: false, baseUrl, error: `${baseUrl}/models did not return JSON — is that an OpenAI-compatible /v1 URL?` };
  }
  const data = (body as { data?: unknown })?.data;
  const models = Array.isArray(data)
    ? data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  return { ok: true, baseUrl, models };
}

/**
 * The model to use: the configured one, else the first the server lists.
 * Null when neither exists — the server is up but has no model pulled.
 */
export function pickModel(settings: LocalLlmSettings, probe: LocalModelsResult): string | null {
  if (settings.model) return settings.model;
  return probe.ok && probe.models.length ? probe.models[0] : null;
}
