/**
 * A live conversation with Amazon Nova 2 Sonic.
 *
 * One `NovaSession` owns one Bedrock bidirectional stream: audio goes in, audio
 * and events come out, and tool calls are dispatched in between. It knows
 * nothing about WebSockets or browsers — `src/server.ts` relays for it — and
 * nothing about Conduit's tools beyond the `runTool` callback it is handed.
 *
 * Everything below that looks arbitrary was measured with `npm run check:nova`,
 * and each one cost a failed run to find:
 *
 *   - **One audio content per session, and it stays open.** Turns are Nova's to
 *     detect from the stream, not ours to delimit. Closing the content between
 *     turns makes it stall on the second tool round with "Timed out waiting for
 *     audio bytes or interactive content"; opening a second one while the first
 *     is open returns "The system encountered an unexpected error".
 *   - **Tool results are JSON, labelled `text/plain`.** A bare string gives
 *     "Tool Response parsing error"; `application/json` gives "Tool result media
 *     type must be one of: [text/plain]". It wants JSON described as text.
 *   - **Match results to calls by arrival order.** Nova can emit two `toolUse`
 *     events before either `contentEnd`, so answering "the most recent call"
 *     leaves the first one hanging until the idle timeout.
 *   - **`{"interrupted": true}` on the assistant text channel is a barge-in
 *     signal, not speech.** Left in place it gets spoken aloud.
 *   - **Text input is for the system prompt only.** A TEXT/USER turn is not a
 *     turn trigger; Nova waits for audio regardless.
 *   - **The connection lasts 8 minutes** and dies after 55 seconds of silence
 *     on the wire, so something must always be streaming.
 */
import { randomUUID } from 'crypto';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';

/** Nova wants 16 kHz from us and sends 24 kHz back. Both mono PCM16. */
export const NOVA_INPUT_RATE = 16000;
export const NOVA_OUTPUT_RATE = 24000;

/** Bedrock closes the stream at 8 minutes; reconnect before it does. */
const CONNECTION_BUDGET_MS = 7 * 60 * 1000;
/** Nova drops the session after 55s with nothing on the wire. */
const KEEPALIVE_MS = 5000;

export const NOVA_MODEL_ID = process.env.NOVA_MODEL_ID || 'amazon.nova-2-sonic-v1:0';

export interface NovaTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  schema: Record<string, unknown>;
}

export type NovaEvent =
  | { kind: 'ready' }
  | { kind: 'audio'; pcm: Buffer }
  | { kind: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown> }
  | { kind: 'interrupted' }
  | { kind: 'speaking'; speaking: boolean }
  | { kind: 'error'; message: string; fatal: boolean }
  | { kind: 'closed' };

export interface NovaSessionOptions {
  systemPrompt: string;
  tools: NovaTool[];
  voiceId?: string;
  region?: string;
  /** Executes a tool and returns what to tell the model. */
  runTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  onEvent: (event: NovaEvent) => void;
}

interface QueuedCall { id: string; name: string; input: string }

/** An async iterable we can push into as we learn things. */
function pushableStream() {
  const queue: unknown[] = [];
  let waiting: ((r: IteratorResult<unknown>) => void) | null = null;
  let closed = false;
  const encoder = new TextEncoder();

  return {
    push(event: unknown) {
      if (closed) return;
      const value = { chunk: { bytes: encoder.encode(JSON.stringify(event)) } };
      if (waiting) { const w = waiting; waiting = null; w({ value, done: false }); }
      else queue.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { waiting = resolve; });
        },
      };
    },
  };
}

export class NovaSession {
  private client: BedrockRuntimeClient | null = null;
  private stream: ReturnType<typeof pushableStream> | null = null;
  private promptName = '';
  private audioContentName = '';
  private role = '';
  /** Tool calls Nova has made that we have not answered yet, oldest first. */
  private readonly unanswered: QueuedCall[] = [];
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private renew: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  private assistantSpeaking = false;
  private stopped = false;
  /** Transcript kept so a reconnect can carry the conversation across. */
  private readonly history: Array<{ role: 'user' | 'assistant'; text: string }> = [];

  constructor(private readonly opts: NovaSessionOptions) {}

  async start(): Promise<void> {
    if (this.stopped) return;
    this.client = new BedrockRuntimeClient({
      region: this.opts.region || process.env.AWS_REGION || 'us-east-1',
      requestHandler: new NodeHttp2Handler({
        requestTimeout: 600_000,
        sessionTimeout: 600_000,
        disableConcurrentStreams: false,
        maxConcurrentStreams: 20,
      }),
    });

    this.promptName = randomUUID();
    this.audioContentName = randomUUID();
    this.unanswered.length = 0;
    const stream = pushableStream();
    this.stream = stream;

    stream.push({ event: { sessionStart: {
      inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 },
      // HIGH is what makes it cut in like a person rather than waiting
      // politely for a long pause.
      turnDetectionConfiguration: { endpointingSensitivity: 'HIGH' },
    } } });

