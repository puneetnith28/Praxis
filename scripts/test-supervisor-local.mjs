#!/usr/bin/env node
// The Supervisor on a local OpenAI-compatible model server: still a Strands
// Agent (OpenAIModel, Chat Completions), reporting through report_update,
// against a mock server — no cloud credentials, no model download.
import fs from 'node:fs';
import http from 'node:http';
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

let pass = 0, fail = 0;
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// A chat-completions server that answers the first call with a report_update
// tool call and the follow-up with plain text.
const seen = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'local-sup' }] }));
    }
    const body = JSON.parse(raw || '{}');
    seen.push(body);
    const afterTool = (body.messages || []).some((m) => m.role === 'tool');
    const id = 'c1';
    const created = 1;
    const args = JSON.stringify({ classification: 'blocker', summary: 'The build is failing on a missing module.' });
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const message = afterTool
        ? { role: 'assistant', content: 'Reported.' }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'report_update', arguments: args } }] };
      return res.end(JSON.stringify({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message, finish_reason: afterTool ? 'stop' : 'tool_calls' }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    chunk({ role: 'assistant', content: '' });
    if (afterTool) { chunk({ content: 'Reported.' }); chunk({}, 'stop'); }
    else {
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'report_update', arguments: '' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] });
      chunk({}, 'tool_calls');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
delete process.env.LOCAL_LLM_MODEL;

// supervisorProvider also reads ~/.conduit/settings.json: keep it out of the real home.
const os = await import('node:os');
const path = await import('node:path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-sup-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const { supervisorProvider } = await import('../src/strands/config.ts');
const { createSupervisorAgent } = await import('../src/strands/agent.ts');

console.log('\nSupervisor on a local model\n');

try {
  for (const [v, want] of [['local', 'local'], ['ollama', 'local'], ['lmstudio', 'local'], ['', 'auto'], ['bedrock', 'bedrock'], ['claude', 'anthropic']]) {
    process.env.SUPERVISOR_PROVIDER = v;
    t(supervisorProvider() === want, `SUPERVISOR_PROVIDER="${v}" means ${want}`);
  }

  const updates = [];
  const agent = createSupervisorAgent((u) => updates.push(u), 'local', 'local-sup');
  await agent.invoke('Terminal output:\nError: Cannot find module "left-pad"');
  t(updates.length === 1, 'the Strands agent called report_update once', JSON.stringify(updates));
  t(updates[0]?.classification === 'blocker' && /missing module/.test(updates[0]?.summary || ''), 'with the classification the model chose');
  t(seen.length >= 1 && seen[0].model === 'local-sup', 'the request named the local model');
  t((seen[0]?.tools || []).some((x) => x.function?.name === 'report_update'), 'and offered the Supervisor\'s tools');
} catch (err) {
  t(false, 'the local Supervisor agent ran', err?.stack || String(err));
} finally {
  await new Promise((r) => server.close(r));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
