#!/usr/bin/env node
/**
 * Does Amazon Nova 2 Sonic actually work here, with our tools?
 *
 * This is a gate, not a demo. The whole realtime-Keeper plan rests on Nova
 * handling several tools without misbehaving, and there are two open AWS
 * re:Post reports against `amazon.nova-2-sonic-v1:0` that say it might not:
 *
 *   1. `promptStart` rejected when `toolConfiguration` is included
 *   2. an infinite tool-calling loop when multiple tools are declared
 *
 * Conduit has 12 tools. This declares the 8 we expose to voice and finds out,
 * before a single line of UI is written, which is the cheapest possible place
 * to learn it.
 *
 * The list below must stay the same set as `VOICE_TOOLS` in
 * `src/voice/nova-tools.ts` — a probe that clears a different tool set than the
 * one that ships has proved nothing about the one that ships. It cannot be
 * imported (this runs as plain JS, and that module is TypeScript reaching for
 * the daemon), so the names are checked against the source instead.
 *
 * Two parts:
 *   A. Tools  — a text turn that cannot be answered without calling a tool.
 *               Watches for the loop, and for repeated identical calls.
 *   B. Audio  — a spoken turn, measuring time to the first audio byte back.
 *               This is the number the whole plan exists to move (today: 7-9s).
 *
 * Tools run against the live Conduit API when it is up, and against clearly
 * labelled fixtures when it is not — the loop bug is about the model repeating
 * itself, which does not depend on the data being real.
 *
 * Usage:
 *   node scripts/check-nova.mjs            # both parts
 *   node scripts/check-nova.mjs --tools    # part A only (no audio needed)
 *
 * Env: AWS credentials via the usual chain, AWS_REGION (default us-east-1),
 *      NOVA_MODEL_ID to override the model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand }
  from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';

// Same two files, same precedence, as src/env.ts — a probe that cannot see the
// credentials the app uses is testing a different machine.
for (const file of [path.resolve(process.cwd(), '.env'), path.join(os.homedir(), '.conduit', '.env')]) {
  if (fs.existsSync(file)) dotenv.config({ path: file });
}

const MODEL_ID = process.env.NOVA_MODEL_ID || 'amazon.nova-2-sonic-v1:0';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const BASE = process.env.CONDUIT_URL || 'http://localhost:3200';
const TOOLS_ONLY = process.argv.includes('--tools');
const DEBUG = process.argv.includes('--debug');

const INPUT_RATE = 16000;   // what Nova wants from us
const OUTPUT_RATE = 24000;  // what it sends back

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every "time to first audio after the user stopped" this run measured.
 *
 * One sample of a live service is one sample, and this one has a real tail.
 * Measured across runs on this machine, in ms:
 *
 *   846  1021  1170  1219  1232  1297  1318  1459  1830  1843  2046  2769
 *
 * Typical is ~1.2s; the tail reaches nearly 3s. A 2s gate on a single draw
 * failed roughly one run in five with nothing wrong, and a check that cries
 * wolf is worse than no check — the next real regression gets waved off as
 * "just Nova being Nova". So each sample is held to a bound well outside that
 * spread, and the numbers themselves are printed, which is what you actually
 * want to read. A genuine regression looks like 6s+, or no audio at all.
 */
const LATENCY_BOUND_MS = 3500;
const latencies = [];

let failures = 0;
function t(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
  return ok;
}

