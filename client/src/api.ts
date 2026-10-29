export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function normalizeError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) return new ApiError(500, 'INTERNAL_ERROR', err.message);
  return new ApiError(500, 'UNKNOWN_ERROR', String(err));
}

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (err) {
    throw new Error('Cannot reach the Bedrock server — is it running?');
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Projects
export const listProjects = () => request<Project[]>('/projects');
export const createProject = (data: { name: string; cwd: string; description?: string }) =>
  request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) });
export const updateProject = (id: string, data: Partial<Pick<Project, 'name' | 'description' | 'cwd'>>) =>
  request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteProject = (id: string, removeData?: boolean) =>
  request<void>(`/projects/${id}?removeData=${removeData ? 'true' : 'false'}`, { method: 'DELETE' });

// Agents
export const listAgents = (projectId: string) =>
  request<Agent[]>(`/projects/${projectId}/agents`);
export const createAgent = (projectId: string, data: { name: string; cli: string; cwd?: string; role?: string; flags?: Agent['flags'] }) =>
  request<Agent>(`/projects/${projectId}/agents`, { method: 'POST', body: JSON.stringify(data) });
export const deleteAgent = (projectId: string, agentId: string) =>
  request<void>(`/projects/${projectId}/agents/${agentId}`, { method: 'DELETE' });
export const startAgent = (projectId: string, agentId: string) =>
  request<{ status: string }>(`/projects/${projectId}/agents/${agentId}/start`, { method: 'POST' });
export const stopAgent = (projectId: string, agentId: string) =>
  request<{ status: string }>(`/projects/${projectId}/agents/${agentId}/stop`, { method: 'POST' });
export const restartAgent = (projectId: string, agentId: string) =>
  request<{ status: string }>(`/projects/${projectId}/agents/${agentId}/restart`, { method: 'POST' });

// Approval gates + plans
/** `optionId`: for an ACP gate, which of the agent's offered answers to pick. */
export const resolveGate = (projectId: string, agentId: string, decision: 'approve' | 'reject' | 'custom', customInput?: string, optionId?: string) =>
  request<{ success: boolean; action: string }>(`/projects/${projectId}/agents/${agentId}/gate/resolve`, {
    method: 'POST', body: JSON.stringify({ decision, customInput, ...(optionId ? { optionId } : {}) }),
  });
export const listPlans = (projectId: string) => request<Plan[]>(`/projects/${projectId}/plans`);
export const resolvePlan = (projectId: string, planId: string, decision: 'approve' | 'reject', reason?: string) =>
  request<{ success: boolean; delivered: boolean; note?: string }>(`/projects/${projectId}/plans/${planId}/resolve`, {
    method: 'POST', body: JSON.stringify({ decision, reason }),
  });

// Group chat + messages + activity
export const listGroupChat = (projectId: string) =>
  request<{ messages: GroupChatMsg[] }>(`/projects/${projectId}/groupchat`);
export const sendGroupChat = (projectId: string, message: string) =>
  request<GroupChatMsg & { delivered: string[]; skipped: string[] }>(`/projects/${projectId}/groupchat`, {
    method: 'POST', body: JSON.stringify({ message }),
  });
export const sendAgentMessage = (projectId: string, data: { fromAgentId: string; fromAgentName: string; target: string; message: string }) =>
  request<{ delivered: boolean; toAgentName: string }>(`/projects/${projectId}/messages`, {
    method: 'POST', body: JSON.stringify(data),
  });
export const listActivity = (projectId: string) =>
  request<ActivityEvent[]>(`/activity?projectId=${encodeURIComponent(projectId)}`);

// Shared Content
export const listContent = (projectId: string) =>
  request<SharedContent[]>(`/projects/${projectId}/content`);
export const getContent = (projectId: string, filename: string) =>
  request<SharedContent>(`/projects/${projectId}/content/${encodeURIComponent(filename)}`);
export const createContent = (projectId: string, data: { filename: string; content?: string; createdBy?: string }) =>
  request<SharedContent>(`/projects/${projectId}/content`, { method: 'POST', body: JSON.stringify(data) });
export const updateContent = (projectId: string, filename: string, content: string) =>
  request<SharedContent>(`/projects/${projectId}/content/${encodeURIComponent(filename)}`, { method: 'PUT', body: JSON.stringify({ content }) });
export const deleteContent = (projectId: string, filename: string) =>
  request<void>(`/projects/${projectId}/content/${encodeURIComponent(filename)}`, { method: 'DELETE' });

// Project Wiki
export const getWikiStatus = (projectId: string) =>
  request<{ initialized: boolean }>(`/projects/${projectId}/wiki/status`);
export const initializeWiki = (projectId: string) =>
  request<{ initialized: boolean }>(`/projects/${projectId}/wiki/initialize`, { method: 'POST' });
export const listWikiFiles = (projectId: string) =>
  request<SharedContent[]>(`/projects/${projectId}/wiki`);
