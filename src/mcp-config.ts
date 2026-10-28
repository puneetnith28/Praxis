/**
 * Writes MCP server configuration for each agent so the CLI tools auto-spawn
 * the Conduit MCP server when they start.
 *
 * - Claude Code: writes a session-scoped JSON config to
 *   ~/.conduit/mcp-configs/<agentId>.json and expects the CLI to be invoked
 *   with `--mcp-config <path>`. Does NOT touch ~/.claude.json so the user's
 *   global MCP setup stays untouched.
 * - Codex CLI: ~/.codex/config.toml, per-agent-id keyed server name
 *   (Codex does not support a per-session MCP flag, so we use a unique key
 *    per agent to avoid collisions.)
 *
 * All writes are idempotent and only touch the Conduit-owned keys.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Agent } from './types.js';
import { getAuthConfig } from './auth.js';

/** Directory holding per-agent Claude MCP config JSON files. */
export function getClaudeMcpConfigDir(): string {
  return path.join(os.homedir(), '.conduit', 'mcp-configs');
}

/** Absolute path to the per-agent Claude MCP config JSON file. */
export function getClaudeMcpConfigPath(agentId: string): string {
  return path.join(getClaudeMcpConfigDir(), `${agentId}.json`);
}

export interface McpWriteContext {
  agent: Agent;
  agentCwd: string;         // resolved cwd (already expanded)
  hubUrl: string;           // e.g. http://localhost:3200
  mcpServerPath: string;    // absolute path to compiled dist/mcp-server.js
}

/**
 * Build the command + args array for the per-agent MCP server. Uses the same
 * node binary that runs the daemon, so a PATH without `node` still works.
 */
function buildInvocation(ctx: McpWriteContext): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      ctx.mcpServerPath,
      '--hub', ctx.hubUrl,
      '--project', ctx.agent.projectId,
      '--agent', ctx.agent.id,
      '--name', ctx.agent.name,
    ],
  };
}

/**
 * The per-agent MCP server as a stdio command: what to run, with what, in
 * which environment. Every CLI that can host it gets this same definition —
 * Claude through `--mcp-config`, LocalHarness through its agent's
 * `tools.mcp_servers`.
 */
export function bedrockMcpServer(ctx: McpWriteContext): { command: string; args: string[]; env: Record<string, string> } {
  const invocation = buildInvocation(ctx);
  // When the web server is password-protected, the MCP server needs the same
  // credential to call back into it.
  const auth = getAuthConfig();
  const env: Record<string, string> = {};
  if (auth) env.CONDUIT_AUTH = `${auth.user}:${auth.pass}`;
  // In the packaged desktop app `process.execPath` is Conduit.exe, not node.
  // Say so explicitly rather than relying on the variable happening to survive
  // daemon → shell → agent CLI → MCP child inheritance.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return { ...invocation, env };
}

/**
 * Write a session-scoped MCP config JSON for a Claude agent. The file is
 * passed to Claude Code via `--mcp-config <path>` so the Conduit MCP server
 * is only loaded for this specific session (and is cleanly removed when the
 * file is deleted). Does not touch the user's global ~/.claude.json.
 */
export function writeClaudeMcpConfig(ctx: McpWriteContext): string {
  const dir = getClaudeMcpConfigDir();
  fs.mkdirSync(dir, { recursive: true });

  const { command, args, env } = bedrockMcpServer(ctx);
  const configPath = getClaudeMcpConfigPath(ctx.agent.id);
  const config = {
    mcpServers: {
      conduit: {
        type: 'stdio',
        command,
        args,
        ...(Object.keys(env).length ? { env } : {}),
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}

/**
 * Remove Conduit MCP config for a Claude agent. Just deletes the per-agent
 * JSON file; ~/.claude.json is never touched.
 */
export function removeClaudeMcpConfig(agentId: string): void {
  const configPath = getClaudeMcpConfigPath(agentId);
  if (fs.existsSync(configPath)) {
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
  }
}

/**
 * Remove every Conduit-managed `[mcp_servers.conduit_*]` section from the
 * global ~/.codex/config.toml.
 *
 * v2.2: Codex agents moved to `codex app-server`, which loads its MCP servers
 * from this global file. The PTY era left per-agent `conduit_*` entries here;
 * they no longer correspond to anything and just produce startup-failure
 * noise. This is a one-time cleanup — only the `conduit_`-prefixed sections
 * (which Conduit itself wrote) are touched; the user's own config is left
 * exactly as-is. Returns the number of sections removed.
 */
export function cleanStaleCodexMcp(): number {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(configPath)) return 0;

  const before = fs.readFileSync(configPath, 'utf-8');
  const count = (before.match(/\[mcp_servers\.conduit_/g) || []).length;
  if (count === 0) return 0;

  let out = before
    // each [mcp_servers.conduit_*] section, up to the next section or EOF
    .replace(/(?:^|\n)\[mcp_servers\.conduit_[^\]\n]*\][\s\S]*?(?=\n\[|\n*$)/g, '\n')
    // the now-orphaned managed-section header comment
    .replace(/\n*#[^\n]*Conduit MCP servers[^\n]*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  out = out.length > 0 ? out + '\n' : '';

  // Safety: never blank out a file that had real content.
  if (out.trim() === '' && before.trim() !== '') return 0;

  fs.writeFileSync(configPath, out, 'utf-8');
  return count;
}