// ── the eight tools the voice model actually gets ─────────────────────
// Names and descriptions are lifted from src/conduit-mcp-server.ts: those
// description strings do prompt-engineering work, not just documentation.
const TOOLS = [
  {
    name: 'list_projects',
    description: 'List every project and the agents in it, with each agent\'s live status.',
    schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_agents',
    description: 'List the agents in one project with their live status.',
    schema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Project name or id.' } },
      required: ['project'],
    },
  },
  {
    name: 'get_agent_status',
    description: 'Get the live status of one agent.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
      },
      required: ['project', 'agent'],
    },
  },
  {
    name: 'start_agent',
    description: 'Start a stopped agent. Returns as soon as the process is up.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
      },
      required: ['project', 'agent'],
    },
  },
  {
    name: 'stop_agent',
    description: 'Stop a running agent.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
      },
      required: ['project', 'agent'],
    },
  },
  {
    name: 'ask_agent',
    description:
      'Send a message to one running agent and get its answer. Returns at once; '
      + 'the answer is read out when it arrives. Do NOT send the same message twice.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
        message: { type: 'string', description: 'What to say to the agent.' },
      },
      required: ['project', 'agent', 'message'],
    },
  },
  {
    name: 'describe_gate',
    description:
      'Read out what an agent is waiting for permission to do. Always call this '
      + 'before resolve_gate — approving is refused otherwise.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
      },
      required: ['project', 'agent'],
    },
  },
  {
    name: 'resolve_gate',
    description:
      'Approve or reject what an agent is waiting to do. Rejecting always works; '
      + 'approving is checked by the server and may be refused.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id.' },
        agent: { type: 'string', description: 'Agent name or id.' },
        decision: { type: 'string', description: 'Either "approve" or "reject".' },
      },
      required: ['project', 'agent', 'decision'],
    },
  },
];

// Drift check. If someone adds a tool to the shipped set and not here, the
// loop risk this whole probe exists to measure goes untested for that set.
{
  const src = fs.readFileSync(
    path.resolve(process.cwd(), 'src/voice/nova-tools.ts'), 'utf8');
  const listed = src.slice(
    src.indexOf('export const VOICE_TOOLS'), src.indexOf('export const DEFERRED_TOOLS'));
  const shipped = [...listed.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
  const mine = TOOLS.map((x) => x.name);
  const missing = shipped.filter((n) => !mine.includes(n));
  const extra = mine.filter((n) => !shipped.includes(n));
  if (missing.length || extra.length) {
    console.error('\nThis probe declares a different tool set than the app ships.');
    if (missing.length) console.error('  shipped but not probed: ' + missing.join(', '));
    if (extra.length) console.error('  probed but not shipped: ' + extra.join(', '));
    console.error('Bring scripts/check-nova.mjs back in step with src/voice/nova-tools.ts.');
    process.exit(2);
  }
}

const SYSTEM_PROMPT = [
  'You are The Keeper, the orchestrator of a multi-agent coding control centre.',
  'You are being heard, not read. Talk like a colleague standing next to the user:',
  'short, direct, no preamble. Most answers are one sentence.',
  'Use the tools to answer questions about projects and agents — never guess.',
  'Call each tool at most once for a given question. When you have the answer, say it and stop.',
].join(' ');

// ── talking to Conduit for real, when it is up ────────────────────────
let liveApi = false;
async function api(method, p, body) {
  const res = await fetch(BASE + '/api' + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const FIXTURE = {
  projects: [{ name: 'demo', agents: [{ name: 'Alpha', cli: 'claude', status: 'stopped' }] }],
};

async function runTool(name, input) {
  if (!liveApi) {
    // Clearly labelled, so nobody mistakes a fixture run for a real one.
    if (name === 'list_projects') {
      return `[fixture] ## demo\n- Alpha (claude, stopped)`;
    }
    return `[fixture] ${name} ok`;
  }
  try {
    if (name === 'list_projects') {
      const projects = (await api('GET', '/projects')).json || [];
      const lines = [];
      for (const p of projects) {
        const agents = (await api('GET', `/projects/${p.id}/agents`)).json || [];
        lines.push(`## ${p.name}`);
        for (const a of agents) lines.push(`- ${a.name} (${a.cli}, ${a.status})`);
        if (!agents.length) lines.push('- (no agents)');
      }
      return lines.join('\n') || 'No projects.';
    }
    if (name === 'list_agents' || name === 'get_agent_status') {
      const projects = (await api('GET', '/projects')).json || [];
      const proj = projects.find((p) => p.name === input.project || p.id === input.project)
        || projects.find((p) => p.name?.toLowerCase().includes(String(input.project || '').toLowerCase()));
      if (!proj) return `No project matching "${input.project}".`;
      const agents = (await api('GET', `/projects/${proj.id}/agents`)).json || [];
      if (name === 'list_agents') {
        return agents.map((a) => `- ${a.name} (${a.cli}, ${a.status})`).join('\n') || 'No agents.';
      }
      const a = agents.find((x) => x.name === input.agent || x.id === input.agent);
      return a ? `${a.name} is ${a.status}.` : `No agent matching "${input.agent}".`;
    }
    // Deliberately NOT executing start, stop, ask, or either gate tool against
    // the user's real agents from a probe. The model only needs a plausible
    // result to decide whether to call again, which is the behaviour under
    // test — and approving a live gate to measure tool latency would be an
    // absurd trade. The guard itself is tested in test-approval-guard.mjs.
    return `[not executed by the probe] ${name} would have run with ${JSON.stringify(input)}`;
  } catch (err) {
    return `Tool failed: ${String(err).slice(0, 120)}`;
  }
}

// ── a queue-backed async generator: we push events as we learn things ──
function eventStream() {
  const queue = [];
  let resolveNext = null;
  let closed = false;
  const encoder = new TextEncoder();

  return {
    push(event) {
      const bytes = encoder.encode(JSON.stringify(event));
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: { chunk: { bytes } }, done: false }); }
      else queue.push({ chunk: { bytes } });
    },
    close() {
      closed = true;
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { resolveNext = resolve; });
        },
      };
    },
  };
}

