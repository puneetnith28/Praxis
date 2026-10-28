/**
 * Each LocalHarness agent runs with its own LocalHarness config directory,
 * handed to it as LOCALHARNESS_DIR. That is how Bedrock points the agent at
 * the local model server and attaches its own MCP server, without touching
 * the user's ~/.localharness.
 *
 * The config file itself is written by LocalHarness (`localharness init`), not
 * by Bedrock. Its schema is strict — unknown keys are refused — and versioned,
 * and the one program guaranteed to write it correctly is the one that reads
 * it. Bedrock adds a single file: the root agent's definition, so that the
 * agent can carry Bedrock's MCP server. LocalHarness mints that same file with
 * three fields when it is absent; Bedrock writes those three plus `tools`.
 *
 * `init` probes the model server, which takes seconds, so it runs only when
 * the directory is new or the endpoint or model changed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

/** Agent ids are UUIDs; refuse anything else before it reaches a path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The root agent LocalHarness opens when no `--agent` is given (start_cmd.default_root_agent). */
const ROOT_AGENT = 'orchestrator';
/** What LocalHarness itself writes as that agent's role when it mints one. */
const ROOT_ROLE = 'General-purpose assistant';

/** Bedrock's MCP server for this agent, as `tools.mcp_servers` expects it. */
export interface LocalHarnessMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface PrepareOptions {
  /** The `localharness` executable. */
  binary: string;
  /** Arguments placed before the subcommand (tests run a script under node). */
  binaryArgs?: string[];
  /** Run through the shell — only for a `.cmd` / `.bat` shim on Windows. */
  shell?: boolean;
  baseUrl: string;
  model: string;
  /** MCP server to attach, or null for none. */
  mcp: LocalHarnessMcpServer | null;
  /** How long `init` may take, including its model-server probe. */
  initTimeoutMs?: number;
}

/** What `init` was last run with, so an unchanged directory is not re-initialised. */
interface Stamp {
  baseUrl: string;
  model: string;
}

export function localHarnessRoot(): string {
  return path.join(os.homedir(), '.conduit', 'localharness');
}

export function configDirFor(agentId: string): string {
  if (!SAFE_ID.test(agentId)) throw new Error('Invalid agent id');
  return path.join(localHarnessRoot(), agentId);
}

/** The environment a LocalHarness process for this agent must run with. */
export function localHarnessEnv(agentId: string): Record<string, string> {
  return { LOCALHARNESS_DIR: configDirFor(agentId) };
}

/**
 * Make sure the agent's config directory exists, is initialised against
 * `baseUrl` / `model`, and carries the requested MCP server. Returns the
 * directory. Throws with LocalHarness's own explanation when `init` fails —
 * usually that the model server did not answer.
 */
export async function prepareConfigDir(agentId: string, opts: PrepareOptions): Promise<string> {
  const dir = configDirFor(agentId);
  fs.mkdirSync(dir, { recursive: true });

  const configFile = path.join(dir, 'config.yaml');
  const stampFile = path.join(dir, 'bedrock.json');
  const stamp = readStamp(stampFile);
  const hasConfig = fs.existsSync(configFile);
  const current = hasConfig && stamp?.baseUrl === opts.baseUrl && stamp?.model === opts.model;

  if (!current) {
    await runInit(dir, opts, hasConfig);
    fs.writeFileSync(stampFile, JSON.stringify({ baseUrl: opts.baseUrl, model: opts.model } satisfies Stamp, null, 2));
  }

  writeRootAgent(dir, opts.mcp);
  return dir;
}

/** Delete the agent's config directory. Best-effort: never blocks an agent delete. */
export function removeConfigDir(agentId: string): void {
  try { fs.rmSync(configDirFor(agentId), { recursive: true, force: true }); } catch { /* best effort */ }
}

function readStamp(file: string): Stamp | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return typeof s?.baseUrl === 'string' && typeof s?.model === 'string' ? s : null;
  } catch {
    return null;
  }
}

/**
 * The root agent file. Written as JSON, which is valid YAML: there is no YAML
 * library in this project, and JSON needs no quoting rules of its own — a
 * Windows path or a password in an env var cannot break it.
 */
function writeRootAgent(dir: string, mcp: LocalHarnessMcpServer | null): void {
  const agentsDir = path.join(dir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const agent: Record<string, unknown> = { name: ROOT_AGENT, role: ROOT_ROLE, model: 'inherit' };
  if (mcp) {
    agent.tools = {
      mcp_servers: [{
        // Tools arrive prefixed with this name: bedrock_message_agent, bedrock_list_teammates.
        name: 'bedrock',
        transport: 'stdio',
        command: mcp.command,
        args: mcp.args,
        env: mcp.env || {},
      }],
    };
  }
  fs.writeFileSync(path.join(agentsDir, `${ROOT_AGENT}.yaml`), JSON.stringify(agent, null, 2) + '\n', 'utf-8');
}

function runInit(dir: string, opts: PrepareOptions, force: boolean): Promise<void> {
  const args = [
    ...(opts.binaryArgs || []),
    'init',
    '--endpoint', opts.baseUrl,
    '--model', opts.model,
    '--config-dir', dir,
    '--no-input',
    ...(force ? ['--force'] : []),
  ];
  const timeoutMs = opts.initTimeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(opts.binary, args, {
      cwd: dir,
      env: { ...process.env, LOCALHARNESS_DIR: dir },
      shell: opts.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (d: Buffer) => { out = (out + d.toString()).slice(-8_000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      reject(new Error(`LocalHarness setup did not finish within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not run \`localharness init\`: ${err.message}`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(); return; }
      reject(new Error(`LocalHarness setup failed: ${initReason(out) || `exit code ${code}`}`));
    });
  });
}

/**
 * The sentence `init` ends with when it refuses ("Error: no answer from …").
 * Rich wraps it across lines; join them back into one.
 */
function initReason(output: string): string {
  const text = output.replace(/\r/g, '');
  const at = text.lastIndexOf('Error:');
  const tail = at >= 0 ? text.slice(at + 'Error:'.length) : text.trim().split('\n').slice(-3).join('\n');
  return tail.split('\n').map((l) => l.trim()).filter(Boolean).join(' ').slice(0, 600);
}
