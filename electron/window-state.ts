import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow, Rectangle } from 'electron';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

export interface DisplayLike {
  bounds: Rectangle;
  workArea?: Rectangle;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 860;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

export function getDefaultWindowState(): WindowState {
  return {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
}

export function getDefaultConfigPath(): string {
  return path.join(os.homedir(), '.conduit', 'window-state.json');
}

/**
 * Validate that saved window coordinates are visible within at least one connected display.
 * If the saved position is off-screen (e.g., disconnected monitor), falls back to default.
 */
export function validateBounds(state: WindowState, displays: DisplayLike[]): WindowState {
  const width = Math.max(state.width || DEFAULT_WIDTH, MIN_WIDTH);
  const height = Math.max(state.height || DEFAULT_HEIGHT, MIN_HEIGHT);

  if (state.x === undefined || state.y === undefined || displays.length === 0) {
    return { width, height, isMaximized: !!state.isMaximized };
  }

  // Check if at least 100x100 pixels of the window are visible in any display
  const isVisible = displays.some((d) => {
    const area = d.workArea || d.bounds;
    return (
      state.x! + 100 > area.x &&
      state.x! < area.x + area.width &&
      state.y! + 100 > area.y &&
      state.y! < area.y + area.height
    );
  });

  if (!isVisible) {
    return { width, height, isMaximized: !!state.isMaximized };
  }

  return {
    width,
    height,
    x: state.x,
    y: state.y,
    isMaximized: !!state.isMaximized,
  };
}

/**
 * Synchronously load saved window state, returning defaults if not found or corrupted.
 */
export function loadWindowState(configPath = getDefaultConfigPath()): WindowState {
  try {
    if (!fs.existsSync(configPath)) return getDefaultWindowState();
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return {
        width: typeof parsed.width === 'number' ? parsed.width : DEFAULT_WIDTH,
        height: typeof parsed.height === 'number' ? parsed.height : DEFAULT_HEIGHT,
        x: typeof parsed.x === 'number' ? parsed.x : undefined,
        y: typeof parsed.y === 'number' ? parsed.y : undefined,
        isMaximized: !!parsed.isMaximized,
      };
    }
  } catch {
    /* ignore and use defaults */
  }
  return getDefaultWindowState();
}

/**
 * Save window state to config file.
 */
export function saveWindowState(state: WindowState, configPath = getDefaultConfigPath()): void {
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    /* best effort */
  }
}

/**
 * Attach listeners to a BrowserWindow to save window dimensions and position when resized or moved.
 */
export function trackWindowState(win: BrowserWindow, configPath = getDefaultConfigPath()): () => void {
  let debounceTimer: NodeJS.Timeout | null = null;

  const update = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        if (win.isDestroyed()) return;
        const isMaximized = win.isMaximized();
        if (isMaximized) {
          saveWindowState({ ...loadWindowState(configPath), isMaximized: true }, configPath);
          return;
        }
        const bounds = win.getBounds();
        saveWindowState({
          width: bounds.width,
          height: bounds.height,
          x: bounds.x,
          y: bounds.y,
          isMaximized: false,
        }, configPath);
      } catch {
        /* window might be closing */
      }
    }, 250);
  };

  win.on('resize', update);
  win.on('move', update);
  win.on('close', update);

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    try {
      win.removeListener('resize', update);
      win.removeListener('move', update);
      win.removeListener('close', update);
    } catch {}
  };
}