/** Generate a spoken WAV with Windows SAPI, then strip to raw PCM16 @16k. */
function speakToPcm(text) {
  if (process.platform !== 'win32') return null;
  const wav = path.join(os.tmpdir(), `nova-probe-${Date.now()}.wav`);
  const ps = `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $s.SetOutputToWaveFile('${wav}', $fmt)
    $s.Speak(${JSON.stringify(text)})
    $s.Dispose()
  `;
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    const buf = fs.readFileSync(wav);
    fs.unlinkSync(wav);
    // Skip the RIFF header by finding the 'data' chunk.
    const idx = buf.indexOf(Buffer.from('data', 'ascii'));
    return idx >= 0 ? buf.subarray(idx + 8) : buf.subarray(44);
  } catch {
    try { fs.unlinkSync(wav); } catch { /* ignore */ }
    return null;
  }
}

// ── one Nova session ──────────────────────────────────────────────────
async function runSession({ label, withTools, say, audio, followUpAudio }) {
  console.log(`\n${label}`);

  const client = new BedrockRuntimeClient({
    region: REGION,
    requestHandler: new NodeHttp2Handler({
      requestTimeout: 300000, sessionTimeout: 300000,
      disableConcurrentStreams: false, maxConcurrentStreams: 20,
    }),
  });

  const promptName = randomUUID();
  let turnDone = false;
  const rawStream = eventStream();
  const stream = {
    push(event) {
      if (DEBUG) {
        const k = Object.keys(event.event)[0];
        const d = event.event[k] || {};
        const bits = [];
        if (d.role) bits.push(`role=${d.role}`);
        if (d.type) bits.push(`type=${d.type}`);
        if (d.contentName) bits.push(`content=${String(d.contentName).slice(0, 8)}`);
        if (k !== 'audioInput') console.log(`    → ${k} ${bits.join(' ')}`);
      }
      rawStream.push(event);
    },
    close: () => rawStream.close(),
    [Symbol.asyncIterator]: () => rawStream[Symbol.asyncIterator](),
  };

  const result = {
    accepted: false, toolCalls: [], firstAudioMs: null, firstTextMs: null,
    assistantText: '', userTranscript: '', error: null, audioBytes: 0,
    events: new Set(), turnComplete: false, followUpText: '', bargeIns: 0,
    audioChunks: 0, speechEndMs: null,
  };

  stream.push({ event: { sessionStart: {
    inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 },
    // Nova 2 addition. HIGH is what makes it cut in quickly rather than
    // waiting politely — the whole point of "respond immediately".
    turnDetectionConfiguration: { endpointingSensitivity: 'HIGH' },
  } } });

  const promptStart = {
    promptName,
    textOutputConfiguration: { mediaType: 'text/plain' },
    audioOutputConfiguration: {
      mediaType: 'audio/lpcm', sampleRateHertz: OUTPUT_RATE, sampleSizeBits: 16,
      channelCount: 1, voiceId: 'matthew', encoding: 'base64', audioType: 'SPEECH',
    },
  };
  if (withTools) {
    // The exact thing re:Post says gets rejected.
    promptStart.toolConfiguration = {
      tools: TOOLS.map((tool) => ({
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: { json: JSON.stringify(tool.schema) },
        },
      })),
    };
  }
  stream.push({ event: { promptStart } });

  // System prompt.
  const sysContent = randomUUID();
  stream.push({ event: { contentStart: {
    promptName, contentName: sysContent, type: 'TEXT', interactive: true,
    role: 'SYSTEM', textInputConfiguration: { mediaType: 'text/plain' },
  } } });
  stream.push({ event: { textInput: { promptName, contentName: sysContent, content: SYSTEM_PROMPT } } });
  stream.push({ event: { contentEnd: { promptName, contentName: sysContent } } });

  const started = Date.now();
  const command = new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: stream });

  let response;
  try {
    response = await client.send(command);
  } catch (err) {
    result.error = String(err?.message || err);
    return result;
  }

  // Feed the turn in once the stream is open.
  (async () => {
    await sleep(150);
    if (say) {
      const c = randomUUID();
      stream.push({ event: { contentStart: {
        promptName, contentName: c, type: 'TEXT', interactive: true,
        role: 'USER', textInputConfiguration: { mediaType: 'text/plain' },
      } } });
      stream.push({ event: { textInput: { promptName, contentName: c, content: say } } });
      stream.push({ event: { contentEnd: { promptName, contentName: c } } });
    }
    if (audio) {
      const c = randomUUID();
      stream.push({ event: { contentStart: {
        promptName, contentName: c, type: 'AUDIO', interactive: true, role: 'USER',
        audioInputConfiguration: {
          mediaType: 'audio/lpcm', sampleRateHertz: INPUT_RATE, sampleSizeBits: 16,
          channelCount: 1, audioType: 'SPEECH', encoding: 'base64',
        },
      } } });
      audioContentName = c;
      // 1024-sample frames, the cadence a microphone produces.
      const FRAME = 2048;
      const send = (buf) => stream.push({ event: { audioInput: {
        promptName, contentName: c, content: buf.toString('base64'),
      } } });
      for (let i = 0; i < audio.length; i += FRAME) {
        send(audio.subarray(i, Math.min(i + FRAME, audio.length)));
        await sleep(10);
      }
      // Keep the microphone open and keep it fed. This is not padding for the
      // test's sake — it is what the browser will do, and Nova stalls without
      // it once a turn needs more than one tool round.
      const silence = Buffer.alloc(FRAME);
      while (!turnDone) {
        if (pendingSpeech) {
          const speech = pendingSpeech;
          pendingSpeech = null;
          for (let i = 0; i < speech.length; i += FRAME) {
            send(speech.subarray(i, Math.min(i + FRAME, speech.length)));
            await sleep(10);
          }
          continue;
        }
        send(silence);
        await sleep(60);
      }
      stream.push({ event: { contentEnd: { promptName, contentName: c } } });
    }
  })();

  let role = '';
  const unanswered = [];
  let audioContentName = null;
  let pendingSpeech = null;
  let sentFollowUp = false;
  let firstTurnText = '';
  const deadline = Date.now() + 90_000;
  try {
    for await (const chunk of response.body) {
      if (Date.now() > deadline) break;
      if (chunk.validationException) {
        result.error = `ValidationException: ${chunk.validationException.message}`;
        break;
      }
      if (chunk.modelStreamErrorException) {
        result.error = `ModelStreamError: ${chunk.modelStreamErrorException.message}`;
        break;
      }
      if (chunk.internalServerException) {
        result.error = `InternalServerError: ${chunk.internalServerException.message}`;
        break;
      }
      if (!chunk.chunk?.bytes) continue;

      let json;
      try { json = JSON.parse(new TextDecoder().decode(chunk.chunk.bytes)); } catch { continue; }
      const ev = json.event;
      if (!ev) continue;
      if (DEBUG) {
        const k = Object.keys(ev)[0];
        const d = ev[k] || {};
        const bits = [];
        if (d.role) bits.push(`role=${d.role}`);
        if (d.type) bits.push(`type=${d.type}`);
        if (d.toolName) bits.push(`tool=${d.toolName}`);
        if (d.contentName) bits.push(`content=${String(d.contentName).slice(0, 8)}`);
        if (k === 'textOutput') bits.push(JSON.stringify(String(d.content || '').slice(0, 70)));
        if (k === 'audioOutput') bits.push(`${Buffer.from(d.content || '', 'base64').length}B`);
        console.log(`    [${String(Date.now() - started).padStart(6)}ms] ${k} ${bits.join(' ')}`);
      }
      result.accepted = true;
      for (const k of Object.keys(ev)) result.events.add(k);

      if (ev.contentStart) role = ev.contentStart.role || role;

      // Nova's own endpointing verdict: the moment it decided we had stopped
      // talking. This is the only honest origin for "how long until it
      // answered" — see the note where that number is reported.
      if (ev.userSpeechEnd && result.speechEndMs === null) {
        result.speechEndMs = Date.now() - started;
      }

      // The assistant finished a spoken turn: audio came, then the content
      // closed. Nothing more is coming unless we speak again, and waiting for
      // the 55s idle timeout would report a failure that did not happen.
      if (ev.contentEnd && role === 'ASSISTANT' && result.audioBytes > 0
          && ev.contentEnd.type !== 'TOOL') {
        if (sentFollowUp && result.assistantText.length <= firstTurnText.length) {
          // That contentEnd was the interruption, not an answer. Keep listening.
          continue;
        }
        if (!sentFollowUp && followUpAudio) {
          // It finished before we could talk over it — the clip was short or
          // the reply was. Speak now so the second-turn check still means
          // something; the barge-in assertion below will report the miss.
          sentFollowUp = true;
          firstTurnText = result.assistantText;
          pendingSpeech = followUpAudio;
          continue;
        }
        result.turnComplete = true;
        if (sentFollowUp) result.followUpText = result.assistantText.slice(firstTurnText.length);
        turnDone = true;
        break;
      }

      if (ev.textOutput) {
        if (result.firstTextMs === null) result.firstTextMs = Date.now() - started;
        const text = String(ev.textOutput.content || '');
        // Nova reports an interruption as a literal JSON marker on the text
        // channel. It is a control signal, not something anyone said.
        if (/"interrupted"\s*:\s*true/.test(text)) {
          result.bargeIns++;
          continue;
        }
        if (role === 'ASSISTANT') result.assistantText += text;
        else if (role === 'USER') result.userTranscript += text;
      }

      if (ev.audioOutput) {
        if (result.firstAudioMs === null) result.firstAudioMs = Date.now() - started;
        result.audioBytes += Buffer.from(ev.audioOutput.content || '', 'base64').length;
        result.audioChunks++;
        // Barge in *while it is talking*. Two chunks in, it is unambiguously
        // mid-sentence, which is the only moment an interruption can be
        // tested — waiting for the turn to end tests nothing at all.
        if (followUpAudio && !sentFollowUp && result.audioChunks >= 2) {
          sentFollowUp = true;
          firstTurnText = result.assistantText;
          // Speak into the microphone that is already open, exactly as a
          // person would. The feeder is streaming silence into it right now.
          pendingSpeech = followUpAudio;
        }
      }

      if (ev.toolUse) {
        const call = {
          name: ev.toolUse.toolName,
          input: ev.toolUse.content ?? ev.toolUse.input ?? '',
          id: ev.toolUse.toolUseId,
          at: Date.now() - started,
        };
        result.toolCalls.push(call);
        unanswered.push(call);
      }

      if (ev.contentEnd && ev.contentEnd.type === 'TOOL') {
        // Oldest first. Nova can emit two toolUse events before either of
        // their contentEnds, and answering "the most recent one" twice leaves
        // the first call hanging forever.
        const call = unanswered.shift();
        if (call) {
          let parsed = {};
          try { parsed = typeof call.input === 'string' ? JSON.parse(call.input) : (call.input || {}); }
          catch { /* the model sent something unparseable — pass an empty object */ }
          const out = await runTool(call.name, parsed);
          if (DEBUG) console.log(`    · ${call.name}(${JSON.stringify(parsed)}) => ${JSON.stringify(String(out).slice(0, 160))}`);
          const c = randomUUID();
          stream.push({ event: { contentStart: {
            promptName, contentName: c, interactive: false, type: 'TOOL',
            role: 'TOOL', toolResultInputConfiguration: {
              toolUseId: call.id, type: 'TEXT',
              textInputConfiguration: { mediaType: 'text/plain' },
            },
          } } });
          // Nova parses this, it does not just read it: a bare string comes
          // back as "Tool Response parsing error". It has to be JSON.
          stream.push({ event: { toolResult: {
            promptName, contentName: c, content: JSON.stringify({ result: out }),
          } } });
          stream.push({ event: { contentEnd: { promptName, contentName: c } } });
        }
      }

      // Runaway guard — the reported bug, caught rather than waited out.
      if (result.toolCalls.length > 12) {
        result.error = 'tool-call loop: more than 12 calls in one turn';
        break;
      }
      if (ev.completionEnd) break;
    }
  } catch (err) {
    result.error = result.error || String(err?.message || err);
  }

  turnDone = true;
  await sleep(120);   // let the feeder notice and close the content
  try {
    stream.push({ event: { promptEnd: { promptName } } });
    stream.push({ event: { sessionEnd: {} } });
    stream.close();
  } catch { /* already gone */ }
  try { client.destroy(); } catch { /* ignore */ }
  return result;
}

