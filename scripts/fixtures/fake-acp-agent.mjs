#!/usr/bin/env node
// A stand-in for `localharness acp`: an Agent Client Protocol agent on stdio.
//
// It speaks the same wire format (newline-delimited JSON-RPC 2.0, camelCase
// fields) and keeps the LocalHarness behaviours the tests depend on: one
// session per process, permission requests offering the four ACP option kinds,
// `session/cancel` ending a turn with `cancelled`, and a failed start that
// explains itself on stderr. The prompt text picks the script:
//
//   hello   → two message chunks, then end_turn
//   slowstart → bring-up progress lines, then the answer
//   countpokes → after 1.2s, how many blank lines arrived on stdin meanwhile
//   think   → a thought chunk, then a message
//   write   → an edit tool call that asks permission first
//   slow    → waits until cancelled
//   crash   → exits mid-turn with a reason on stderr
//   echo:X  → replies with X (used for injected messages)
//
// A leading "[Message from X]: " is skipped before choosing, as a real agent
// would read past it.
//
// FAKE_ACP_FAIL_START=1 makes it refuse to start, as a missing config would.

import readline from 'node:readline';

if (process.env.FAKE_ACP_FAIL_START === '1') {
  process.stderr.write('Error: no config at ' + (process.env.LOCALHARNESS_DIR || '~/.localharness') + '\n');
  process.exit(1);
}

let nextId = 1000;
let sessionId = null;
let mode = 'auto';
let pendingCancel = null;
let pokes = 0;
const waiting = new Map();

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const update = (u) => send({ method: 'session/update', params: { sessionId, update: u } });
const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

/** Ask the client something and wait for the answer. */
function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function runTurn(text) {
  if (text === 'hello') {
    say('Hello');
    say(' world');
    return 'end_turn';
  }
  if (text === 'trustme') {
    // LocalHarness's workspace-trust question: only a permanent yes is offered.
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'ask-trust', title: 'Trust this workspace? LocalHarness will load its config.', kind: 'other', status: 'pending' },
      options: [
        { optionId: 'allow_always', name: 'Trust this workspace', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Not now', kind: 'reject_once' },
      ],
    });
    say(answer?.outcome?.outcome === 'selected' ? 'trusted:' + answer.outcome.optionId : 'not trusted');
    return 'end_turn';
  }
  if (text === 'countpokes') {
    // How many blank lines arrived while this turn was waiting.
    const before = pokes;
    await new Promise((r) => setTimeout(r, 1200));
    say(String(pokes - before));
    return 'end_turn';
  }
  if (text === 'slowstart') {
    // LocalHarness's bring-up progress lines, streamed as agent text, then the answer.
    say('Starting the session — 2s so far…');
    say('Starting the session — 17s so far…');
    say('ready');
    return 'end_turn';
  }
  if (text === 'think') {
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Considering it.' } });
    say('Done thinking.');
    return 'end_turn';
  }
  if (text === 'write') {
    const toolCall = {
      toolCallId: 'call-1',
      title: 'write notes.md',
      kind: 'edit',
      status: 'pending',
      rawInput: { path: 'notes.md', content: 'hi' },
      locations: [{ path: 'notes.md' }],
    };
    update({ sessionUpdate: 'tool_call', ...toolCall, status: 'in_progress' });
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow in this workspace', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
        { optionId: 'reject_always', name: 'Never allow in this workspace', kind: 'reject_always' },
      ],
    });
    const outcome = answer?.outcome;
    if (outcome?.outcome === 'cancelled') return 'cancelled';
    const allowed = outcome?.outcome === 'selected' && String(outcome.optionId).startsWith('allow');
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: allowed ? 'completed' : 'failed',
      content: [{ type: 'content', content: { type: 'text', text: allowed ? 'wrote 2 bytes' : 'denied' } }],
      rawOutput: allowed ? 'wrote 2 bytes' : 'denied',
    });
    say(allowed ? `Wrote notes.md (${outcome.optionId}).` : 'Skipped the write.');
    return 'end_turn';
  }
  if (text === 'slow') {
    return new Promise((resolve) => { pendingCancel = () => resolve('cancelled'); });
  }
  if (text === 'crash') {
    process.stderr.write('Traceback: the model server went away\n');
    process.exit(3);
  }
  if (text.startsWith('echo:')) {
    say(text.slice(5));
    return 'end_turn';
  }
  say(`You said: ${text}`);
  return 'end_turn';
}

async function onRequest(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: true } },
        authMethods: [],
      });
    case 'session/new':
      // LocalHarness serves exactly one thread per process.
      if (sessionId) return fail(id, -32000, 'This agent server already has a session.');
      sessionId = 'sess-' + process.pid;
      return reply(id, {
        sessionId,
        modes: {
          currentModeId: mode,
          availableModes: ['auto', 'guarded', 'trusted', 'unattended', 'read-only']
            .map((m) => ({ id: m, name: m })),
        },
      });
    case 'session/set_mode':
      if (params.sessionId !== sessionId) return fail(id, -32602, 'unknown session');
      mode = params.modeId;
      update({ sessionUpdate: 'current_mode_update', currentModeId: mode });
      return reply(id, {});
    case 'session/prompt': {
      if (params.sessionId !== sessionId) return fail(id, -32602, 'unknown session');
      const text = (params.prompt || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      // A teammate's or the orchestrator's message arrives as
      // "[Message from X]: …" — read past that to pick the script.
      const stopReason = await runTurn(text.trim().replace(/^\[Message from [^\]]*\]:\s*/, ''));
      return reply(id, { stopReason });
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  // Blank lines are the client's keep-awake writes: not messages, but counted.
  if (!line.trim()) { pokes++; return; }
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    resolve?.(msg.result);
    return;
  }
  if (msg.method === 'session/cancel') {
    // Cancel answers any open question with `cancelled`, as ACP requires.
    for (const [, resolve] of waiting) resolve({ outcome: { outcome: 'cancelled' } });
    waiting.clear();
    pendingCancel?.();
    pendingCancel = null;
    return;
  }
  if (msg.id !== undefined) void onRequest(msg);
});
rl.on('close', () => process.exit(0));
