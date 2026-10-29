import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRouter, createDownloadRouter } from './routes.js';
import * as activity from './activity.js';
import * as usage from './usage.js';
import { DaemonClient } from './daemon/client.js';
import type { WSServerMessage } from './types.js';
import { runSmokeTest } from './strands/agent.js';
import { BEDROCK_MODEL_ID, AWS_REGION, supervisorDisabled, supervisorProvider } from './strands/config.js';
import { hasAnthropicCredential, currentModel as anthropicModel } from './strands/anthropic.js';
import { PROVIDERS } from './voice/providers.js';
import { loadConfig as loadVoiceConfig, saveConfig as saveVoiceConfig, hasKey, saveApiKeys } from './voice/config.js';
import { transcribeOpenAI, ttsOpenAI } from './voice/openai.js';
import { transcribeGemini, ttsGemini } from './voice/gemini.js';
import { transcribeGroq } from './voice/groq.js';
import { authMiddleware, isAuthEnabled } from './auth.js';
import { loadGateSettings, saveGateSettings } from './gate-policy.js';
import { loadedEnvFiles, userEnvPath } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Determine HTTP error status from transcription error message.
 */
export function sttErrorStatus(message: string): number {
  const upstream = Number(/\b(?:STT|TTS)\s+(\d{3})\b/.exec(message)?.[1] || 0);
  if (upstream === 400 || upstream === 415 || upstream === 422) return 400;
  if (upstream === 429) return 429;
  if (upstream) return 502; // auth, quota, provider outage
  if (/API key not set/i.test(message)) return 503;
  if (/accepts up to \d+MB/i.test(message)) return 413;
  return 500;
}

/**
 * Create and configure Express application with all REST API routes and static asset serving.
 * Decouples HTTP route registration from server bootstrap and WebSocket lifecycle.
 */