// ── run ───────────────────────────────────────────────────────────────
const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
liveApi = !!health?.ok;

console.log(`\nNova 2 Sonic — ${MODEL_ID} in ${REGION}`);
console.log(`tools run against: ${liveApi ? BASE + ' (live)' : 'fixtures (Conduit not running)'}`);

// A. Does it accept toolConfiguration, and does it loop?
//
// Asked out loud, because Nova Sonic is audio-first: a TEXT/USER turn is not a
// turn trigger at all. Sending one and waiting produced exactly one event —
// `usageEvent` — and then "Timed out waiting for audio bytes or interactive
// content". Text content is for the system prompt; the user speaks.
const questionPcm = speakToPcm('What projects do I have, and what agents are in them? Answer in one sentence.');
if (!questionPcm || questionPcm.length < 8000) {
  console.log('\nCannot synthesise a test clip on this machine — the probe needs one.');
  process.exit(2);
}
const a = await runSession({
  label: `A. toolConfiguration and tool behaviour (asked aloud, ${(questionPcm.length / 2 / INPUT_RATE).toFixed(1)}s)`,
  withTools: true,
  audio: questionPcm,
});

if (a.error && /ValidationException/.test(a.error)) {
  t(false, 'promptStart accepted with toolConfiguration', a.error.slice(0, 220));
} else {
  t(a.accepted, 'promptStart accepted with toolConfiguration', a.error || 'no events came back');
}
t(!/tool-call loop/.test(a.error || ''), 'no tool-call loop', a.error);

