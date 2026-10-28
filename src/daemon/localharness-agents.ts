/**
 * localharness-agents.ts — LocalHarness agents as Agent Client Protocol sessions.
 *
 * Each agent is one `localharness acp` process with one session (LocalHarness
 * serves a single thread per process). Its `session/update` stream is mapped
 * onto the same `CodexItem`s Codex agents produce, so the existing structured
 * view renders it, and the Supervisor reads it through the same text form:
 *
 *   agent_message_chunk  → message (role agent), streamed into one item
 *   agent_thought_chunk  → reasoning
 *   tool_call (execute)  → command      tool_call (edit) → file
 *   tool_call (other)    → tool         tool_call_update → done / failed + output
 *   plan                 → system       current_mode_update → system
 *
 * Status is exact, not inferred: a `session/prompt` in flight is `running`;
 * its answer means the agent is waiting on the user (`awaiting_input`, which
 * the daemon turns into `idle` after a while).
 *
 * Prompts are queued: ACP runs one turn at a time, and a message injected by a
 * teammate mid-turn must not be lost or interleaved.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Agent, GateOption } from '../types.js';
import type { CodexItem } from './protocol.js';
import { AcpConnection } from './acp-client.js';
import { textListener } from './item-text.js';
import { getProjectData, updateAgent, wikiDirFor } from '../storage.js';
import {
  agentEnv, AgentStartError, ensureInstructionFile, ensureSharedDir, expandHome,
} from '../pty-manager.js';
import { instructionFileFor } from '../instruction-files.js';
import { localHarnessEnv } from '../localharness/config-dir.js';
import type { PreparedLocalHarness } from '../localharness/prepare.js';

type StatusFn = (agentId: string, status: string) => void;
type ItemListener = (item: CodexItem) => void;

/** The five permission modes LocalHarness offers over ACP. */
export const LOCALHARNESS_MODES = ['auto', 'guarded', 'trusted', 'unattended', 'read-only'] as const;
export type LocalHarnessMode = (typeof LOCALHARNESS_MODES)[number];

/**
 * Guarded: ask once about each new thing. Under Bedrock every ask becomes an
 * approval gate, which is the point of running the agent here. `auto` would
 * park its blacklisted calls as pending decisions and never raise a gate.
 */
export const DEFAULT_MODE: LocalHarnessMode = 'guarded';

export interface TurnResult {
  stopReason: string;
  /** Everything the agent said in this turn. */
  text: string;
  error?: string;
}

interface QueuedPrompt {
  text: string;
  /** Shown in the transcript; a teammate's message is shown as sent. */
  display: string;
  resolve: (r: TurnResult) => void;
}

interface Turn {
  texts: string[];
  /** The message / reasoning item now being streamed into, if any. */
  messageId: string | null;
  thoughtId: string | null;
  resolve: (r: TurnResult) => void;
}

/** ACP's answer to a permission request. */
type PermissionOutcome = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } };

/** A permission request the agent is waiting on; its JSON-RPC reply is `resolve`. */
interface PendingPermission {
  title: string;
  options: GateOption[];
  prompt: string;
  resolve: (o: PermissionOutcome) => void;
}

/**
 * How a permission request becomes a Bedrock approval gate, installed by the
 * daemon (which owns broadcasting). Kept as an injected hook so this module
 * does not import the watcher, which imports the runtime router.
 */
export interface PermissionHandlers {
  /** Raise the gate. False when it could not be (the agent already has one). */
  raise(projectId: string, agentId: string, prompt: string, options: GateOption[]): boolean;
  /** The gate went away without a human answer (cancel, stop, crash). */
  cleared(projectId: string, agentId: string): void;
}

interface LhSession {
  agent: Agent;
  conn: AcpConnection;
  sessionId: string;
  items: CodexItem[];
  listeners: Set<ItemListener>;
  status: string;
  inputLine: string;
  queue: QueuedPrompt[];
  turn: Turn | null;
  /** ACP tool call id → item id. */
  toolItems: Map<string, string>;
  modes: Array<{ id: string; name: string; description?: string }>;
  mode: string;
  /** Slash commands the agent advertised (available_commands_update). */
  commands: Array<{ name: string; description?: string }>;
  model: string;
  stopping: boolean;
  /** Oldest first; only the head is raised as a gate. */
  permissions: PendingPermission[];
}

