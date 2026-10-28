/**
 * runtime.ts — routes agent operations to the right runtime.
 *
 *   Claude / Gemini / OpenCode / GPT / Nemotron → PTY (pty-manager)
 *   Codex                                       → app-server thread (codex-agents)
 *   LocalHarness                                → ACP session (localharness-agents),
 *                                                 or PTY with flags.terminal
 *
 * The `gpt` and `nemotron` types are aider invocations against Groq and
 * OpenRouter respectively; they behave like any other PTY agent.
 *
 * The daemon and the Conduit dispatch layer talk only to this module, so they
 * never branch on CLI themselves.
 */

import * as pty from '../pty-manager.js';
import * as codex from './codex-agents.js';
import * as lh from './localharness-agents.js';
import type { Agent } from '../types.js';
import type { CodexItem } from './protocol.js';
import { checkCliReady } from '../cli-registry.js';
import { prepareLocalHarnessAgent } from '../localharness/prepare.js';

type StatusFn = (agentId: string, status: string) => void;

/** True once this agent id is a live Codex (app-server) agent. */
function isCodex(agentId: string): boolean {
  return codex.isAgentRunning(agentId);
}

/** True once this agent id is a live LocalHarness ACP session. */
function isLocalHarness(agentId: string): boolean {
  return lh.isAgentRunning(agentId);
}

/** Structured runtimes have items, not a terminal stream. */
function isStructured(agentId: string): boolean {
  return isCodex(agentId) || isLocalHarness(agentId);
}

/**
 * Start an agent on its runtime. Async — Codex must create a thread.
 * Throws `AgentStartError` with an actionable message when the agent cannot
 * start (CLI not installed, missing API key, bad working directory).
 */
export async function startAgent(agent: Agent, onStatus: StatusFn): Promise<boolean> {
  // One preflight for every type, so a missing CLI or API key is reported as
  // a clear message rather than a terminal that silently does nothing.
  const ready = checkCliReady(agent.cli);
  if (!ready.ok) throw new pty.AgentStartError(ready.error || `Cannot start ${agent.cli}.`);

  if (agent.cli === 'codex') return codex.startAgent(agent, onStatus);
  if (agent.cli === 'localharness') {
    // LocalHarness's second preflight is asynchronous: is the local model
    // server up, and which model? It also writes the agent's config dir.
    const prepared = await prepareLocalHarnessAgent(agent);
    if (!agent.flags?.terminal) return lh.startAgent(agent, onStatus, prepared);
  }
  return pty.startAgent(agent, onStatus);
}

export function stopAgent(agentId: string): boolean {
  if (isCodex(agentId)) return codex.stopAgent(agentId);
  if (isLocalHarness(agentId)) return lh.stopAgent(agentId);
  return pty.stopAgent(agentId);
}

export function writeToAgent(agentId: string, data: string): void {
  if (isCodex(agentId)) codex.writeToAgent(agentId, data);
  else if (isLocalHarness(agentId)) lh.writeToAgent(agentId, data);
  else pty.writeToAgent(agentId, data);
}

export function injectMessage(agentId: string, fromName: string, message: string): boolean {
  if (isCodex(agentId)) return codex.injectMessage(agentId, fromName, message);
  if (isLocalHarness(agentId)) return lh.injectMessage(agentId, fromName, message);
  return pty.injectMessage(agentId, fromName, message);
}

/**
 * Interrupt whatever the agent is doing: Escape for PTY CLIs, `session/cancel`
 * for LocalHarness, nothing for Codex.
 */
export function interruptAgent(agentId: string): boolean {
  if (isCodex(agentId)) return false;
  if (isLocalHarness(agentId)) return lh.interruptAgent(agentId);
  return pty.interruptAgent(agentId);
}

export function resizeAgent(agentId: string, cols: number, rows: number): void {
  if (isCodex(agentId)) codex.resizeAgent(agentId, cols, rows);
  else if (isLocalHarness(agentId)) lh.resizeAgent(agentId, cols, rows);
  else pty.resizeAgent(agentId, cols, rows);
}

/**
 * Attach to an agent's live output. PTY agents stream text (`onText`); Codex
 * and LocalHarness agents stream structured items (`onItem`, replayed on
 * attach). Returns a teardown function.
 */
