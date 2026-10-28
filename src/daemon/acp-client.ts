/**
 * acp-client.ts — a client for the Agent Client Protocol (ACP).
 *
 * ACP is JSON-RPC 2.0 as newline-delimited JSON over an agent's stdin/stdout:
 * the protocol Zed uses to drive outside agents, and the one `localharness acp`
 * serves. This module is transport only — spawn, request/response correlation,
 * notification fan-out, and answering the agent's requests back to us (a
 * permission prompt is one). What a session *means* is layered on top, in
 * localharness-agents.ts and the Keeper.
 *
 * It differs from codex-server.ts in three ways that ACP forces:
 *   - one process per session (an ACP agent may refuse a second `session/new`),
 *     so this is a connection object rather than a shared singleton;
 *   - the agent's requests are answered asynchronously — a permission request
 *     waits for a human, which can take minutes;
 *   - `session/prompt` stays open for the whole turn, so requests take a
 *     per-call timeout and the prompt is sent without one.
 *
 * The agent's stdout is the protocol channel and nothing else; its logs go to
 * stderr. The tail of stderr is kept because that is where an agent explains
 * why it would not start.
 */

import { spawn, type ChildProcess } from 'child_process';

export interface AcpProcessOptions {
  /** Executable to run. Resolve it first — see `shell`. */
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * Run through the platform shell. Needed only for a `.cmd` / `.bat` shim on
   * Windows; a real executable should be spawned directly, so that killing it
   * kills the agent rather than an intermediate cmd.exe.
   */
  shell?: boolean;
  /** Prefix for log lines. */
  label?: string;
  /**
   * While a request to the agent is outstanding, write a bare newline to its
   * stdin this often (ms); 0 disables it. Defaults to 1000 on Windows, 0
   * elsewhere — see `keepAwake` for why.
   */
  keepAwakeMs?: number;
}

/** Answer one request the agent sent us. Return the JSON-RPC `result`. */
export type AcpRequestHandler = (method: string, params: Record<string, any>) => unknown | Promise<unknown>;
type NotificationListener = (method: string, params: Record<string, any>) => void;
type ExitListener = (code: number | null, signal: string | null) => void;

/** A JSON-RPC error the agent returned, or a transport failure. */
export class AcpError extends Error {
  // Plain fields, not parameter properties: the test suites load this file
  // with --experimental-strip-types, which cannot emit those.
  readonly code?: number;
  readonly data?: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
  }
}

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Quick requests (`initialize`, `session/new`, `session/set_mode`). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** How much of the agent's stderr to keep for error messages. */
const STDERR_TAIL_CHARS = 8_000;

