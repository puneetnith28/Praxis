/**
 * Everything a LocalHarness agent needs before its process starts.
 *
 * The registry's preflight (checkCliReady) proves the binary is installed. It
 * is synchronous, and the other half of "can this start?" is not: whether the
 * local model server answers, and which model to use, takes a network call.
 * That happens here, so a server that is down is reported as one sentence on
 * start — instead of an agent that starts, prints a bring-up failure and dies.
 */
import { findOnPath } from '../cli-registry.js';
import { listLocalModels, localLlmSettings, pickModel } from '../local-llm.js';
import { bedrockMcpServer } from '../mcp-config.js';
import { AgentStartError, expandHome, getHubUrl, getMcpServerPath } from '../pty-manager.js';
import type { Agent } from '../types.js';
import { prepareConfigDir, type LocalHarnessMcpServer } from './config-dir.js';

export interface PreparedLocalHarness {
  configDir: string;
  baseUrl: string;
  model: string;
  /** The resolved executable, and whether it needs a shell (a .cmd shim). */
  binary: string;
  /** Arguments before the subcommand — empty except under test. */
  binaryArgs: string[];
  shell: boolean;
  /** Whether Bedrock's MCP server is attached (false when it is not built). */
  mcp: boolean;
}

/** Test seam: run something other than the installed `localharness`. */
export interface PrepareDeps {
  binary?: string;
  binaryArgs?: string[];
}

export async function prepareLocalHarnessAgent(agent: Agent, deps: PrepareDeps = {}): Promise<PreparedLocalHarness> {
  const settings = localLlmSettings();
  const probe = await listLocalModels(settings);
  if (!probe.ok) throw new AgentStartError(probe.error);

  const model = pickModel(settings, probe);
  if (!model) {
    throw new AgentStartError(
      `The model server at ${settings.baseUrl} is running but serves no model. `
      + 'Pull one first (for Ollama: `ollama pull qwen3:8b`), or set LOCAL_LLM_MODEL.',
    );
  }
  if (settings.model && probe.models.length && !probe.models.includes(settings.model)) {
    throw new AgentStartError(
      `The model server at ${settings.baseUrl} does not serve "${settings.model}" (LOCAL_LLM_MODEL). `
      + `It serves: ${probe.models.slice(0, 8).join(', ')}${probe.models.length > 8 ? ', …' : ''}.`,
    );
  }

  const binary = deps.binary || findOnPath('localharness');
  if (!binary) throw new AgentStartError('LocalHarness is not installed. Install it with:  uv tool install localharness');
  const shell = !deps.binary && /\.(cmd|bat)$/i.test(binary);

  let mcp: LocalHarnessMcpServer | null = null;
  const mcpServerPath = getMcpServerPath();
  if (mcpServerPath) {
    mcp = bedrockMcpServer({ agent, agentCwd: expandHome(agent.cwd), hubUrl: getHubUrl(), mcpServerPath });
  }

  let configDir: string;
  try {
    configDir = await prepareConfigDir(agent.id, {
      binary,
      binaryArgs: deps.binaryArgs,
      shell,
      baseUrl: settings.baseUrl,
      model,
      mcp,
    });
  } catch (err) {
    throw new AgentStartError((err as Error).message);
  }
  return { configDir, baseUrl: settings.baseUrl, model, binary, binaryArgs: deps.binaryArgs || [], shell, mcp: !!mcp };
}
