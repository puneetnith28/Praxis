/**
 * Plugins — LocalHarness's plugin idea, with its trust rule, for Bedrock.
 *
 *   ~/.conduit/plugins/<name>/plugin.mjs
 *
 *   export default {
 *     name: 'notify',
 *     onEvent(event) { … }   // every daemon event: agent:status, gate:triggered, …
 *   };
 *
 * Trust: a plugin is code that runs with your privileges, so it is found only
 * in your machine's own folder and loads only when ~/.conduit/settings.json
 * lists it under `plugins.enabled`. Nothing in a project can install or enable
 * one. Version 1 of the API is read-only: a plugin observes events; it cannot
 * answer a gate, start an agent or send one a message. Its errors are caught,
 * its promises never awaited, so a broken plugin cannot stall the daemon.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

export const PLUGIN_API_VERSION = '1';
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface PluginModule {
  name?: string;
  onEvent?: (event: Record<string, unknown>) => unknown;
}

export interface PluginInfo {
  name: string;
  enabled: boolean;
  loaded: boolean;
  error?: string;
}

const loaded = new Map<string, PluginModule>();
const loadErrors = new Map<string, string>();

export function pluginsDir(): string {
  return path.join(os.homedir(), '.conduit', 'plugins');
}

function settingsFile(): string {
  return path.join(os.homedir(), '.conduit', 'settings.json');
}

function readSettings(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) || {}; } catch { return {}; }
}

export function enabledPlugins(): string[] {
  const list = readSettings().plugins?.enabled;
  return Array.isArray(list) ? list.filter((n: unknown): n is string => typeof n === 'string' && NAME.test(n)) : [];
}

/** Turn a plugin on or off in the machine's settings (takes effect on reload). */
export function setPluginEnabled(name: string, on: boolean): string[] {
  if (!NAME.test(name)) throw new Error('Invalid plugin name');
  const all = readSettings();
  const current = new Set(enabledPlugins());
  if (on) current.add(name); else current.delete(name);
  all.plugins = { ...(all.plugins || {}), enabled: [...current].sort() };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(all, null, 2), 'utf-8');
  return all.plugins.enabled;
}

function entryFor(name: string): string {
  return path.join(pluginsDir(), name, 'plugin.mjs');
}

/** Folders that hold a plugin, enabled or not. */
export function discoverPlugins(): string[] {
  try {
    return fs.readdirSync(pluginsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && NAME.test(e.name) && fs.existsSync(entryFor(e.name)))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** (Re)load the enabled plugins. Each failure is recorded, never thrown. */
export async function loadPlugins(): Promise<PluginInfo[]> {
  loaded.clear();
  loadErrors.clear();
  for (const name of enabledPlugins()) {
    const file = entryFor(name);
    if (!fs.existsSync(file)) { loadErrors.set(name, 'enabled, but ~/.conduit/plugins/' + name + '/plugin.mjs does not exist'); continue; }
    try {
      // A query string defeats the module cache, so a reload picks up edits.
      const mod = await import(pathToFileURL(file).href + `?v=${Date.now()}`);
      const plugin = (mod.default || mod) as PluginModule;
      if (plugin.onEvent !== undefined && typeof plugin.onEvent !== 'function') throw new Error('onEvent must be a function');
      loaded.set(name, plugin);
    } catch (err) {
      loadErrors.set(name, (err as Error).message);
    }
  }
  return listPlugins();
}

export function listPlugins(): PluginInfo[] {
  const enabled = new Set(enabledPlugins());
  const names = new Set([...discoverPlugins(), ...enabled]);
  return [...names].sort().map((name) => ({
    name,
    enabled: enabled.has(name),
    loaded: loaded.has(name),
    ...(loadErrors.has(name) ? { error: loadErrors.get(name) } : {}),
  }));
}

/** Whether any plugin is loaded — lets callers skip building an event copy. */
export function hasPlugins(): boolean {
  return loaded.size > 0;
}

/** Hand an event to every loaded plugin. Synchronous, isolated, never awaited. */
export function emitToPlugins(event: Record<string, unknown>): void {
  for (const [name, plugin] of loaded) {
    if (!plugin.onEvent) continue;
    try {
      const r = plugin.onEvent(event);
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        (r as Promise<unknown>).catch((err) => console.warn(`[plugins] ${name}: ${(err as Error)?.message || err}`));
      }
    } catch (err) {
      console.warn(`[plugins] ${name}: ${(err as Error)?.message || err}`);
    }
  }
}
