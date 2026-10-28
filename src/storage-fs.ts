import fs from 'fs';
import path from 'path';

/** Counter ensuring temporary file names within this process are unique. */
let tmpCounter = 0;

/** Ensure directory exists synchronously. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Sleep without spinning from synchronous code.
 * Uses Atomics.wait to properly block the thread without starving CPU cores.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename a temporary file over a destination with an exponential backoff retry ladder.
 * Handles Windows EPERM / EBUSY / EACCES lock contention caused by concurrent readers.
 */
export function renameWithRetry(tmp: string, file: string): void {
  const delays = [0, 2, 5, 10, 20, 40, 80, 150, 250, 400];
  for (let i = 0; i < delays.length; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const contended = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!contended || i === delays.length - 1) throw err;
      sleepSync(delays[i + 1]);
    }
  }
}

/**
 * Write a file atomically by writing to a process-unique temporary file and renaming it.
 * Unlinks the temporary file if rename or write fails.
 */
export function writeFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${tmpCounter++}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, 'utf-8');
    renameWithRetry(tmp, file);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

/**
 * Serialize data to JSON and write atomically.
 */
export function writeJsonAtomic(file: string, data: unknown, pretty = true): void {
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileAtomic(file, content);
}

/**
 * Read and parse JSON synchronously, returning null on missing or unparseable files.
 */
export function readJsonSync<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/**
 * Append a JSON object as a single line to a JSONL file.
 */
export function appendJsonlSync(file: string, entry: unknown): void {
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Sanitize project name for safe filesystem paths.
 * Strips directory separators, parent path segments, control characters, and leading dots.
 */
export function safeProjectName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'project';
}

/**
 * Resolve `rel` inside `base` and reject anything that escapes it (path traversal).
 * Returns null when the path is not safely inside `base`.
 */
export function resolveInside(base: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) return null;
  if (rel.includes('\0')) return null;
  const normalized = rel.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split('/').some((seg) => seg.length > 255)) return null;

  const full = path.resolve(base, normalized);
  const root = path.resolve(base);
  if (full === root) return null;
  const relBack = path.relative(root, full);
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) return null;
  if (process.platform === 'win32' && full.length > 250) return null;
  return full;
}