/** JSON-RPC error codes we send back. */
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export class AcpConnection {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private buf = '';
  private stderr = '';
  private exited = false;
  private wakeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private requestHandler: AcpRequestHandler = (method) => {
    throw new AcpError(`Method not supported by this client: ${method}`, METHOD_NOT_FOUND);
  };

  private readonly opts: AcpProcessOptions;

  constructor(opts: AcpProcessOptions) {
    this.opts = opts;
  }

  private get label(): string {
    return this.opts.label || 'acp';
  }

  /** Spawn the agent. Resolves once the process exists; rejects if it cannot be spawned. */
  start(): Promise<void> {
    if (this.proc) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let proc: ChildProcess;
      try {
        proc = spawn(this.opts.command, this.opts.args, {
          cwd: this.opts.cwd,
          env: this.opts.env,
          shell: this.opts.shell ?? false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(new AcpError(`Could not start ${this.opts.command}: ${(err as Error).message}`));
        return;
      }
      this.proc = proc;

      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (d: string) => this.onStdout(d));
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (d: string) => {
        this.stderr = (this.stderr + d).slice(-STDERR_TAIL_CHARS);
      });
      // A write after the agent died raises EPIPE on stdin; the exit handler
      // already reports the death, so the stream error itself is noise.
      proc.stdin?.on('error', () => { /* reported via exit */ });

      proc.once('spawn', () => {
        settled = true;
        resolve();
      });
      proc.once('error', (err) => {
        if (!settled) {
          settled = true;
          this.proc = null;
          reject(new AcpError(`Could not start ${this.opts.command}: ${err.message}`));
        } else {
          console.warn(`[${this.label}] process error:`, err.message);
        }
      });
      proc.once('exit', (code, signal) => this.handleExit(code, signal));
    });
  }

  isRunning(): boolean {
    return this.proc !== null && !this.exited;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** The last few KB the agent wrote to stderr — where it explains a failed start. */
  stderrTail(): string {
    return this.stderr;
  }

  /** Install the handler for the agent's requests to us (permissions, fs). */
  onRequest(handler: AcpRequestHandler): void {
    this.requestHandler = handler;
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Send a request. `timeoutMs: 0` waits indefinitely — use it for
   * `session/prompt`, which only answers when the whole turn is over.
   */
  request(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<any> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.isRunning() || !this.proc?.stdin?.writable) {
        reject(new AcpError(`${this.label}: agent is not running (${method})`));
        return;
      }
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          this.keepAwake();
          reject(new AcpError(`${this.label}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs)
        : null;
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
      this.keepAwake();
    });
  }

  /**
   * Keep the agent's stdin supplied while we wait on it — a workaround for a
   * Windows deadlock, measured against LocalHarness 0.22.0.
   *
   * An ACP agent reads stdin on a thread that sits in a blocking ReadFile. On
   * Windows, synchronous I/O on one file object is serialised, so another
   * thread that touches the same handle while loading a DLL waits for that
   * read to finish. LocalHarness hits this on its first prompt, when its
   * memory plugin imports numpy: the import hung inside the C-extension load
   * until something arrived on stdin. A client waiting for the reply sends
   * nothing, so the session never came up — the turn hung forever with
   * "Starting the session — 2s so far…" and no request reached the model.
   * Writing to stdin once a second released it every time.
   *
   * A bare newline is data but not a message: JSON-RPC over newline-delimited
   * stdio skips blank lines. (A `$/…` notification also worked, but
   * LocalHarness logs every unknown notification as an error.) It runs only
   * while a request is outstanding, so an idle agent is left alone.
   */
  private keepAwake(): void {
    const every = this.opts.keepAwakeMs ?? (process.platform === 'win32' ? 1000 : 0);
    const want = every > 0 && this.pending.size > 0 && !this.exited;
    if (want && !this.wakeTimer) {
      this.wakeTimer = setInterval(() => this.poke(), every);
      this.wakeTimer.unref?.();
    } else if (!want && this.wakeTimer) {
      clearInterval(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  /** Send a notification (no reply), e.g. `session/cancel`. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Write a bare newline: data on stdin that is not a message. See `keepAwake`. */
  poke(): void {
    const stdin = this.proc?.stdin;
    if (!stdin || !stdin.writable || this.exited) return;
    try { stdin.write('\n'); } catch { /* reported via exit */ }
  }

  /**
   * Close the connection. Ending stdin is the polite stop — an ACP agent tears
   * its session down on EOF — and the kill after `graceMs` is the guarantee.
   */
  close(graceMs = 2_000): void {
    const proc = this.proc;
    if (!proc || this.exited) return;
    try { proc.stdin?.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => {
      if (!this.exited) killTree(proc);
    }, graceMs);
    timer.unref?.();
  }

  /** Kill the agent now, with its whole process tree. */
  kill(): void {
    if (this.proc && !this.exited) killTree(this.proc);
  }

  // ─────────────────────────── wire ───────────────────────────

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not ours to interpret. An agent that prints to stdout has corrupted
      // its own channel; say so once per line rather than crash.
      console.warn(`[${this.label}] non-JSON line on the protocol channel: ${line.slice(0, 200)}`);
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;

    // A response to one of our requests.
    if (hasId && (msg.result !== undefined || msg.error !== undefined) && typeof msg.method !== 'string') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      this.keepAwake();
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new AcpError(
          msg.error.message || `${p.method} failed (${msg.error.code})`,
          msg.error.code,
          msg.error.data,
        ));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // A request from the agent: answer it with the same id, however long it takes.
    if (hasId && typeof msg.method === 'string') {
      void this.answer(msg.id, msg.method, msg.params || {});
      return;
    }

    // A notification.
    if (typeof msg.method === 'string') {
      for (const l of this.notificationListeners) {
        try { l(msg.method, msg.params || {}); }
        catch (err) { console.error(`[${this.label}] notification listener error:`, err); }
      }
    }
  }

  private async answer(id: number | string, method: string, params: Record<string, any>): Promise<void> {
    try {
      const result = await this.requestHandler(method, params);
      this.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (err) {
      const code = err instanceof AcpError && err.code ? err.code : INTERNAL_ERROR;
      this.send({ jsonrpc: '2.0', id, error: { code, message: (err as Error).message || String(err) } });
    }
  }

  private send(obj: Record<string, unknown>): void {
    const stdin = this.proc?.stdin;
    if (!stdin || !stdin.writable || this.exited) return;
    try { stdin.write(JSON.stringify(obj) + '\n'); }
    catch (err) { console.error(`[${this.label}] write error:`, err); }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    if (this.wakeTimer) { clearInterval(this.wakeTimer); this.wakeTimer = null; }
    const tail = this.stderr.trim().split('\n').slice(-5).join('\n');
    const why = `${this.label}: agent exited (code ${code ?? 'none'}${signal ? `, ${signal}` : ''})`
      + (tail ? `\n${tail}` : '');
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new AcpError(why));
    }
    this.pending.clear();
    for (const l of this.exitListeners) {
      try { l(code, signal); } catch (err) { console.error(`[${this.label}] exit listener error:`, err); }
    }
  }
}

/**
 * Kill a child with everything it started. On Windows that is `taskkill /T`:
 * `child.kill()` ends only the top process, and an agent's MCP servers and
 * model calls are its children.
 */
function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => { try { proc.kill(); } catch { /* gone */ } });
    } catch {
      try { proc.kill(); } catch { /* gone */ }
    }
    return;
  }
  try { proc.kill('SIGTERM'); } catch { /* gone */ }
  const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 2_500);
  timer.unref?.();
}
