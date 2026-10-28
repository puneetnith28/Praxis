import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { authHeader } from '../auth.js';

const DAEMON_URL = `http://127.0.0.1:${process.env.CONDUIT_DAEMON_PORT || '3210'}`;
const SERVER_URL = `http://127.0.0.1:${process.env.PORT || '3200'}`;

async function daemonGet(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return await res.json();
}

export const getProjectOverview = tool({
  name: 'get_project_overview',
  description: 'Read a project\'s wiki overview — a quick summary of what the project is and its current state.',
  inputSchema: z.object({
    projectId: z.string().describe('The ID (or name) of the project to inspect'),
  }),
  callback: async (args: { projectId: string }) =>
    daemonGet(`${DAEMON_URL}/org/wiki?project=${encodeURIComponent(args.projectId)}&overview=1`),
});

export const readWiki = tool({
  name: 'read_wiki',
  description: 'Read a project\'s wiki. Omit filename to list pages.',
  inputSchema: z.object({
    projectId: z.string().describe('Project name or id.'),
    filename: z.string().optional().describe('Wiki page filename. Omit to list pages.'),
  }),
  callback: async (args: { projectId: string; filename?: string }) => {
    let url = `${DAEMON_URL}/org/wiki?project=${encodeURIComponent(args.projectId)}`;
    if (args.filename) url += `&page=${encodeURIComponent(args.filename)}`;
    return daemonGet(url);
  },
});

export const readShared = tool({
  name: 'read_shared',
  description: 'Read a project\'s shared content files. Omit filename to list files.',
  inputSchema: z.object({
    projectId: z.string().describe('The ID (or name) of the project'),
    filename: z.string().optional().describe('Specific shared file to read (optional)'),
  }),
  callback: async (args: { projectId: string; filename?: string }) => {
    let url = `${DAEMON_URL}/org/shared?project=${encodeURIComponent(args.projectId)}`;
    if (args.filename) url += `&file=${encodeURIComponent(args.filename)}`;
    return daemonGet(url);
  },
});

export const getAgentStatus = tool({
  name: 'get_agent_status',
  description: 'Get the live status of a single agent in a project.',
  inputSchema: z.object({
    projectId: z.string().describe('The ID (or name) of the project'),
    agentId: z.string().describe('The ID (or name) of the agent'),
  }),
  callback: async (args: { projectId: string; agentId: string }) => {
    const snap = (await daemonGet(`${DAEMON_URL}/org/snapshot`)) as {
      error?: string;
      projects?: Array<{ id: string; name: string; agents: Array<{ id: string; name: string; status: string; cli: string; role?: string }> }>;
    };
    if (snap.error || !snap.projects) return { error: snap.error || 'daemon unavailable' };
    const proj = snap.projects.find((p) => p.id === args.projectId || p.name.toLowerCase() === args.projectId.toLowerCase());
    if (!proj) return { error: 'Project not found' };
    const ag = proj.agents.find((a) => a.id === args.agentId || a.name.toLowerCase() === args.agentId.toLowerCase());
    if (!ag) return { error: 'Agent not found' };
    return { status: ag.status, cli: ag.cli, role: ag.role };
  },
});

export const planAction = tool({
  name: 'plan_action',
  description: 'Propose an action to instruct another agent. You MUST use this tool when you intend to change/build/deploy something or otherwise instruct an agent. The human will review your plan before anything is sent.',
  inputSchema: z.object({
    description: z.string().describe('A plain language explanation of what you want to do and why.'),
    targetAgent: z.string().describe('The name or ID of the agent you want to instruct.'),
    targetProject: z.string().describe('The ID of the project.'),
    proposedMessage: z.string().describe('The exact message or instruction you want to send to the agent.'),
  }),
  callback: async (args: { description: string; targetAgent: string; targetProject: string; proposedMessage: string }) => {
    const res = await fetch(`${SERVER_URL}/api/projects/${encodeURIComponent(args.targetProject)}/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(args),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { error: json.error || `HTTP ${res.status}` };
    return { success: true, message: 'Plan submitted for human approval. Await their decision.' };
  },
});