const MAX_ITEMS = 500;
let permissionHandlers: PermissionHandlers | null = null;

export function setPermissionHandlers(h: PermissionHandlers | null): void {
  permissionHandlers = h;
}

/** The opening of LocalHarness's BRINGUP_FAILED / BRINGUP_EXITED notices (channels/acp.py). */
const BRINGUP_FAILURE = /^The session could not be started/;
/**
 * Its BRINGUP_STATUS line, streamed as agent text every few seconds while the
 * first prompt waits for the session to come up. Progress, not a reply: shown
 * as one system line that updates in place, and never part of a turn's text —
 * otherwise ask_agent would return "Starting the session — 2s so far…" as the
 * agent's answer.
 */
const BRINGUP_STATUS = /^Starting the session — \d+s so far…\s*$/;
const sessions = new Map<string, LhSession>();
let onStatus: StatusFn = () => {};

const now = () => new Date().toISOString();

// ─────────────────────────── item store ───────────────────────────

function upsert(s: LhSession, item: CodexItem): void {
  const idx = s.items.findIndex((i) => i.id === item.id);
  if (idx >= 0) s.items[idx] = item;
  else {
    s.items.push(item);
    if (s.items.length > MAX_ITEMS) s.items.splice(0, s.items.length - MAX_ITEMS);
  }
  for (const l of s.listeners) {
    try { l(item); } catch (err) { console.error('[localharness] item listener error:', err); }
  }
}

function itemById(s: LhSession, id: string | null): CodexItem | undefined {
  return id ? s.items.find((i) => i.id === id) : undefined;
}

function system(s: LhSession, text: string): void {
  upsert(s, { id: randomUUID(), kind: 'system', text, ts: now() });
}

function setStatus(s: LhSession, status: string): void {
  if (s.status === status) return;
  s.status = status;
  onStatus(s.agent.id, status);
}

/** Close whatever message / reasoning item is streaming, so the next chunk starts a new one. */
function closeStreams(s: LhSession): void {
  const t = s.turn;
  if (!t) return;
  for (const id of [t.messageId, t.thoughtId]) {
    const it = itemById(s, id);
    if (it && it.status === 'running') upsert(s, { ...it, status: 'done' });
  }
  t.messageId = null;
  t.thoughtId = null;
}

// ─────────────────────────── ACP → items ───────────────────────────

/** Text of an ACP content block, or of a tool-call content entry. */
function blockText(c: any): string {
  if (!c) return '';
  if (typeof c.text === 'string') return c.text;
  if (c.type === 'content') return blockText(c.content);
  if (c.type === 'diff') return diffText(c);
  return '';
}

/** A readable rendering of an ACP diff entry ({ path, oldText, newText }). */
function diffText(d: any): string {
  const oldLines = String(d.oldText ?? '').split('\n');
  const newLines = String(d.newText ?? '').split('\n');
  const out = [`--- ${d.path ?? ''}`, `+++ ${d.path ?? ''}`];
  if (d.oldText) out.push(...oldLines.map((l) => '-' + l));
  out.push(...newLines.map((l) => '+' + l));
  return out.join('\n');
}

