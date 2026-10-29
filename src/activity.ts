import { watch, type FSWatcher } from 'chokidar';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { sharedDirFor } from './storage.js';
import type { ActivityEvent } from './types.js';

const MAX_EVENTS = 200;
const events: ActivityEvent[] = [];
/**
 * Live watchers, with the directory each one is actually watching.
 *
 * A project's name is its folder name, so renaming a project moves the
 * directory. Keying on id alone meant `watchProject(id, newName)` saw the id
 * already present and returned — leaving the watcher pointed at a path that no
 * longer exists, silently, so file changes stopped being reported for that
 * project. Callers that re-register in bulk (the `org:changed` handler) relied
 * on this being safe.
 */
const watchers = new Map<string, { watcher: FSWatcher; dir: string }>();

let broadcastFn: ((event: ActivityEvent) => void) | null = null;

export function setBroadcast(fn: (event: ActivityEvent) => void) {
  broadcastFn = fn;
}

export function pushEvent(detail: Omit<ActivityEvent, 'id' | 'timestamp'>) {
  const full: ActivityEvent = {
    ...detail,
    id: uuid(),
    timestamp: new Date().toISOString(),
  };
  events.push(full);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  broadcastFn?.(full);

  // Append to the global activity log
  try {
    const logPath = path.join(os.homedir(), '.conduit', 'activity.jsonl');
    fs.appendFile(logPath, JSON.stringify(full) + '\n', (err: NodeJS.ErrnoException | null) => {
      if (err) console.error('[activity] Error writing to log:', err);
    });
  } catch (err: unknown) {
    console.error('[activity] Error appending to log:', err);
  }
}

export function getEvents(projectId?: string): ActivityEvent[] {
  if (projectId) return events.filter(e => e.projectId === projectId);
  return [...events];
}

/**
 * Start watching a project's shared content directory for file changes.
 */
export function watchProject(projectId: string, projectName: string) {
  const dir = sharedDirFor(projectName);
  const existing = watchers.get(projectId);
  if (existing) {
    // Same directory — nothing to do. A different one means the project was
    // renamed and the old watcher is now watching nothing.
    if (existing.dir === dir) return;
    console.log(`[activity] Project ${projectId} moved: ${existing.dir} → ${dir}`);
    unwatchProject(projectId);
  }

  fs.mkdirSync(dir, { recursive: true });

  console.log(`[activity] Watching shared content: ${dir}`);

  const watcher = watch(dir, {
    ignoreInitial: true,
    // Allow nested subfolders (up to 5 levels deep to avoid runaway watchers on symlink loops)
    depth: 5,
  });

  // Convert full filesystem path to shared-content-relative path with forward slashes
  const toRelative = (filePath: string): string =>
    path.relative(dir, filePath).replace(/\\/g, '/');

  // Skip hidden files/folders at any level (e.g. ".git", "subfolder/.DS_Store")
  const isHidden = (relPath: string): boolean =>
    relPath.split('/').some(seg => seg.startsWith('.'));

  watcher.on('add', (filePath: string) => {
    const rel = toRelative(filePath);
    if (!rel || isHidden(rel)) return;
    console.log(`[activity] File created: ${rel}`);
    pushEvent({
      projectId,
      event: 'content:created',
      detail: `File created: ${rel}`,
    });
  });

  watcher.on('change', (filePath: string) => {
    const rel = toRelative(filePath);
    if (!rel || isHidden(rel)) return;
    console.log(`[activity] File modified: ${rel}`);
    pushEvent({
      projectId,
      event: 'content:modified',
      detail: `File modified: ${rel}`,
    });
  });

  watcher.on('unlink', (filePath: string) => {
    const rel = toRelative(filePath);
    if (!rel || isHidden(rel)) return;
    console.log(`[activity] File deleted: ${rel}`);
    pushEvent({
      projectId,
      event: 'content:deleted',
      detail: `File deleted: ${rel}`,
    });
  });

  watcher.on('error', (err: any) => {
    console.error(`[activity] Watcher error for ${projectName}:`, err);
  });

  watchers.set(projectId, { watcher, dir });
}

export function unwatchProject(projectId: string) {
  const entry = watchers.get(projectId);
  if (entry) {
    entry.watcher.close();
    watchers.delete(projectId);
  }
}
