import type { CliId } from './cli-registry.js';

export type { CliId };
export { VALID_CLIS, CLI_SPECS, CLI_IDS, isCliId } from './cli-registry.js';

export interface Project {
  id: string;
  name: string;
  description?: string;
  cwd: string;
  createdAt: string;
}

/**
 * Agent status. v2.1 derives the finer states from Claude Code lifecycle hooks:
 *   running        — actively working
 *   awaiting_input — finished a turn / asked something — needs the user
 *   idle           — awaiting_input for a while with no attention
 *   stopped        — not running
 */
export type AgentStatus = 'stopped' | 'running' | 'idle' | 'awaiting_input';

/**
 * Where an approval gate came from.
 *   regex      — a prompt matched in a terminal (a y/n question, a trust menu)
 *   supervisor — the Supervisor called the agent's next step risky
 *   acp        — the agent itself asked, over the Agent Client Protocol
 *                (LocalHarness's permission request), with exact options
 */
export type GateSource = 'regex' | 'supervisor' | 'acp';

/** One answer an ACP agent offers to its own permission request. */
export interface GateOption {
  id: string;
  name: string;
  /** allow_once | allow_always | reject_once | reject_always */
  kind: string;
}

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  role?: string;
  cli: CliId;
  cwd: string;
  status: AgentStatus;
  pid?: number;
  /** v2.2: Codex agents run as `codex app-server` threads — this is the
   *  thread id, persisted so the agent resumes across daemon restarts. */
  codexThreadId?: string;
  flags?: {
    dangerouslySkipPermissions?: boolean;
    remoteControl?: boolean;
    /** LocalHarness only: run the interactive REPL in a terminal instead of
     *  the structured ACP session (the default). */
    terminal?: boolean;
  };
  pendingGate?: {
    prompt: string;
    source: GateSource;
    options?: string[];
    /** source 'acp': the answers the agent offered, which resolution picks from. */
    acpOptions?: GateOption[];
  };
  lastExitCode?: number | null;
  lastExitSignal?: string | null;
}

export interface SharedContent {
  id: string;
  projectId: string;
  filename: string;
  content: string;
  createdBy: string;
  updatedAt: string;
}

export interface Plan {
  id: string;
  projectId: string;
  description: string;
  targetAgent: string;
  targetProject: string;
  proposedMessage: string;
  createdAt: string;
}

/**
 * Persisted pane layout for a project. `mode` matches the client's
 * `GridLayout` union in client/src/components/AgentGrid.tsx — the two must
 * stay in step, or saved layouts silently fail validation.
 */
export interface ProjectLayout {
  mode: 'single' | '2up' | '3up' | 'grid' | 'canvas';
  splitRatios: number[];
  activeAgentIds: string[];
  focusedAgentId?: string;
}

export interface ProjectData {
  project: Project;
  agents: Agent[];
  pendingPlans?: Plan[];
  layout?: ProjectLayout;
}

import type { BrainEvent, CodexItem } from './daemon/protocol.js';

// WebSocket message types
export type WSClientMessage =
  | { type: 'terminal:attach'; agentId: string }
  | { type: 'terminal:input'; agentId: string; data: string }
  | { type: 'terminal:detach'; agentId: string }
  | { type: 'terminal:resize'; agentId: string; cols: number; rows: number }
  | { type: 'codex:send'; agentId: string; text: string; model?: string; effort?: string }
  | { type: 'codex:new-thread'; agentId: string }
  // LocalHarness (ACP): a whole composer message as one prompt, and cancel the turn.
  | { type: 'localharness:send'; agentId: string; text: string }
  | { type: 'localharness:cancel'; agentId: string }
  | { type: 'brain:send'; message: string }
  | { type: 'brain:new' }
  | { type: 'brain:abort' }
  | { type: 'brain:switch'; conversationId: string }
  | { type: 'brain:delete'; conversationId: string }
  | { type: 'ping' };

export interface ActivityEvent {
  id: string;
  projectId: string;
  agentId?: string;
  agentName?: string;
  event: 'agent:started' | 'agent:stopped' | 'content:created' | 'content:modified' | 'content:deleted' | 'user:input' | 'agent:message';
  detail: string;
  timestamp: string;
  // For agent:message events
  fromAgent?: string;
  toAgent?: string;
  message?: string;
}

export interface AgentMessage {
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  message: string;
  timestamp: string;
}

export type WSServerMessage =
  | { type: 'hello'; daemon: boolean }
  | { type: 'pong' }
  | { type: 'terminal:output'; agentId: string; data: string }
  | { type: 'agent:status'; agentId: string; status: string }
  | { type: 'content:updated'; projectId: string; filename: string }
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'brain:event'; payload: BrainEvent }
  | { type: 'org:changed' }
  | { type: 'memory:updated'; projectId: string }
  | { type: 'plugins:changed' }
  | { type: 'settings:changed' }
  | { type: 'codex:item'; agentId: string; item: CodexItem }
  | { type: 'supervisor:update'; payload: any }
  | { type: 'groupchat:message'; payload: any }
  | { type: 'gate:triggered'; agentId: string; projectId: string; prompt: string; source: GateSource; options?: string[]; acpOptions?: GateOption[] }
  | { type: 'gate:resolved'; agentId: string }
  | { type: 'plan:created'; plan: Plan }
  | { type: 'plan:resolved'; planId: string; decision: string }
  | { type: 'layout:changed'; projectId: string; layout: ProjectLayout };