function contentText(content: unknown): string {
  return Array.isArray(content) ? content.map(blockText).filter(Boolean).join('\n') : '';
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function onToolCall(s: LhSession, u: any): void {
  closeStreams(s);
  const callId = String(u.toolCallId || randomUUID());
  const id = s.toolItems.get(callId) || randomUUID();
  s.toolItems.set(callId, id);
  const input = u.rawInput || {};
  const title = String(u.title || 'tool call');
  const base = { id, ts: now(), status: 'running' as const };
  let item: CodexItem;
  if (u.kind === 'execute') {
    item = { ...base, kind: 'command', command: input.command ? String(input.command) : title, output: '', exitCode: null };
  } else if (u.kind === 'edit' || u.kind === 'delete' || u.kind === 'move') {
    const target = u.locations?.[0]?.path || input.path || input.file_path || title;
    item = { ...base, kind: 'file', path: String(target), diff: '' };
  } else {
    item = { ...base, kind: 'tool', server: 'localharness', tool: title, args: stringify(input) };
  }
  upsert(s, item);
}

function onToolCallUpdate(s: LhSession, u: any): void {
  const id = s.toolItems.get(String(u.toolCallId));
  const it = itemById(s, id || null);
  if (!it) return;
  const text = contentText(u.content) || stringify(u.rawOutput);
  const next: CodexItem = { ...it };
  if (u.status === 'completed') next.status = 'done';
  else if (u.status === 'failed') next.status = 'failed';
  if (text) {
    if (next.kind === 'command') next.output = text;
    else if (next.kind === 'file') next.diff = text;
    else next.result = text;
  }
  if (next.kind === 'command' && next.status !== 'running') next.exitCode = next.status === 'failed' ? 1 : 0;
  if (next.status !== 'running') s.toolItems.delete(String(u.toolCallId));
  upsert(s, next);
}

function onChunk(s: LhSession, kind: 'message' | 'reasoning', text: string): void {
  if (!text) return;
  if (kind === 'message' && BRINGUP_STATUS.test(text)) {
    upsert(s, { id: `bringup-${s.sessionId}`, kind: 'system', text: text.trim(), ts: now() });
    return;
  }
  // An answer arriving with no turn open is a notice the agent sends on its
  // own (bring-up progress, a pending decision). Show it; it is no turn's reply.
  const t = s.turn;
  const slot = kind === 'message' ? 'messageId' : 'thoughtId';
  let it = t ? itemById(s, t[slot]) : undefined;
  if (!it) {
    // LocalHarness reports a session that could not be brought up as agent
    // text, then ends the turn normally. It is a failure, not a reply.
    const failed = kind === 'message' && BRINGUP_FAILURE.test(text);
    it = failed
      ? { id: randomUUID(), kind: 'error', text: '', status: 'running', ts: now() }
      : kind === 'message'
        ? { id: randomUUID(), kind: 'message', role: 'agent', text: '', status: 'running', ts: now() }
        : { id: randomUUID(), kind: 'reasoning', text: '', status: 'running', ts: now() };
    if (t) t[slot] = it.id;
  }
  const next = { ...it, text: (it.text || '') + text };
  if (!t) next.status = 'done';
  if (t && kind === 'message') t.texts.push(text);
  upsert(s, next);
}

function onUpdate(s: LhSession, params: Record<string, any>): void {
  if (params.sessionId !== s.sessionId) return;
  const u = params.update || {};
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': return onChunk(s, 'message', blockText(u.content));
    case 'agent_thought_chunk': return onChunk(s, 'reasoning', blockText(u.content));
    case 'user_message_chunk': return; // we rendered the prompt ourselves
    case 'tool_call': return onToolCall(s, u);
    case 'tool_call_update': return onToolCallUpdate(s, u);
    case 'plan': {
      const entries = Array.isArray(u.entries) ? u.entries : [];
      const lines = entries.map((e: any) => `${e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]'} ${e.content}`);
      if (lines.length) upsert(s, { id: `plan-${s.sessionId}`, kind: 'system', text: 'Plan\n' + lines.join('\n'), ts: now() });
      return;
    }
    case 'current_mode_update': {
      const next = String(u.currentModeId || s.mode);
      // LocalHarness re-sends an unchanged mode (after the trust question,
      // for one); only a real change is worth a line.
      if (next === s.mode) return;
      s.mode = next;
      const name = s.modes.find((m) => m.id === s.mode)?.name || s.mode;
      system(s, `Permission mode: ${name}`);
      return;
    }
    case 'available_commands_update': {
      const list = Array.isArray(u.availableCommands) ? u.availableCommands : [];
      s.commands = list.map((c: any) => ({ name: String(c.name), description: c.description ? String(c.description) : undefined }));
      return;
    }
    default:
      return;
  }
}

// ─────────────────────────── turns ───────────────────────────

/** Queue a prompt; it runs when the agent is free. Resolves when its turn ends. */
function submit(s: LhSession, text: string, display = text): Promise<TurnResult> {
  return new Promise((resolve) => {
    s.queue.push({ text, display, resolve });
    if (!s.turn) runNext(s);
  });
}