export function createServerApp(
  daemon: DaemonClient,
  broadcast: (msg: WSServerMessage) => void,
): express.Application {
  const app = express();
  app.disable('x-powered-by');
  app.use(authMiddleware);
  app.use(express.json({ limit: '5mb' }));

  // Main CRUD & Domain Router
  app.use('/downloads', createDownloadRouter());
  app.use('/api', createRouter(daemon, broadcast));

  // Activity feed REST endpoint
  app.get('/api/activity', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.json(activity.getEvents(projectId));
  });

  // Usage endpoint
  app.get('/api/usage', async (_req, res) => {
    const data = await usage.getUsage();
    res.json(data);
  });

  // Daemon health endpoint
  app.get('/api/daemon/status', (_req, res) => {
    res.json({ connected: daemon.isConnected() });
  });

  // Server info — the UI shows this in the footer
  app.get('/api/health', async (_req, res) => {
    let health: unknown = null;
    try {
      health = await Promise.race([
        daemon.request('supervisor:health', {}),
        new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);
    } catch {
      /* daemon down */
    }

    res.json({
      ok: true,
      daemon: daemon.isConnected(),
      auth: isAuthEnabled(),
      supervisor: supervisorDisabled() ? 'off' : 'on',
      supervisorHealth: health,
      supervisorProvider: supervisorProvider(),
      anthropicCredential: hasAnthropicCredential(),
      anthropicModel: anthropicModel(),
      bedrockModel: BEDROCK_MODEL_ID,
      region: AWS_REGION,
      envFiles: loadedEnvFiles(),
      userEnvPath: userEnvPath(),
    });
  });

  // Strands Agents SDK Smoke Test
  app.post('/api/strands/ping', async (req, res) => {
    try {
      const msg =
        typeof req.body?.message === 'string' && req.body.message.trim()
          ? req.body.message.trim().slice(0, 2000)
          : 'Say hello and confirm you can hear me.';
      const reply = await runSmokeTest(msg);
      res.json({ reply, model: BEDROCK_MODEL_ID, region: AWS_REGION });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        model: BEDROCK_MODEL_ID,
        region: AWS_REGION,
      });
    }
  });

  // ─── Voice (STT / TTS) ─────────────────────────────────────────────────

  app.get('/api/gate-settings', (_req, res) => {
    res.json(loadGateSettings());
  });

  app.put('/api/gate-settings', (req, res) => {
    const value = req.body?.autoApproveRoutine;
    if (typeof value !== 'boolean') {
      res.status(400).json({ error: 'autoApproveRoutine must be a boolean' });
      return;
    }
    const saved = saveGateSettings({ autoApproveRoutine: value });
    daemon.command({ op: 'gates:reload' });
    res.json(saved);
  });

  app.get('/api/voice/config', (_req, res) => {
    res.json({
      config: loadVoiceConfig(),
      providers: PROVIDERS,
      keys: { openai: hasKey('openai'), gemini: hasKey('gemini'), groq: hasKey('groq') },
    });
  });

  app.put('/api/voice/config', (req, res) => {
    try {
      const body = (req.body || {}) as {
        engine?: unknown;
        stt?: unknown;
        tts?: unknown;
        live?: unknown;
        apiKeys?: { openai?: string; gemini?: string; groq?: string };
      };
      if (body.engine || body.stt || body.tts || body.live) {
        const cur = loadVoiceConfig();
        const engine =
          body.engine === 'live' || body.engine === 'pipeline' ? body.engine : cur.engine;
        saveVoiceConfig({
          engine,
          stt: { ...cur.stt, ...((body.stt as Partial<typeof cur.stt>) || {}) },
          tts: { ...cur.tts, ...((body.tts as Partial<typeof cur.tts>) || {}) },
          live: { ...cur.live, ...((body.live as Partial<typeof cur.live>) || {}) },
        });
      }
      if (body.apiKeys && typeof body.apiKeys === 'object') {
        saveApiKeys(body.apiKeys);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Raw audio bytes in, JSON {text} out
  app.post(
    '/api/voice/transcribe',
    express.raw({ type: 'audio/*', limit: '25mb' }),
    async (req, res) => {
      try {
        const cfg = loadVoiceConfig();
        const mime = String(req.headers['content-type'] || 'audio/webm');
        const audio = req.body as Buffer;
        if (!audio || audio.length === 0) {
          res.status(400).json({ error: 'no audio body' });
          return;
        }
        if (cfg.stt.saveRecordings) {
          try {
            const dir = path.join(os.homedir(), '.conduit', 'voice-debug');
            fs.mkdirSync(dir, { recursive: true });
            const ext = mime.split('/')[1]?.split(';')[0] || 'webm';
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const ts = path.join(dir, `recording-${stamp}.${ext}`);
            const latest = path.join(dir, `latest.${ext}`);
            fs.writeFileSync(ts, audio);
            fs.writeFileSync(latest, audio);
          } catch (err) {
            console.warn('[voice/debug] save failed:', err);
          }
        }
        const language =
          (typeof req.query.language === 'string' && req.query.language) ||
          cfg.stt.language ||
          undefined;
        const vocab =
          typeof req.query.vocab === 'string' ? req.query.vocab.slice(0, 800) : undefined;
        let text = '';
        if (cfg.stt.provider === 'groq') {
          text = await transcribeGroq(audio, mime, cfg.stt.model, language, vocab);
        } else if (cfg.stt.provider === 'openai') {
          text = await transcribeOpenAI(audio, mime, cfg.stt.model, language);
        } else if (cfg.stt.provider === 'gemini') {
          text = await transcribeGemini(audio, mime, cfg.stt.model, language);
        } else {
          res.status(400).json({
            error:
              'STT provider is "browser" — transcription happens in the browser, not here',
          });
          return;
        }
        res.json({ text });
      } catch (err) {
        console.warn('[voice/transcribe]', err);
        const message = err instanceof Error ? err.message : String(err);
        res.status(sttErrorStatus(message)).json({ error: message });
      }
    },
  );

  // Text in, audio bytes out
  app.post('/api/voice/tts', async (req, res) => {
    try {
      const cfg = loadVoiceConfig();
      const text = String(req.body?.text || '').slice(0, 2000);
      if (!text) {
        res.status(400).json({ error: 'no text' });
        return;
      }
      const provider =
        req.body?.provider === 'openai' || req.body?.provider === 'gemini'
          ? req.body.provider
          : cfg.tts.provider;
      const model =
        typeof req.body?.model === 'string' && req.body.model ? req.body.model : cfg.tts.model;
      const voice =
        typeof req.body?.voice === 'string' && req.body.voice ? req.body.voice : cfg.tts.voice;
      const speed = typeof req.body?.speed === 'number' ? req.body.speed : cfg.tts.speed;
      let out: { audio: Buffer; mime: string };
      if (provider === 'openai') {
        out = await ttsOpenAI(text, model, voice, speed);
      } else if (provider === 'gemini') {
        out = await ttsGemini(text, model, voice);
      } else {
        res.status(400).json({
          error: `TTS provider is "${provider}" — synthesis happens in the browser, not here`,
        });
        return;
      }
      res.setHeader('Content-Type', out.mime);
      res.setHeader('Cache-Control', 'no-store');
      res.send(out.audio);
    } catch (err) {
      console.warn('[voice/tts]', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Codex model list
  app.get('/api/codex/models', async (_req, res) => {
    try {
      res.json(await daemon.request('codex:models'));
    } catch {
      res.json({ models: [] });
    }
  });

  // Orchestrator brain state
  app.get('/api/brain', async (_req, res) => {
    try {
      const state = await daemon.request('brain:state');
      res.json(state);
    } catch {
      res.status(503).json({
        messages: [],
        status: 'idle',
        engine: 'codex',
        currentId: '',
        conversations: [],
        error: 'daemon unavailable',
      });
    }
  });

  // Unknown API routes return JSON 404
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Serve static frontend in production
  const clientDist = [
    path.join(__dirname, 'client'),
    path.join(__dirname, '..', 'client'),
    path.join(process.cwd(), 'dist', 'client'),
  ].find((p) => fs.existsSync(p));

  if (clientDist) {
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    app.get('*', (_req, res) => {
      res.status(503).type('text/plain').send(
        'Bedrock UI is not built yet. Run `npm run build` (or use `npm run dev` and open http://localhost:5173).',
      );
    });
  }

  // Error handler middleware
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = (err as { status?: number })?.status || 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) console.error('[server] route error:', err);
      if (res.headersSent) return;
      res.status(status).json({ error: message });
    },
  );

  return app;
}
