/**
 * The API `electron/preload.ts` exposes on `window` when Conduit runs inside
 * the desktop shell. It is absent in a browser, so every use must be guarded
 * (`window.conduitDesktop?.…`).
 */
export interface DaemonStatus {
  ready: boolean;
  port: number;
  phase?: string;
  error?: string;
  log?: string;
  attached?: boolean;
}

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

declare global {
  interface Window {
    conduitDesktop?: ConduitDesktopAPI;
  }
}

export {};