function runNext(s: LhSession): void {
  if (s.turn || s.stopping) return;
  const next = s.queue.shift();
  if (!next) { setStatus(s, 'awaiting_input'); return; }

  upsert(s, { id: randomUUID(), kind: 'message', role: 'user', text: next.display, status: 'done', ts: now() });
  const turn: Turn = { texts: [], messageId: null, thoughtId: null, resolve: next.resolve };
  s.turn = turn;
  setStatus(s, 'running');

  s.conn.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: next.text }] }, { timeoutMs: 0 })
    .then((res) => endTurn(s, turn, String(res?.stopReason || 'end_turn')))
    .catch((err) => endTurn(s, turn, 'error', (err as Error).message));
}

/** `quiet`: the caller reports the failure itself, so add no error item. */
function endTurn(s: LhSession, turn: Turn, stopReason: string, error?: string, opts: { quiet?: boolean } = {}): void {
  if (s.turn !== turn) return;
  // A question still open when its turn ended can no longer be acted on.
  cancelPermissions(s, { reply: true });
  closeStreams(s);
  // A tool call left running when the turn ended will never complete now.
  for (const [, id] of s.toolItems) {
    const it = itemById(s, id);
    if (it && it.status === 'running') upsert(s, { ...it, status: 'failed' });
  }
  s.toolItems.clear();
  s.turn = null;
  if (error && !s.stopping && !opts.quiet) upsert(s, { id: randomUUID(), kind: 'error', text: error, ts: now() });
  else if (stopReason === 'cancelled') system(s, 'Turn cancelled.');
  else if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') system(s, `Turn stopped: ${stopReason.replace(/_/g, ' ')}.`);
  turn.resolve({ stopReason, text: turn.texts.join('').trim(), ...(error ? { error } : {}) });
  runNext(s);
}

// ─────────────────────────── permission → approval gate ───────────────────────────

const CANCELLED: PermissionOutcome = { outcome: { outcome: 'cancelled' } };

/** The first useful line of what the tool call would do: a command, a path, a URL. */
function describeInput(input: any): string[] {
  if (!input || typeof input !== 'object') return [];
  const lines: string[] = [];
  const pick = (k: string) => (typeof input[k] === 'string' && input[k].trim() ? input[k].trim() : '');
  const command = pick('command') || pick('cmd');
  const target = pick('path') || pick('file_path') || pick('filepath');
  const url = pick('url');
  if (command) lines.push(`$ ${command}`);
  if (target) lines.push(`path: ${target}`);
  if (url) lines.push(`url: ${url}`);
  return lines.map((l) => (l.length > 400 ? l.slice(0, 399) + '…' : l));
}

/** The gate text: who asks, for what, and the answers on offer. */
function permissionPrompt(s: LhSession, toolCall: any, options: GateOption[]): string {
  const title = String(toolCall?.title || 'a tool call');
  return [
    `${s.agent.name} (LocalHarness) asks permission:`,
    '',
    `    ${title}`,
    ...describeInput(toolCall?.rawInput).map((l) => `    ${l}`),
    '',
    `Options: ${options.map((o) => o.name).join(' · ')}`,
  ].join('\n');
}

/** The agent asked; park its reply until a human answers the gate. */
function requestPermission(s: LhSession, params: Record<string, any>): Promise<PermissionOutcome> {
  const options: GateOption[] = (Array.isArray(params.options) ? params.options : [])
    .filter((o: any) => o && typeof o.optionId === 'string')
    .map((o: any) => ({ id: String(o.optionId), name: String(o.name || o.optionId), kind: String(o.kind || '') }));
  const title = String(params.toolCall?.title || 'a tool call');
  // Nobody to ask, or nothing to choose: refuse. Never answer yes for a human.
  if (!permissionHandlers || !options.length || s.stopping) {
    system(s, `Refused a permission request nobody could answer: ${title}`);
    return Promise.resolve(CANCELLED);
  }
  return new Promise((resolve) => {
    s.permissions.push({ title, options, prompt: permissionPrompt(s, params.toolCall, options), resolve });
    if (s.permissions.length === 1) raiseNextPermission(s);
  });
}

