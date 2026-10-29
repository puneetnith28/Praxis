import { spawn, ChildProcess, execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';

export interface ServiceStatus {
  ready: boolean;
  port: number;
  /** How far startup got — used to phrase the error page. */
  phase: 'spawned' | 'server-up' | 'ready' | 'attached' | 'failed';
  /** Populated whenever `ready` is false. */
  error?: string;
  /** Tail of child stderr, for the error page. */
  log?: string;
  /** True when we attached to a Conduit already running (e.g. `npm run start:all`). */
  attached?: boolean;
}

const PORT = 3200;
/** Cold start pulls in the AWS/Strands/MCP SDKs from an uncached node_modules. */
const READY_TIMEOUT_MS = 45_000;
/** After the web server answers, how long to wait for it to reach the daemon. */
const DAEMON_TIMEOUT_MS = 20_000;

/**
 * Owns the two Node services the desktop app fronts: the daemon (agent PTYs)
 * and the Express web server (UI + API). They run as separate processes
 * because both call `process.exit()` on a port conflict and install their own
 * signal handlers — in-process, either would take the whole GUI down.
 */
export class DaemonManager {
  private daemonProcess: ChildProcess | null = null;
  private serverProcess: ChildProcess | null = null;
  private isShuttingDown = false;
  private attached = false;
  /** Ring buffer of child stderr so a failure can be explained to the user. */
  private readonly errorLog: string[] = [];

  private note(line: string): void {
    for (const l of line.split('\n')) {
      const t = l.trimEnd();
      if (!t) continue;
      this.errorLog.push(t);
      if (this.errorLog.length > 60) this.errorLog.shift();
    }
  }

  private log(): string {
    return this.errorLog.join('\n');
  }

  /**
   * Start (or attach to) the backend.
   *
   * `distRoot` is the built `dist/` directory — main.mjs lives at
   * `dist/electron/main.mjs` in both dev and packaged builds, so the caller
   * derives this from `__dirname` rather than `process.cwd()` or
   * `app.getAppPath()`, neither of which is reliable in both.
   */
  public async startServices(distRoot: string): Promise<ServiceStatus> {
    // Already running (a dev `npm run start:all`, or a previous instance whose
    // children outlived it)? Use it instead of fighting over the port.
    const existing = await this.probeHealth(PORT);
    if (existing.ok) {
      this.attached = true;
      return { ready: true, port: PORT, phase: 'attached', attached: true };
    }
    if (existing.occupied) {
      return {
        ready: false, port: PORT, phase: 'failed',
        error: `Port ${PORT} is in use by another application, and it is not Bedrock. Close it and restart.`,
      };
    }

    const daemonScript = path.join(distRoot, 'src', 'daemon', 'daemon.mjs');
    const serverScript = path.join(distRoot, 'src', 'server.mjs');
    for (const s of [daemonScript, serverScript]) {
      if (!fs.existsSync(s)) {
        return {
          ready: false, port: PORT, phase: 'failed',
          error: `Missing backend file: ${s}\nThe app was packaged without a complete build. Run \`npm run build\`.`,
        };
      }
    }

    this.daemonProcess = this.spawnService('Daemon', daemonScript, {});
    this.serverProcess = this.spawnService('Server', serverScript, {
      PORT: String(PORT),
      HOST: '127.0.0.1',
    });

    return this.waitForReady();
  }

  private spawnService(label: string, script: string, extraEnv: Record<string, string>): ChildProcess {
    // ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node, so
    // the packaged app needs no separate Node install.
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      console.log(`[${label}] ${s.trimEnd()}`);
      this.note(s);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      console.error(`[${label} ERR] ${s.trimEnd()}`);
      this.note(s);
    });
    child.on('error', (err) => this.note(`${label} failed to spawn: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (!this.isShuttingDown) this.note(`${label} exited early (code ${code}, signal ${signal})`);
    });

    return child;
  }

  /** True once either child has exited — lets us fail fast instead of waiting out the timeout. */
  private childDied(): string | null {
    if (this.daemonProcess?.exitCode != null) return `The daemon exited with code ${this.daemonProcess.exitCode}.`;
    if (this.serverProcess?.exitCode != null) return `The web server exited with code ${this.serverProcess.exitCode}.`;
    return null;
  }

  /**
   * Two phases: the web server must answer `/api/health` with `ok`, then it
   * must report `daemon: true` — that second flag is what actually predicts
   * working terminals. Probing `/` instead would pass on the plain-text
   * "UI is not built yet" page.
   */
  private async waitForReady(): Promise<ServiceStatus> {
    const started = Date.now();
    let serverUpAt = 0;

    while (!this.isShuttingDown) {
      const died = this.childDied();
      if (died) {
        return { ready: false, port: PORT, phase: 'failed', error: died, log: this.log() };
      }

      const health = await this.probeHealth(PORT);
      if (health.ok) {
        if (!serverUpAt) serverUpAt = Date.now();
        if (health.daemon) return { ready: true, port: PORT, phase: 'ready' };
        if (Date.now() - serverUpAt > DAEMON_TIMEOUT_MS) {
          return {
            ready: false, port: PORT, phase: 'server-up',
            error: 'The web server started but never connected to the agent daemon, so terminals would not work.',
            log: this.log(),
          };
        }
      } else if (Date.now() - started > READY_TIMEOUT_MS) {
        return {
          ready: false, port: PORT, phase: 'failed',
          error: `The Bedrock backend did not start within ${READY_TIMEOUT_MS / 1000}s.`,
          log: this.log(),
        };
      }

      await new Promise((r) => setTimeout(r, 400));
    }

    return { ready: false, port: PORT, phase: 'failed', error: 'Startup cancelled.' };
  }

  /** GET /api/health. `occupied` means something answered but it isn't Conduit. */
  private probeHealth(port: number): Promise<{ ok: boolean; daemon: boolean; occupied: boolean }> {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/health', timeout: 1500 },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; if (body.length > 8192) res.destroy(); });
          res.on('end', () => {
            // 401 means Conduit is there but password-protected — still ours.
            if (res.statusCode === 401) { resolve({ ok: true, daemon: true, occupied: false }); return; }
            try {
              const j = JSON.parse(body);
              if (j && j.ok === true) { resolve({ ok: true, daemon: !!j.daemon, occupied: false }); return; }
            } catch { /* not JSON — not us */ }
            resolve({ ok: false, daemon: false, occupied: true });
          });
        },
      );
      req.on('error', () => resolve({ ok: false, daemon: false, occupied: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, daemon: false, occupied: true }); });
    });
  }

  /**
   * Stop the children. On Windows `kill('SIGTERM')` maps to TerminateProcess,
   * which does NOT run the daemon's shutdown handler — so every agent it
   * spawned would be orphaned. Kill the whole tree there instead.
   */
  public stopServices(): void {
    this.isShuttingDown = true;
    if (this.attached) return; // we didn't start it; don't kill someone else's

    for (const child of [this.serverProcess, this.daemonProcess]) {
      if (!child?.pid) continue;
      if (process.platform === 'win32') {
        try {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => { /* best-effort */ });
        } catch { /* ignore */ }
      } else {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
    this.serverProcess = null;
    this.daemonProcess = null;
  }
}