export function attach(
  agentId: string,
  handlers: { onText: (data: string) => void; onItem: (item: CodexItem) => void },
): () => void {
  if (isCodex(agentId)) {
    for (const it of codex.getItems(agentId)) handlers.onItem(it);
    return codex.subscribeItems(agentId, handlers.onItem);
  }
  if (isLocalHarness(agentId)) {
    for (const it of lh.getItems(agentId)) handlers.onItem(it);
    return lh.subscribeItems(agentId, handlers.onItem);
  }
  pty.addOutputListener(agentId, handlers.onText);
  return () => pty.removeOutputListener(agentId, handlers.onText);
}

/**
 * Observe an agent's activity as plain text, without a history replay. PTY
 * agents deliver raw output chunks; structured agents deliver one string per
 * finished item. Used by the Supervisor watcher.
 */
export function subscribeOutput(agentId: string, listener: (text: string) => void): () => void {
  if (isCodex(agentId)) return codex.subscribeText(agentId, listener);
  if (isLocalHarness(agentId)) return lh.subscribeText(agentId, listener);
  pty.addOutputListener(agentId, listener, { replay: false });
  return () => pty.removeOutputListener(agentId, listener);
}

/** Snapshot of an agent's history for a viewer that attaches late. */
export function getReplay(agentId: string): { text?: string; items?: CodexItem[] } {
  if (isCodex(agentId)) return { items: codex.getItems(agentId) };
  if (isLocalHarness(agentId)) return { items: lh.getItems(agentId) };
  return { text: pty.getBufferText(agentId) };
}

export function getAgentPreview(agentId: string): string {
  if (isCodex(agentId)) return codex.getAgentPreview(agentId);
  if (isLocalHarness(agentId)) return lh.getAgentPreview(agentId);
  return pty.getAgentPreview(agentId);
}

export function isAgentRunning(agentId: string): boolean {
  return pty.isAgentRunning(agentId) || isStructured(agentId);
}

export function getRunningAgentIds(): string[] {
  return [...pty.getRunningAgentIds(), ...codex.getRunningAgentIds(), ...lh.getRunningAgentIds()];
}

/** Config cleanup on agent deletion (pty-manager owns every CLI's per-agent files). */
export function cleanupMcpConfig(agent: Agent): void {
  pty.cleanupMcpConfig(agent);
}

/** Run a turn on a Codex agent and wait for its reply (the Codex `ask_agent`). */
export function askCodexAgent(agentId: string, message: string) {
  return codex.askAgent(agentId, message);
}

/** Submit a turn to a Codex agent with optional model / effort overrides. */
export function sendCodexTurn(agentId: string, text: string, model?: string, effort?: string): void {
  codex.sendTurn(agentId, text, model, effort);
}

/** Start a fresh thread for a Codex agent. */
export function newCodexThread(agentId: string): Promise<boolean> {
  return codex.newThread(agentId);
}

/** List the models codex offers (UI model picker). */
export function listCodexModels(): Promise<string[]> {
  return codex.listModels();
}

/** Whether this agent is a live LocalHarness ACP session (not a terminal one). */
export function isLocalHarnessSession(agentId: string): boolean {
  return isLocalHarness(agentId);
}

/** A LocalHarness session's mode, modes, model and slash commands — null when not running. */
export function localHarnessInfo(agentId: string) {
  return lh.getSessionInfo(agentId);
}

/** Switch a LocalHarness session's permission mode (session/set_mode). */
export function setLocalHarnessMode(agentId: string, mode: string): Promise<{ ok: boolean; error?: string }> {
  return lh.setMode(agentId, mode);
}

/** Send a whole composer message to a LocalHarness agent as one prompt. */
export function sendLocalHarnessPrompt(agentId: string, text: string): boolean {
  return lh.sendPrompt(agentId, text);
}

/** Run a prompt on a LocalHarness agent and wait for its reply (its `ask_agent`). */
export function askLocalHarnessAgent(agentId: string, message: string, timeoutMs?: number) {
  return lh.askAgent(agentId, message, timeoutMs);
}

/** How an ACP agent's permission request becomes an approval gate (the daemon installs it). */
export function setPermissionHandlers(h: lh.PermissionHandlers | null): void {
  lh.setPermissionHandlers(h);
}

/**
 * Answer an ACP agent's pending permission request with one of the options it
 * offered, or null to refuse. Only gate resolution calls this.
 */
export function answerPermission(agentId: string, optionId: string | null): boolean {
  return lh.answerPermission(agentId, optionId);
}