function raiseNextPermission(s: LhSession): void {
  while (s.permissions.length) {
    const head = s.permissions[0];
    if (permissionHandlers?.raise(s.agent.projectId, s.agent.id, head.prompt, head.options)) {
      system(s, `Waiting for approval: ${head.title}`);
      setStatus(s, 'awaiting_input');
      return;
    }
    // A gate could not be raised (another one is already open on this agent).
    // Refusing is the only answer that is never wrong.
    s.permissions.shift();
    head.resolve(CANCELLED);
    system(s, `Refused (another approval was already pending): ${head.title}`);
  }
}

/**
 * Answer the oldest pending permission request — called once a human resolved
 * the gate (gate-resolve.ts → daemon `gate:answer`). `optionId` null cancels.
 * Returns false when nothing was pending.
 */
export function answerPermission(agentId: string, optionId: string | null): boolean {
  const s = sessions.get(agentId);
  const head = s?.permissions[0];
  if (!s || !head) return false;
  s.permissions.shift();
  const chosen = optionId ? head.options.find((o) => o.id === optionId) : undefined;
  // An id the agent did not offer is not an answer to this question.
  head.resolve(chosen ? { outcome: { outcome: 'selected', optionId: chosen.id } } : CANCELLED);
  system(s, chosen ? `${chosen.name}: ${head.title}` : `Refused: ${head.title}`);
  if (s.permissions.length) raiseNextPermission(s);
  else if (s.turn) setStatus(s, 'running');
  return true;
}

/**
 * Answer every pending request with `cancelled` and take the gate down —
 * on cancel, stop and exit. ACP requires a client that cancels a turn to
 * answer its open permission requests that way.
 */
function cancelPermissions(s: LhSession, opts: { reply: boolean }): void {
  if (!s.permissions.length) return;
  for (const p of s.permissions.splice(0)) if (opts.reply) p.resolve(CANCELLED);
  try { updateAgent(s.agent.projectId, s.agent.id, { pendingGate: undefined }); }
  catch { /* project may be gone */ }
  permissionHandlers?.cleared(s.agent.projectId, s.agent.id);
}

// ─────────────────────────── lifecycle ───────────────────────────

/** Write Bedrock's section into the instruction file this agent reads. */
function writeInstructions(agent: Agent, cwd: string): void {
  const data = getProjectData(agent.projectId);
  if (!data) throw new AgentStartError('Project not found.');
  const projectName = data.project.name;
  const sharedPath = ensureSharedDir(projectName);
  const wikiPath = wikiDirFor(projectName);
  try { fs.mkdirSync(wikiPath, { recursive: true }); } catch { /* best-effort */ }
  const teammates = data.agents.filter((a) => a.id !== agent.id);
  const file = path.join(cwd, instructionFileFor(agent.cli, cwd));
  try {
    ensureInstructionFile(file, projectName, sharedPath, wikiPath, agent, teammates);
  } catch (err) {
    console.warn(`[localharness] Could not write ${file}:`, err);
  }
}

