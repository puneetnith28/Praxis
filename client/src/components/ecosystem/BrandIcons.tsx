import React from 'react';

// Official, precision SVG brand icons pulled from official brand asset repositories
export const BrandIcons: Record<string, React.FC<{ size?: number }>> = {
  // Coding Agents
  claude: ({ size = 20 }) => (
    <img src="/icons/claude.svg" alt="Claude" width={size} height={size} className="brand-icon-img" />
  ),
  openai: ({ size = 20 }) => (
    <img src="/icons/openai.svg" alt="OpenAI" width={size} height={size} className="brand-icon-img" />
  ),
  gemini: ({ size = 20 }) => (
    <img src="/icons/gemini.svg" alt="Gemini" width={size} height={size} className="brand-icon-img" />
  ),
  opencode: ({ size = 20 }) => (
    <img src="/icons/opencode.svg" alt="OpenCode" width={size} height={size} className="brand-icon-img" />
  ),
  groq: ({ size = 20 }) => (
    <img src="/icons/groq.svg" alt="Groq" width={size} height={size} className="brand-icon-img" />
  ),
  nemotron: ({ size = 20 }) => (
    <img src="/icons/nvidia.svg" alt="NVIDIA Nemotron" width={size} height={size} className="brand-icon-img" />
  ),
  nvidia: ({ size = 20 }) => (
    <img src="/icons/nvidia.svg" alt="NVIDIA" width={size} height={size} className="brand-icon-img" />
  ),
  localharness: ({ size = 20 }) => (
    <img src="/icons/localharness.svg" alt="LocalHarness" width={size} height={size} className="brand-icon-img" />
  ),

  // Developer Ecosystem
  github: ({ size = 20 }) => (
    <img src="/icons/github.svg" alt="GitHub" width={size} height={size} className="brand-icon-img" />
  ),
  gitlab: ({ size = 20 }) => (
    <img src="/icons/gitlab.svg" alt="GitLab" width={size} height={size} className="brand-icon-img" />
  ),
  docker: ({ size = 20 }) => (
    <img src="/icons/docker.svg" alt="Docker" width={size} height={size} className="brand-icon-img" />
  ),
  vscode: ({ size = 20 }) => (
    <img src="/icons/vscode.svg" alt="VS Code" width={size} height={size} className="brand-icon-img" />
  ),
  nodejs: ({ size = 20 }) => (
    <img src="/icons/nodejs.svg" alt="Node.js" width={size} height={size} className="brand-icon-img" />
  ),
  npm: ({ size = 20 }) => (
    <img src="/icons/npm.svg" alt="npm" width={size} height={size} className="brand-icon-img" />
  ),

  // AI & Cloud Infrastructure
  aws: ({ size = 20 }) => (
    <img src="/icons/aws.svg" alt="AWS" width={size} height={size} className="brand-icon-img" />
  ),
  bedrock: ({ size = 20 }) => (
    <img src="/icons/bedrock.svg" alt="Amazon Bedrock" width={size} height={size} className="brand-icon-img" />
  ),
  strands: ({ size = 20 }) => (
    <img src="/icons/strands.svg" alt="Strands Supervisor" width={size} height={size} className="brand-icon-img" />
  ),
  mcp: ({ size = 20 }) => (
    <img src="/icons/mcp.svg" alt="Model Context Protocol" width={size} height={size} className="brand-icon-img" />
  ),

  // Frontend & Runtime Architecture
  react: ({ size = 20 }) => (
    <img src="/icons/react.svg" alt="React" width={size} height={size} className="brand-icon-img" />
  ),
  vite: ({ size = 20 }) => (
    <img src="/icons/vite.svg" alt="Vite" width={size} height={size} className="brand-icon-img" />
  ),
  typescript: ({ size = 20 }) => (
    <img src="/icons/typescript.svg" alt="TypeScript" width={size} height={size} className="brand-icon-img" />
  ),
  websocket: ({ size = 20 }) => (
    <img src="/icons/websocket.svg" alt="WebSocket" width={size} height={size} className="brand-icon-img" />
  ),
  xterm: ({ size = 20 }) => (
    <img src="/icons/xterm.svg" alt="xterm.js" width={size} height={size} className="brand-icon-img" />
  ),
};

export interface ToolItem {
  id: string;
  name: string;
  iconKey: string;
  category: 'agents' | 'developer' | 'infrastructure' | 'runtime';
}

export const ECOSYSTEM_ROWS: Array<{
  id: string;
  direction: 'left' | 'right';
  speedSec: number;
  tools: ToolItem[];
}> = [
  // ROW 1 — CODING AGENTS (← left)
  {
    id: 'row-agents',
    direction: 'left',
    speedSec: 36,
    tools: [
      { id: 'claude', name: 'Claude Code', iconKey: 'claude', category: 'agents' },
      { id: 'codex', name: 'OpenAI Codex', iconKey: 'openai', category: 'agents' },
      { id: 'gemini', name: 'Gemini CLI', iconKey: 'gemini', category: 'agents' },
      { id: 'opencode', name: 'OpenCode', iconKey: 'opencode', category: 'agents' },
      { id: 'gpt', name: 'GPT-OSS 120B (Groq)', iconKey: 'groq', category: 'agents' },
      { id: 'nemotron', name: 'Nemotron (OpenRouter)', iconKey: 'nemotron', category: 'agents' },
      { id: 'localharness', name: 'LocalHarness (local model)', iconKey: 'localharness', category: 'agents' },
    ],
  },
  // ROW 2 — DEVELOPER ECOSYSTEM (→ right)
  {
    id: 'row-dev',
    direction: 'right',
    speedSec: 40,
    tools: [
      { id: 'github', name: 'GitHub', iconKey: 'github', category: 'developer' },
      { id: 'gitlab', name: 'GitLab', iconKey: 'gitlab', category: 'developer' },
      { id: 'docker', name: 'Docker', iconKey: 'docker', category: 'developer' },
      { id: 'vscode', name: 'VS Code', iconKey: 'vscode', category: 'developer' },
      { id: 'nodejs', name: 'Node.js', iconKey: 'nodejs', category: 'developer' },
      { id: 'npm', name: 'npm', iconKey: 'npm', category: 'developer' },
    ],
  },
  // ROW 3 — SUPERVISOR & AI INFRASTRUCTURE (← left)
  {
    id: 'row-infra',
    direction: 'left',
    speedSec: 42,
    tools: [
      { id: 'bedrock', name: 'Amazon Bedrock', iconKey: 'bedrock', category: 'infrastructure' },
      { id: 'strands', name: 'Strands Supervisor', iconKey: 'strands', category: 'infrastructure' },
      { id: 'mcp', name: 'Model Context Protocol', iconKey: 'mcp', category: 'infrastructure' },
      { id: 'aws', name: 'AWS Cloud', iconKey: 'aws', category: 'infrastructure' },
    ],
  },
  // ROW 4 — RUNTIME ARCHITECTURE (→ right)
  {
    id: 'row-runtime',
    direction: 'right',
    speedSec: 38,
    tools: [
      { id: 'xterm', name: 'xterm.js PTY', iconKey: 'xterm', category: 'runtime' },
      { id: 'websocket', name: 'WebSocket Replay', iconKey: 'websocket', category: 'runtime' },
      { id: 'typescript', name: 'TypeScript', iconKey: 'typescript', category: 'runtime' },
      { id: 'react', name: 'React', iconKey: 'react', category: 'runtime' },
      { id: 'vite', name: 'Vite', iconKey: 'vite', category: 'runtime' },
    ],
  },
];
