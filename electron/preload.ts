import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export interface DaemonStatus {
  ready: boolean;
  port: number;
  phase?: string;
  error?: string;
  log?: string;
  attached?: boolean;
}

/** Unsubscribe function returned by every `on*` listener. */
export type Unsubscribe = () => void;

export interface ConduitDesktopAPI {
  isDesktop: boolean;
  platform: string;
  selectDirectory: () => Promise<string | null>;
  showNotification: (title: string, body: string) => void;
  getAppVersion: () => Promise<string>;
  getDaemonStatus: () => Promise<DaemonStatus | null>;
  onDaemonStatus: (cb: (status: DaemonStatus) => void) => Unsubscribe;
  onToggleKeeper: (cb: () => void) => Unsubscribe;
  onToggleVoice: (cb: () => void) => Unsubscribe;
  onFocusTerminal: (cb: () => void) => Unsubscribe;
  onProjectOpened: (cb: (dir: string) => void) => Unsubscribe;
}

/**
 * Subscribe to a main→renderer channel and hand back an unsubscribe, so React
 * effects can clean up. Without this, every hot reload / remount stacked
 * another listener and Electron eventually warned about a leak.
 */
function subscribe<T extends unknown[]>(
  channel: string,
  cb: (...args: T) => void,
): Unsubscribe {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const desktopAPI: ConduitDesktopAPI = {
  isDesktop: true,
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke('conduit:select-directory'),
  showNotification: (title, body) => { ipcRenderer.send('conduit:notification', { title, body }); },
  getAppVersion: () => ipcRenderer.invoke('conduit:get-version'),
  getDaemonStatus: () => ipcRenderer.invoke('conduit:get-daemon-status'),
  onDaemonStatus: (cb) => subscribe<[DaemonStatus]>('conduit:daemon-status', cb),
  onToggleKeeper: (cb) => subscribe<[]>('conduit:toggle-keeper', cb),
  onToggleVoice: (cb) => subscribe<[]>('conduit:toggle-voice', cb),
  onFocusTerminal: (cb) => subscribe<[]>('conduit:focus-terminal', cb),
  onProjectOpened: (cb) => subscribe<[string]>('conduit:project-opened', cb),
};

contextBridge.exposeInMainWorld('conduitDesktop', desktopAPI);