export async function startAgent(agent: Agent, statusFn: StatusFn, prepared: PreparedLocalHarness): Promise<boolean> {
  onStatus = statusFn;
  if (sessions.has(agent.id)) return true;

  const cwd = expandHome(agent.cwd);
  if (!fs.existsSync(cwd)) throw new AgentStartError(`The working directory for ${agent.name} does not exist: ${cwd}`);
  writeInstructions(agent, cwd);

  const conn = new AcpConnection({
    command: prepared.binary,
    args: [...prepared.binaryArgs, 'acp'],
    cwd,
    env: { ...agentEnv(), ...localHarnessEnv(agent.id) },
    shell: prepared.shell,
    label: `localharness:${agent.name}`,
  });
  // The agent's questions become approval gates. Nothing else is served: no
  // fs or terminal capability was advertised, so none should arrive.
  let session: LhSession | null = null;
  conn.onRequest(async (method, params) => {
    if (method === 'session/request_permission') {
      return session ? requestPermission(session, params) : CANCELLED;
    }
    throw new Error(`Bedrock does not serve ${method}`);
  });

  try {
    await conn.start();
    await conn.request('initialize', {
      protocolVersion: 1,
      // No filesystem or terminal capability: the agent reads and writes the
      // project on disk itself, as it does in a terminal.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'bedrock', title: 'Bedrock', version: '1.0.0' },
    });
  } catch (err) {
    conn.kill();
    throw new AgentStartError(`LocalHarness did not start: ${(err as Error).message}`);
  }

  let created: any;
  try {
    created = await conn.request('session/new', { cwd, mcpServers: [] });
  } catch (err) {
    conn.kill();
    throw new AgentStartError(`LocalHarness refused the session: ${(err as Error).message}`);
  }

  const s: LhSession = {
    agent,
    conn,
    sessionId: String(created?.sessionId || ''),
    items: [],
    listeners: new Set(),
    status: 'running',
    inputLine: '',
    queue: [],
    turn: null,
    toolItems: new Map(),
    modes: Array.isArray(created?.modes?.availableModes) ? created.modes.availableModes : [],
    mode: String(created?.modes?.currentModeId || ''),
    commands: [],
    model: prepared.model,
    stopping: false,
    permissions: [],
  };
  session = s;
  sessions.set(agent.id, s);

  conn.onNotification((method, params) => {
    if (method === 'session/update') onUpdate(s, params);
  });
  conn.onExit((code) => onExit(s, code));

  const wanted = DEFAULT_MODE;
  if (s.mode !== wanted && s.modes.some((m) => m.id === wanted)) {
    try { await conn.request('session/set_mode', { sessionId: s.sessionId, modeId: wanted }); }
    catch (err) { console.warn(`[localharness] set_mode ${wanted} failed:`, (err as Error).message); }
  }

  system(s, `LocalHarness online — ${prepared.model} at ${prepared.baseUrl}`
    + (prepared.mcp ? '' : ' (Bedrock messaging unavailable: run `npm run build`)'));
  // A gate left over from a previous run answers a question no process is
  // asking any more.
  try { updateAgent(agent.projectId, agent.id, { status: 'running', pid: conn.pid, pendingGate: undefined, lastExitCode: null, lastExitSignal: null }); }
  catch { /* project may be gone */ }
  onStatus(agent.id, 'running');
  setStatus(s, 'awaiting_input');
  return true;
}

function onExit(s: LhSession, code: number | null): void {
  if (sessions.get(s.agent.id) !== s) return;
  sessions.delete(s.agent.id);
  // Not asked to stop: a crash. One error item says so, with the agent's own
  // last words from stderr; the open turn ends quietly underneath it.
  const crashed = !s.stopping;
  s.stopping = true;
  // The process is gone, so there is no one to reply to — only the gate to take down.
  cancelPermissions(s, { reply: false });
  const why = `LocalHarness exited (code ${code ?? 'none'})`;
  if (s.turn) endTurn(s, s.turn, 'error', why, { quiet: true });
  for (const q of s.queue.splice(0)) q.resolve({ stopReason: 'error', text: '', error: why });
  if (crashed) {
    const tail = s.conn.stderrTail().trim().split('\n').slice(-6).join('\n');
    upsert(s, { id: randomUUID(), kind: 'error', text: `${why}.${tail ? '\n' + tail : ''}`, ts: now() });
  }
  try { updateAgent(s.agent.projectId, s.agent.id, { status: 'stopped', pid: undefined, pendingGate: undefined, lastExitCode: code }); }
  catch { /* project may be gone */ }
  onStatus(s.agent.id, 'stopped');
}

export function stopAgent(agentId: string): boolean {
  const s = sessions.get(agentId);
  if (!s) return false;
  s.stopping = true;
  cancelPermissions(s, { reply: true });
  if (s.turn) s.conn.notify('session/cancel', { sessionId: s.sessionId });
  s.conn.close(2_000);
  // Report stopped now; the process exit that follows finds the session gone.
  sessions.delete(agentId);
  if (s.turn) endTurn(s, s.turn, 'cancelled');
  for (const q of s.queue.splice(0)) q.resolve({ stopReason: 'cancelled', text: '' });
  try { updateAgent(s.agent.projectId, agentId, { status: 'stopped', pid: undefined, pendingGate: undefined }); }
  catch { /* project may be gone */ }
  onStatus(agentId, 'stopped');
  return true;
}