    stream.push({ event: { promptStart: {
      promptName: this.promptName,
      textOutputConfiguration: { mediaType: 'text/plain' },
      audioOutputConfiguration: {
        mediaType: 'audio/lpcm', sampleRateHertz: NOVA_OUTPUT_RATE, sampleSizeBits: 16,
        channelCount: 1, voiceId: this.opts.voiceId || 'matthew',
        encoding: 'base64', audioType: 'SPEECH',
      },
      toolConfiguration: {
        tools: this.opts.tools.map((tool) => ({
          toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: { json: JSON.stringify(tool.schema) },
          },
        })),
      },
    } } });

    this.sendText('SYSTEM', this.buildSystemPrompt());

    // The microphone. Opened once, never closed until the session ends.
    stream.push({ event: { contentStart: {
      promptName: this.promptName, contentName: this.audioContentName,
      type: 'AUDIO', interactive: true, role: 'USER',
      audioInputConfiguration: {
        mediaType: 'audio/lpcm', sampleRateHertz: NOVA_INPUT_RATE, sampleSizeBits: 16,
        channelCount: 1, audioType: 'SPEECH', encoding: 'base64',
      },
    } } });

    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: NOVA_MODEL_ID,
      body: stream as unknown as AsyncIterable<{ chunk: { bytes: Uint8Array } }>,
    });

    let response;
    try {
      response = await this.client.send(command);
    } catch (err) {
      this.opts.onEvent({ kind: 'error', message: describe(err), fatal: true });
      return;
    }

    this.lastSentAt = Date.now();
    // Nothing on the wire for 55 seconds ends the session. The browser
    // suppresses silence to keep the bill down, so we top it up ourselves.
    this.keepalive = setInterval(() => {
      if (Date.now() - this.lastSentAt > KEEPALIVE_MS) this.sendAudio(Buffer.alloc(1024));
    }, KEEPALIVE_MS);
    // Reconnect before Bedrock hangs up at 8 minutes, so the conversation
    // survives rather than dying mid-sentence.
    this.renew = setTimeout(() => { void this.reconnect(); }, CONNECTION_BUDGET_MS);

    this.opts.onEvent({ kind: 'ready' });
    void this.readLoop(response.body as AsyncIterable<Record<string, any>>);
  }

  /** Raw PCM16 @16 kHz mono, straight from the browser. */
  sendAudio(pcm: Buffer): void {
    if (!this.stream || this.stopped) return;
    this.lastSentAt = Date.now();
    this.stream.push({ event: { audioInput: {
      promptName: this.promptName,
      contentName: this.audioContentName,
      content: pcm.toString('base64'),
    } } });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    try {
      this.stream?.push({ event: { contentEnd: {
        promptName: this.promptName, contentName: this.audioContentName,
      } } });
      this.stream?.push({ event: { promptEnd: { promptName: this.promptName } } });
      this.stream?.push({ event: { sessionEnd: {} } });
      this.stream?.close();
    } catch { /* already gone */ }
    try { this.client?.destroy(); } catch { /* ignore */ }
    this.opts.onEvent({ kind: 'closed' });
  }

  private clearTimers(): void {
    if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
    if (this.renew) { clearTimeout(this.renew); this.renew = null; }
  }

  /**
   * Bedrock caps a connection at 8 minutes. Nova has no resumption token, so
   * the conversation is carried across by replaying the transcript into the
   * new session's system prompt — the user should not notice.
   */
  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    this.clearTimers();
    try {
      this.stream?.push({ event: { promptEnd: { promptName: this.promptName } } });
      this.stream?.push({ event: { sessionEnd: {} } });
      this.stream?.close();
    } catch { /* ignore */ }
    try { this.client?.destroy(); } catch { /* ignore */ }
    this.stream = null;
    await this.start();
  }

  private buildSystemPrompt(): string {
    if (!this.history.length) return this.opts.systemPrompt;
    const recap = this.history.slice(-12)
      .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`)
      .join('\n');
    return `${this.opts.systemPrompt}\n\nThe conversation so far:\n${recap}`;
  }

  private sendText(role: 'SYSTEM' | 'USER', content: string): void {
    if (!this.stream) return;
    const contentName = randomUUID();
    this.stream.push({ event: { contentStart: {
      promptName: this.promptName, contentName, type: 'TEXT', interactive: true,
      role, textInputConfiguration: { mediaType: 'text/plain' },
    } } });
    this.stream.push({ event: { textInput: { promptName: this.promptName, contentName, content } } });
    this.stream.push({ event: { contentEnd: { promptName: this.promptName, contentName } } });
  }

  private async readLoop(body: AsyncIterable<Record<string, any>>): Promise<void> {
    try {
      for await (const chunk of body) {
        if (this.stopped) break;

        const fault = chunk.validationException || chunk.modelStreamErrorException
          || chunk.internalServerException || chunk.throttlingException;
        if (fault) {
          this.opts.onEvent({ kind: 'error', message: String(fault.message || fault), fatal: false });
          continue;
        }
        if (!chunk.chunk?.bytes) continue;

        let json: any;
        try { json = JSON.parse(new TextDecoder().decode(chunk.chunk.bytes)); } catch { continue; }
        const ev = json?.event;
        if (!ev) continue;

        if (ev.contentStart) {
          this.role = ev.contentStart.role || this.role;
          if (this.role === 'ASSISTANT' && ev.contentStart.type === 'AUDIO') this.setSpeaking(true);
        }

        if (ev.textOutput) {
          const text = String(ev.textOutput.content || '');
          // A control signal, not something anyone said. Speaking it aloud is
          // exactly what happens if this check is missing.
          if (/"interrupted"\s*:\s*true/.test(text)) {
            this.setSpeaking(false);
            this.opts.onEvent({ kind: 'interrupted' });
            continue;
          }
          if (this.role === 'ASSISTANT' || this.role === 'USER') {
            const role = this.role === 'ASSISTANT' ? 'assistant' : 'user';
            this.history.push({ role, text });
            if (this.history.length > 40) this.history.splice(0, this.history.length - 40);
            this.opts.onEvent({ kind: 'transcript', role, text });
          }
        }

        if (ev.audioOutput) {
          this.opts.onEvent({
            kind: 'audio',
            pcm: Buffer.from(String(ev.audioOutput.content || ''), 'base64'),
          });
        }

        if (ev.toolUse) {
          const call: QueuedCall = {
            id: String(ev.toolUse.toolUseId || ''),
            name: String(ev.toolUse.toolName || ''),
            input: String(ev.toolUse.content ?? ev.toolUse.input ?? ''),
          };
          this.unanswered.push(call);
        }

        if (ev.contentEnd) {
          if (ev.contentEnd.type === 'TOOL') {
            // Oldest first — see the note at the top of the file.
            const call = this.unanswered.shift();
            if (call) void this.answerTool(call);
          } else if (this.role === 'ASSISTANT') {
            this.setSpeaking(false);
          }
        }
      }
    } catch (err) {
      if (!this.stopped) {
        this.opts.onEvent({ kind: 'error', message: describe(err), fatal: false });
      }
    }
    // The stream ended on its own — renew rather than going quiet, unless we
    // were the ones who stopped it.
    if (!this.stopped) void this.reconnect();
  }

  private setSpeaking(speaking: boolean): void {
    if (this.assistantSpeaking === speaking) return;
    this.assistantSpeaking = speaking;
    this.opts.onEvent({ kind: 'speaking', speaking });
  }

  private async answerTool(call: QueuedCall): Promise<void> {
    let input: Record<string, unknown> = {};
    try {
      input = typeof call.input === 'string' && call.input
        ? JSON.parse(call.input)
        : (call.input as unknown as Record<string, unknown>) || {};
    } catch { /* the model sent something unparseable; the tool sees {} */ }

    this.opts.onEvent({ kind: 'tool', name: call.name, input });

    let output: string;
    try {
      output = await this.opts.runTool(call.name, input);
    } catch (err) {
      output = `That failed: ${describe(err)}`;
    }

    if (!this.stream || this.stopped) return;
    const contentName = randomUUID();
    this.stream.push({ event: { contentStart: {
      promptName: this.promptName, contentName, interactive: false, type: 'TOOL',
      role: 'TOOL',
      toolResultInputConfiguration: {
        toolUseId: call.id, type: 'TEXT',
        // JSON content, described as text. Both halves are required.
        textInputConfiguration: { mediaType: 'text/plain' },
      },
    } } });
    this.stream.push({ event: { toolResult: {
      promptName: this.promptName, contentName,
      content: JSON.stringify({ result: output }),
    } } });
    this.stream.push({ event: { contentEnd: { promptName: this.promptName, contentName } } });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