export const getWikiFile = (projectId: string, filename: string) =>
  request<SharedContent>(`/projects/${projectId}/wiki/${encodeURIComponent(filename)}`);
export const updateWikiFile = (projectId: string, filename: string, content: string) =>
  request<SharedContent>(`/projects/${projectId}/wiki/${encodeURIComponent(filename)}`, { method: 'PUT', body: JSON.stringify({ content }) });

// Misc
export const getHealth = () =>
  request<{ ok: boolean; daemon: boolean; auth: boolean; supervisor: string; bedrockModel: string; region: string }>('/health');

// Types (shared with backend)
export interface Project {
  id: string;
  name: string;
  description?: string;
  cwd: string;
  createdAt: string;
}

export type AgentStatus = 'stopped' | 'running' | 'idle' | 'awaiting_input';

/** One answer an ACP agent (LocalHarness) offers to its own permission request. */
export interface GateOption {
  id: string;
  name: string;
  /** allow_once | allow_always | reject_once | reject_always */
  kind: string;
}

export interface PendingGate {
  prompt: string;
  /** acp: the agent itself asked, and offered `acpOptions` to choose from. */
  source: 'regex' | 'supervisor' | 'acp';
  options?: string[];
  acpOptions?: GateOption[];
}

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  role?: string;
  cli: 'claude' | 'codex' | 'gemini' | 'opencode' | 'gpt' | 'nemotron' | 'localharness';
  cwd: string;
  status: AgentStatus;
  pid?: number;
  flags?: {
    dangerouslySkipPermissions?: boolean;
    remoteControl?: boolean;
    /** LocalHarness: the interactive REPL in a terminal instead of the structured view. */
    terminal?: boolean;
  };
  pendingGate?: PendingGate;
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

export interface SharedContent {
  id: string;
  projectId: string;
  filename: string;
  content: string;
  createdBy: string;
  updatedAt: string;
}

export interface GroupChatMsg {
  id: string;
  ts: string;
  role: 'supervisor' | 'user' | 'agent' | 'human';
  sender: string;
  text?: string;
  message?: string;
  classification?: 'progress' | 'blocker' | 'question' | 'risky_action' | 'noise';
  projectId?: string;
}

export interface ActivityEvent {
  id: string;
  projectId: string;
  agentId?: string;
  agentName?: string;
  event: string;
  detail: string;
  timestamp: string;
  fromAgent?: string;
  toAgent?: string;
  message?: string;
}

export async function safeReadApiResponse(res: Response): Promise<unknown> {
  const raw = await res.text();
  try { return JSON.parse(raw); } catch { return { error: raw }; }
}

// --- Skills, project memory, agent definitions, plugins, LocalHarness controls ---

export interface Skill { name: string; description: string; path: string; scope: 'project' | 'user' }
export interface MemoryFact { id: string; text: string; source: string; createdAt: string }
export interface AgentTemplate { file: string; name: string; cli: string; role?: string; cwd: string; terminal?: boolean; exists: boolean }
export interface PluginInfo { name: string; enabled: boolean; loaded: boolean; error?: string }
export interface LocalHarnessInfo {
  running: boolean;
  mode?: string;
  modes?: Array<{ id: string; name: string; description?: string }>;
  model?: string;
  busy?: boolean;
  queued?: number;
}

export const listSkills = (projectId: string) => request<Skill[]>(`/projects/${projectId}/skills`);
export const listMemory = (projectId: string, q = '') =>
  request<MemoryFact[]>(`/projects/${projectId}/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`);
export const addMemory = (projectId: string, text: string) =>
  request<MemoryFact>(`/projects/${projectId}/memory`, { method: 'POST', body: JSON.stringify({ text }) });
export const forgetMemory = (projectId: string, factId: string) =>
  request<void>(`/projects/${projectId}/memory/${factId}`, { method: 'DELETE' });
export const listAgentTemplates = (projectId: string) =>
  request<{ templates: AgentTemplate[]; problems: Array<{ file: string; error: string }> }>(`/projects/${projectId}/agent-templates`);
export const importAgentTemplates = (projectId: string) =>
  request<{ created: Agent[]; skipped: string[]; problems: Array<{ file: string; error: string }> }>(`/projects/${projectId}/agent-templates/import`, { method: 'POST' });
export const listPlugins = () => request<{ apiVersion: string; dir: string; plugins: PluginInfo[] }>('/plugins');
export const setPluginEnabled = (name: string, enabled: boolean) =>
  request<{ enabled: string[] }>(`/plugins/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
export const getLocalHarnessInfo = (projectId: string, agentId: string) =>
  request<LocalHarnessInfo>(`/projects/${projectId}/agents/${agentId}/localharness`);
export const setLocalHarnessMode = (projectId: string, agentId: string, mode: string) =>
  request<{ ok: boolean }>(`/projects/${projectId}/agents/${agentId}/localharness/mode`, { method: 'POST', body: JSON.stringify({ mode }) });