/** Composer input: buffered into a line and sent as a prompt. Ctrl-C cancels the turn. */
export function writeToAgent(agentId: string, data: string): void {
  const s = sessions.get(agentId);
  if (!s) return;
  for (const ch of data) {
    if (ch === '\x03') { interruptAgent(agentId); continue; }
    if (ch === '\r' || ch === '\n') {
      const line = s.inputLine.trim();
      s.inputLine = '';
      if (line) void submit(s, line);
    } else if (ch === '\x7f' || ch === '\b') {
      s.inputLine = s.inputLine.slice(0, -1);
    } else if (ch >= ' ') {
      s.inputLine += ch;
    }
  }
}

/** A message from the composer, newlines and all, as one prompt. */
export function sendPrompt(agentId: string, text: string): boolean {
  const s = sessions.get(agentId);
  const clean = text.replace(/\r/g, '').trim();
  if (!s || !clean) return false;
  void submit(s, clean);
  return true;
}

/** A teammate's message, run as a prompt when the agent is free. */
export function injectMessage(agentId: string, fromName: string, message: string): boolean {
  const s = sessions.get(agentId);
  if (!s) return false;
  const text = `[Message from ${fromName}]: ${message.replace(/\r/g, '').trim()}`;
  void submit(s, text);
  return true;
}

/** Send a prompt and wait for the turn it starts to end — LocalHarness's `ask_agent`. */
export async function askAgent(agentId: string, message: string, timeoutMs = 300_000): Promise<TurnResult & { timedOut?: boolean }> {
  const s = sessions.get(agentId);
  if (!s) return { stopReason: 'error', text: '', error: 'not running' };
  const turn = submit(s, message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TurnResult & { timedOut: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ stopReason: 'timeout', text: '', timedOut: true }), timeoutMs);
  });
  try { return await Promise.race([turn, timeout]); }
  finally { clearTimeout(timer); }
}

/** Cancel the running turn. Returns false when nothing was running. */
export function interruptAgent(agentId: string): boolean {
  const s = sessions.get(agentId);
  if (!s || !s.turn) return false;
  cancelPermissions(s, { reply: true });
  s.conn.notify('session/cancel', { sessionId: s.sessionId });
  return true;
}

/** No-op — an ACP session has no terminal geometry. */
export function resizeAgent(_agentId: string, _cols: number, _rows: number): void { /* intentionally empty */ }

export function getItems(agentId: string): CodexItem[] {
  return sessions.get(agentId)?.items.slice() ?? [];
}

export function subscribeItems(agentId: string, listener: ItemListener): () => void {
  const s = sessions.get(agentId);
  if (!s) return () => { /* nothing */ };
  s.listeners.add(listener);
  return () => { sessions.get(agentId)?.listeners.delete(listener); };
}

/** Plain text of each finished item — what the Supervisor watches. */
export function subscribeText(agentId: string, listener: (text: string) => void): () => void {
  return subscribeItems(agentId, textListener(listener));
}

export function getAgentPreview(agentId: string): string {
  const s = sessions.get(agentId);
  if (!s) return '';
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === 'message' && it.text) return it.text.replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  return '';
}

export function isAgentRunning(agentId: string): boolean {
  return sessions.has(agentId);
}

export function getRunningAgentIds(): string[] {
  return [...sessions.keys()];
}

/**
 * Switch the permission mode. Only a mode the session offered is accepted —
 * "unattended" (every ask becomes a yes) included, because LocalHarness offers
 * it to a person watching the session; the UI says what it means.
 */
export async function setMode(agentId: string, mode: string): Promise<{ ok: boolean; error?: string }> {
  const s = sessions.get(agentId);
  if (!s) return { ok: false, error: 'The agent is not running.' };
  if (!s.modes.some((m) => m.id === mode)) {
    return { ok: false, error: `"${mode}" is not one of this session's modes: ${s.modes.map((m) => m.id).join(', ')}.` };
  }
  try {
    await s.conn.request('session/set_mode', { sessionId: s.sessionId, modeId: mode });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** What the controls show: the mode, the modes on offer, the model, the slash commands. */
export function getSessionInfo(agentId: string) {
  const s = sessions.get(agentId);
  if (!s) return null;
  return {
    mode: s.mode,
    modes: s.modes.map((m) => ({ id: m.id, name: m.name, description: m.description })),
    model: s.model,
    commands: s.commands,
    busy: !!s.turn,
    queued: s.queue.length,
  };
}
