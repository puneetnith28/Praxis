#!/usr/bin/env node
// LocalHarness agents as ACP sessions, driven against a fake ACP agent:
// lifecycle, item mapping, exact status, the prompt queue, cancel, and crashes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const asTs = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (fs.existsSync(fileURLToPath(asTs))) return { url: asTs.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

// storage.ts fixes its base dir at import time, so redirect home first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-lh-agents-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const storage = await import('../src/storage.ts');
const lh = await import('../src/daemon/localharness-agents.ts');
const { PRIMARY_MARKER } = await import('../src/instruction-files.ts');

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
async function waitFor(pred, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

const cwd = path.join(home, 'proj');
fs.mkdirSync(cwd, { recursive: true });
const project = storage.createProject('LH Demo', cwd);
const prepared = {
  configDir: path.join(home, 'cfg'), baseUrl: 'http://127.0.0.1:11434/v1', model: 'test-model',
  binary: process.execPath, binaryArgs: [FAKE], shell: false, mcp: true,
};
const statuses = [];
const onStatus = (id, st) => statuses.push(`${id}:${st}`);
const items = (id) => lh.getItems(id);
const last = (id, kind) => [...items(id)].reverse().find((i) => i.kind === kind);

console.log('\nLocalHarness ACP agent tests\n');

try {
  // 1. Start.
  const agent = storage.createAgent(project.id, 'Local', 'localharness', cwd);
  t(await lh.startAgent(agent, onStatus, prepared), 'starts');
  t(lh.isAgentRunning(agent.id), 'is running');
  t(statuses.join(',') === `${agent.id}:running,${agent.id}:awaiting_input`, 'reports running, then waiting for input', statuses.join(','));
  t(items(agent.id).some((i) => i.kind === 'system' && /LocalHarness online — test-model/.test(i.text)), 'announces the model it runs on');
  t(await waitFor(() => lh.getSessionInfo(agent.id)?.mode === 'guarded'), 'switches the session to guarded mode');
  t(lh.getSessionInfo(agent.id).modes.length === 5, 'knows the five permission modes');
  t(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf-8').includes(PRIMARY_MARKER), 'writes Bedrock\'s section into the instruction file');
  t(storage.getAgent(project.id, agent.id).status === 'running', 'storage records it as running');

  // 2. A turn from the composer.
  statuses.length = 0;
  lh.writeToAgent(agent.id, 'hel');
  lh.writeToAgent(agent.id, 'lo\r');
  t(await waitFor(() => last(agent.id, 'message')?.text === 'Hello world' && last(agent.id, 'message').status === 'done'),
    'streams the reply into one finished message item');
  t(items(agent.id).some((i) => i.kind === 'message' && i.role === 'user' && i.text === 'hello'), 'shows the prompt as a user message');
  t(await waitFor(() => statuses.at(-1) === `${agent.id}:awaiting_input`) && statuses.includes(`${agent.id}:running`),
    'is running during the turn, waiting for input after it', statuses.join(','));

  // 3. ask_agent semantics: the reply of exactly that turn.
  const asked = await lh.askAgent(agent.id, 'echo:pong');
  t(asked.stopReason === 'end_turn' && asked.text === 'pong', 'askAgent returns the turn\'s reply', JSON.stringify(asked));

  // 4. The queue: prompts sent mid-turn run afterwards, in order.
  const slow = lh.askAgent(agent.id, 'slow');
  t(lh.injectMessage(agent.id, 'Ana', 'echo:first'), 'accepts an injected message while busy');
  lh.injectMessage(agent.id, 'Ana', 'echo:second');
  t(lh.getSessionInfo(agent.id).queued === 2, 'holds both messages in the queue');
  t(lh.interruptAgent(agent.id), 'interrupt cancels the running turn');
  t((await slow).stopReason === 'cancelled', 'the cancelled turn reports cancelled');
  const agentTexts = () => items(agent.id).filter((i) => i.kind === 'message' && i.role === 'agent').map((i) => i.text);
  t(await waitFor(() => agentTexts().slice(-2).join('|') === 'first|second'),
    'then runs the queued messages in order', agentTexts().slice(-2).join('|'));
  t(items(agent.id).some((i) => i.kind === 'message' && i.role === 'user' && i.text === '[Message from Ana]: echo:first'),
    'each attributed to its sender in the transcript');
  t(items(agent.id).some((i) => i.kind === 'system' && i.text === 'Turn cancelled.'), 'says the turn was cancelled');
  t(!lh.interruptAgent(agent.id) || lh.getSessionInfo(agent.id).busy, 'interrupt is a no-op when idle');

  // 4b. Bring-up progress is not a reply.
  const slowstart = await lh.askAgent(agent.id, 'slowstart');
  t(slowstart.text === 'ready', 'bring-up progress lines are not part of the reply', JSON.stringify(slowstart.text));
  const bringup = items(agent.id).filter((i) => i.id.startsWith('bringup-'));
  t(bringup.length === 1 && bringup[0].kind === 'system' && /17s so far/.test(bringup[0].text),
    'they show as one system line that updates in place', JSON.stringify(bringup.map((b) => b.text)));

  // 5. Reasoning.
  await lh.askAgent(agent.id, 'think');
  t(items(agent.id).some((i) => i.kind === 'reasoning' && i.text === 'Considering it.'), 'thought chunks become a reasoning item');

  // 6. A permission request before gates exist is refused, never approved.
  const w = await lh.askAgent(agent.id, 'write');
  const file = last(agent.id, 'file');
  t(file?.path === 'notes.md', 'an edit tool call becomes a file item');
  t(w.stopReason === 'cancelled' && file.status === 'failed', 'and the unanswerable permission request is refused', JSON.stringify(w));

  // 6b. With gates wired in, a permission request waits for a human.
  const raised = [];
  const cleared = [];
  lh.setPermissionHandlers({
    raise: (projectId, agentId, prompt, options) => { raised.push({ agentId, prompt, options }); return true; },
    cleared: (_projectId, agentId) => cleared.push(agentId),
  });
  statuses.length = 0;
  const pending = lh.askAgent(agent.id, 'write');
  t(await waitFor(() => raised.length === 1), 'a permission request raises a gate');
  t(/asks permission/.test(raised[0].prompt) && /write notes\.md/.test(raised[0].prompt) && /path: notes\.md/.test(raised[0].prompt),
    'the gate says what is asked and where', raised[0].prompt);
  t(raised[0].options.map((o) => o.id).join(',') === 'allow_once,allow_always,reject_once,reject_always',
    'and carries the four answers the agent offered');
  t(statuses.at(-1) === `${agent.id}:awaiting_input`, 'the agent shows as waiting on the human meanwhile', statuses.join(','));
  t(lh.answerPermission(agent.id, 'allow_always'), 'answering resolves the request');
  const allowed = await pending;
  t(/allow_always/.test(allowed.text), 'the agent proceeds with exactly the chosen answer', allowed.text);
  t(last(agent.id, 'file').status === 'done', 'and its tool call completes');
  t(!lh.answerPermission(agent.id, 'allow_once'), 'nothing is pending afterwards');

  const p2 = lh.askAgent(agent.id, 'write');
  await waitFor(() => raised.length === 2);
  lh.answerPermission(agent.id, 'not-an-offered-option');
  t((await p2).stopReason === 'cancelled', 'an option the agent did not offer is a refusal, not a yes');

  const p3 = lh.askAgent(agent.id, 'write');
  await waitFor(() => raised.length === 3);
  lh.interruptAgent(agent.id);
  t((await p3).stopReason === 'cancelled' && cleared.includes(agent.id), 'cancelling while it waits refuses it and takes the gate down');

  lh.setPermissionHandlers({ raise: () => false, cleared: () => {} });
  const p4 = await lh.askAgent(agent.id, 'write');
  t(p4.stopReason === 'cancelled', 'a request whose gate cannot be raised is refused, not left hanging');
  lh.setPermissionHandlers(null);

  // 6c. Controls: permission mode.
  const toTrusted = await lh.setMode(agent.id, 'trusted');
  t(toTrusted.ok && await waitFor(() => lh.getSessionInfo(agent.id)?.mode === 'trusted'), 'setMode switches the session mode');
  const bogus = await lh.setMode(agent.id, 'yolo');
  t(!bogus.ok && /not one of this session's modes/.test(bogus.error || ''), 'a mode the session did not offer is refused');
  await lh.setMode(agent.id, 'guarded');
  t((await lh.setMode('no-such-agent', 'auto')).ok === false, 'setMode on a stopped agent says so');

  // 7. The Supervisor's text view.
  const seen = [];
  const off = lh.subscribeText(agent.id, (txt) => seen.push(txt));
  await lh.askAgent(agent.id, 'echo:for the supervisor');
  off();
  t(seen.some((s) => s.includes('for the supervisor')), 'subscribeText delivers finished agent messages');
  t(lh.getAgentPreview(agent.id) === 'for the supervisor', 'the preview is the last message');

  // 8. Stop.
  statuses.length = 0;
  t(lh.stopAgent(agent.id), 'stops');
  t(!lh.isAgentRunning(agent.id) && statuses.at(-1) === `${agent.id}:stopped`, 'reports stopped');
  t(storage.getAgent(project.id, agent.id).status === 'stopped', 'storage records it as stopped');
  t(!lh.stopAgent(agent.id), 'stopping twice is a no-op');

  // 9. A crash mid-turn.
  const crashy = storage.createAgent(project.id, 'Crashy', 'localharness', cwd);
  await lh.startAgent(crashy, onStatus, prepared);
  const items0 = [];
  lh.subscribeItems(crashy.id, (i) => items0.push(i));
  const c = await lh.askAgent(crashy.id, 'crash');
  t(c.stopReason === 'error' && /exited \(code 3\)/.test(c.error || ''), 'a crash ends the open turn with the exit code', JSON.stringify(c));
  const errs = items0.filter((i) => i.kind === 'error');
  t(errs.length === 1 && /model server went away/.test(errs[0].text), 'one error item, carrying the agent\'s stderr', JSON.stringify(errs.map((e) => e.text)));
  t(!lh.isAgentRunning(crashy.id) && storage.getAgent(project.id, crashy.id).status === 'stopped', 'a crashed agent is stopped');
  t(storage.getAgent(project.id, crashy.id).lastExitCode === 3, 'and its exit code is recorded');

  // 10. An agent that cannot start reports why.
  process.env.FAKE_ACP_FAIL_START = '1';
  const broken = storage.createAgent(project.id, 'Broken', 'localharness', cwd);
  try {
    await lh.startAgent(broken, onStatus, prepared);
    t(false, 'a failed start throws');
  } catch (err) {
    t(err.name === 'AgentStartError' && /LocalHarness did not start[\s\S]*no config/.test(err.message), 'a failed start throws with the agent\'s reason', err.message);
  }
  delete process.env.FAKE_ACP_FAIL_START;
  t(!lh.isAgentRunning(broken.id), 'and leaves nothing running');
} finally {
  for (const id of lh.getRunningAgentIds()) lh.stopAgent(id);
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