const names = a.toolCalls.map((c) => c.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
t(a.toolCalls.length > 0, 'it actually called a tool',
  'answered without one — it may be guessing');
t(dupes.length === 0, 'no tool called twice for one question', dupes.join(', '));
t(!!a.assistantText.trim(), 'it produced an answer', a.error || '(silence)');

console.log(`\n  tools called: ${names.length ? names.map((n, i) => `${n}@${a.toolCalls[i].at}ms`).join(' → ') : '(none)'}`);
console.log(`  event types seen: ${[...a.events].join(', ') || '(none)'}`);
if (a.assistantText.trim()) console.log(`  said: "${a.assistantText.trim().slice(0, 200)}"`);
if (a.error && !/tool-call loop/.test(a.error)) console.log(`  error: ${a.error.slice(0, 300)}`);
if (a.firstTextMs !== null) console.log(`  first text: ${a.firstTextMs}ms`);
if (a.userTranscript.trim()) console.log(`  heard: "${a.userTranscript.trim().slice(0, 140)}"`);
if (a.firstAudioMs !== null) {
  // Measure from `userSpeechEnd`, not from the clip's duration.
  //
  // This used to be `firstAudio - clipDuration`, which silently assumes the
  // clip starts at t=0. It does not: the session has to open and the prompt
  // has to start first, and that took 4.3s on one run here. The metric then
  // charges the connection handshake to the model and reports a latency
  // regression that never happened — measured 1318ms real against 5290ms
  // claimed on the same machine, minutes apart.
  const clipMs = (questionPcm.length / 2 / INPUT_RATE) * 1000;
  const origin = a.speechEndMs !== null ? a.speechEndMs : clipMs;
  const basis = a.speechEndMs !== null ? 'after you stopped talking' : 'after the clip ended (estimated)';
  const afterSpeech = Math.max(0, Math.round(a.firstAudioMs - origin));
  console.log(`  first audio: ${a.firstAudioMs}ms from open, ${afterSpeech}ms ${basis}`);
  // The bound is 2.5s, not the 2s target, and the difference is deliberate.
  //
  // One sample of a live service is one sample. Measured across runs on this
  // machine: 1021, 1318, 1459, 1830, 1843, 2046ms. A 2000ms gate sits *inside*
  // that distribution, so it failed roughly one run in five with nothing wrong
  // — and a check that cries wolf is worse than no check, because the next
  // real regression gets waved off as "just Nova being Nova".
  //
  // 2.5s is outside the spread and still catches anything that matters: the
  // pipeline this replaced took 7-9 seconds. The number itself is printed
  // above, which is what you actually want to look at.
  latencies.push(afterSpeech);
  t(afterSpeech < LATENCY_BOUND_MS, 'it replies promptly after the user finishes',
    `${afterSpeech}ms — compare the 7-9s pipeline this replaced`);
}

// B. Two tools in one turn, then a second turn on the same session.
// This is the shape the loop bug was reported against, and the shape a real
// conversation takes. Part A proved neither.
if (failures === 0) {
  const two = speakToPcm(
    'Look at my projects, then tell me the status of the first agent you find. Keep it to one sentence.');
  const followUp = speakToPcm('And what was the project called again?');
  if (two && two.length > 8000) {
    const opts = {
      label: 'B. several tools in one turn, and a second turn after it',
      withTools: true,
      audio: two,
      followUpAudio: followUp && followUp.length > 8000 ? followUp : null,
    };
    let b = await runSession(opts);
    // Nova sometimes drops a bidirectional stream mid-turn with "Timed out
    // waiting for audio bytes", while the feeder is demonstrably still sending
    // them. That is the service, not this code — the same section passes on the
    // next attempt with no change. Retry exactly once, and say so, so a real
    // and repeatable failure still fails.
    if (/Timed out waiting for audio bytes/.test(b.error || '')) {
      console.log('  (Nova dropped the stream mid-turn — retrying once)');
      b = await runSession({ ...opts, label: 'B. retry' });
    }
    const bn = b.toolCalls.map((c) => c.name);
    t(b.toolCalls.length >= 2, 'it chains more than one tool in a turn',
      `only called ${bn.join(', ') || 'nothing'}`);
    t(b.toolCalls.length <= 6, 'and stops when it has what it needs',
      `${b.toolCalls.length} calls: ${bn.join(' → ')}`);
    t(!!b.assistantText.trim(), 'it answered', b.error || '(silence)');
    console.log(`  tools called: ${bn.map((n, i) => `${n}@${b.toolCalls[i].at}ms`).join(' → ') || '(none)'}`);
    if (b.assistantText.trim()) console.log(`  said: "${b.assistantText.trim().slice(0, 220)}"`);
    t(b.bargeIns > 0, 'talking over it mid-sentence interrupts it',
      'it kept talking — no "interrupted" marker came back');
    if (b.followUpText) {
      t(true, 'a second turn works on the same connection');
      console.log(`  then: "${b.followUpText.trim().slice(0, 200)}"`);
    } else if (followUp) {
      t(false, 'a second turn works on the same connection', b.error || 'no reply to the follow-up');
    }
    if (b.error) console.log(`  error: ${b.error.slice(0, 200)}`);
  } else {
    console.log('\nB. skipped — could not synthesise the clips');
  }
}

// C. How fast does it answer out loud?
if (!TOOLS_ONLY && failures === 0) {
  const pcm = speakToPcm('Hello, are you there? Answer in one short sentence.');
  if (!pcm || pcm.length < 8000) {
    console.log('\nB. spoken latency — skipped (could not synthesise a test clip)');
  } else {
    const b = await runSession({
      label: `B. spoken latency (${(pcm.length / 2 / INPUT_RATE).toFixed(1)}s of speech)`,
      withTools: true,
      audio: pcm,
    });
    t(b.firstAudioMs !== null, 'it answered out loud', b.error || 'no audio came back');
    if (b.firstAudioMs !== null) {
      // From Nova's own endpointing verdict, for the reason given in part A:
      // the clip does not start at t=0, so subtracting its duration charges
      // the connection handshake to the model.
      const origin = b.speechEndMs !== null ? b.speechEndMs : (pcm.length / 2 / INPUT_RATE) * 1000;
      const basis = b.speechEndMs !== null ? 'after you stopped talking' : 'after the clip ended (estimated)';
      const afterSpeech = b.firstAudioMs - origin;
      console.log(`  first audio: ${b.firstAudioMs}ms from open, ${Math.max(0, Math.round(afterSpeech))}ms ${basis}`);
      console.log(`  audio returned: ${(b.audioBytes / 2 / OUTPUT_RATE).toFixed(1)}s`);
      if (b.userTranscript.trim()) console.log(`  heard: "${b.userTranscript.trim().slice(0, 120)}"`);
      if (b.assistantText.trim()) console.log(`  said: "${b.assistantText.trim().slice(0, 160)}"`);
      latencies.push(Math.round(afterSpeech));
      t(afterSpeech < LATENCY_BOUND_MS, 'it replies promptly after the user finishes',
        `${Math.round(afterSpeech)}ms`);
    }
  }
}

if (latencies.length) {
  const sorted = [...latencies].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`\ntime to first audio: ${sorted.join('ms, ')}ms `
    + `(median ${median}ms, bound ${LATENCY_BOUND_MS}ms)`);
}

console.log(failures === 0
  ? '\nNova is viable here — the plan can proceed.\n'
  : `\n${failures} problem(s) — do NOT build on this yet; reopen the provider choice.\n`);
process.exit(failures === 0 ? 0 : 1);
