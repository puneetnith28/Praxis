/**
 * The Keeper on LocalHarness — a third Keeper engine beside Codex and Claude
 * Code, for running Bedrock's orchestrator on a local model.
 *
 * One long-lived `localharness acp` session per conversation, in the Keeper's
 * own brain directory, with Bedrock's org MCP server (conduit-mcp-server)
 * attached through its LocalHarness config dir. The persona is the brain
 * directory's AGENTS.md, which LocalHarness reads as its instructions file.
 *
 * Permissions: the session runs in LocalHarness's `auto` mode — calls on its
 * blacklist (deletes outside the project, force pushes, sudo, curl | sh, …)
 * are parked, never run. That is stricter than the Claude engine's
 * bypassPermissions. The one question answered here is workspace trust for
 * the brain directory, which Bedrock owns; anything else the session asks is
 * refused, because the Keeper has nobody to ask on its behalf.
 */
import { AcpConnection } from './acp-client.js';
import { findOnPath } from '../cli-registry.js';
import { listLocalModels, localLlmSettings, pickModel } from '../local-llm.js';
import { prepareConfigDir, localHarnessEnv, type LocalHarnessMcpServer } from '../localharness/config-dir.js';

export interface KeeperSink {
  append(role: 'assistant' | 'tool' | 'reasoning' | 'system' | 'error', text: string, tool?: string): void;
}

export interface KeeperPrepared {
  binary: string;
  binaryArgs: string[];
  shell: boolean;
}

export interface LocalHarnessKeeperOptions {
  brainDir: string;
  mcp: LocalHarnessMcpServer;
  /** Test seam: skip the model-server probe and init, run this instead. */
  prepare?: () => Promise<KeeperPrepared>;
  turnTimeoutMs?: number;
}

/** The config dir id the Keeper's LocalHarness uses (~/.conduit/localharness/keeper). */
export const KEEPER_CONFIG_ID = 'keeper';
const TRUST = /^Trust this workspace/;

export class LocalHarnessKeeper {
  private conn: AcpConnection | null = null;
  private sessionId = '';
  private convId = '';
  private readonly opts: LocalHarnessKeeperOptions;

  constructor(opts: LocalHarnessKeeperOptions) {
    this.opts = opts;
  }

  /** Is `localharness` installed? (The Keeper's auto engine choice asks this.) */
  static available(): boolean {
    return !!findOnPath('localharness');
  }

  private async defaultPrepare(): Promise<KeeperPrepared> {
    const settings = localLlmSettings();
    const probe = await listLocalModels(settings);
    if (!probe.ok) throw new Error(probe.error);
    const model = pickModel(settings, probe);
    if (!model) throw new Error(`The model server at ${settings.baseUrl} serves no model — pull one first.`);
    const binary = findOnPath('localharness');
    if (!binary) throw new Error('LocalHarness is not installed. Install it with:  uv tool install localharness');
    await prepareConfigDir(KEEPER_CONFIG_ID, { binary, baseUrl: settings.baseUrl, model, mcp: this.opts.mcp });
    return { binary, binaryArgs: [], shell: /\.(cmd|bat)$/i.test(binary) };
  }

  private async ensureSession(convId: string): Promise<void> {
    if (this.conn?.isRunning() && this.convId === convId) return;
    this.stop();
    const prepared = await (this.opts.prepare ? this.opts.prepare() : this.defaultPrepare());
    const conn = new AcpConnection({
      command: prepared.binary,
      args: [...prepared.binaryArgs, 'acp'],
      cwd: this.opts.brainDir,
      env: { ...process.env, ...localHarnessEnv(KEEPER_CONFIG_ID) },
      shell: prepared.shell,
      label: 'keeper:localharness',
    });
    conn.onRequest(async (method, params) => {
      if (method !== 'session/request_permission') throw new Error(`Bedrock does not serve ${method}`);
      const title = String(params.toolCall?.title || '');
      const options: Array<{ optionId: string; kind: string }> = Array.isArray(params.options) ? params.options : [];
      // Its own private brain directory is the one thing the Keeper may trust.
      const trust = TRUST.test(title) ? options.find((o) => String(o.kind).startsWith('allow')) : undefined;
      return trust
        ? { outcome: { outcome: 'selected', optionId: trust.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    });
    await conn.start();
    await conn.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'bedrock-keeper', title: 'Bedrock Keeper', version: '1.0.0' },
    });
    const created = await conn.request('session/new', { cwd: this.opts.brainDir, mcpServers: [] });
    this.sessionId = String(created?.sessionId || '');
    const modes: Array<{ id: string }> = created?.modes?.availableModes || [];
    if (created?.modes?.currentModeId !== 'auto' && modes.some((m) => m.id === 'auto')) {
      await conn.request('session/set_mode', { sessionId: this.sessionId, modeId: 'auto' });
    }
    this.conn = conn;
    this.convId = convId;
  }

  /** One Keeper turn: the reply and the tools it used go to `sink`. */
  async runTurn(convId: string, prompt: string, sink: KeeperSink): Promise<void> {
    try {
      await this.ensureSession(convId);
    } catch (err) {
      sink.append('error', `The Keeper could not start on LocalHarness: ${(err as Error).message}`);
      this.stop();
      return;
    }
    const conn = this.conn!;
    let text = '';
    const tools = new Map<string, string>();
    const off = conn.onNotification((method, params) => {
      if (method !== 'session/update' || params.sessionId !== this.sessionId) return;
      const u = params.update || {};
      if (u.sessionUpdate === 'agent_message_chunk' && typeof u.content?.text === 'string') {
        // Bring-up progress is not part of the answer.
        if (!/^Starting the session — \d+s so far…\s*$/.test(u.content.text)) text += u.content.text;
      } else if (u.sessionUpdate === 'tool_call') {
        tools.set(String(u.toolCallId), String(u.title || 'tool'));
      } else if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) {
        const title = tools.get(String(u.toolCallId)) || 'tool';
        sink.append('tool', `${u.status === 'failed' ? 'failed: ' : ''}${title}`, title);
      }
    });
    const timeoutMs = this.opts.turnTimeoutMs ?? 5 * 60 * 1000;
    const guard = setTimeout(() => { this.abort(); }, timeoutMs);
    try {
      const res = await conn.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] }, { timeoutMs: 0 });
      const stop = String(res?.stopReason || 'end_turn');
      if (text.trim()) sink.append(/^The session could not be started/.test(text) ? 'error' : 'assistant', text.trim());
      if (stop === 'cancelled') sink.append('system', 'The Keeper turn was cancelled.');
      else if (!text.trim()) sink.append('error', 'The Keeper turn ended without an answer.');
    } catch (err) {
      sink.append('error', `The Keeper on LocalHarness failed: ${(err as Error).message}`);
      this.stop();
    } finally {
      clearTimeout(guard);
      off();
    }
  }

  /** Cancel the running turn. */
  abort(): boolean {
    if (!this.conn?.isRunning() || !this.sessionId) return false;
    this.conn.notify('session/cancel', { sessionId: this.sessionId });
    return true;
  }

  /** End the session (new conversation, switch, shutdown). */
  stop(): void {
    if (this.conn) this.conn.close(1_500);
    this.conn = null;
    this.sessionId = '';
    this.convId = '';
  }
}
