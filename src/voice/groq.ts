/**
 * Groq Whisper — speech-to-text.
 *
 * Groq serves Whisper on an OpenAI-compatible endpoint, so this is the same
 * multipart shape as openai.ts with a different base URL and key.
 *
 * It is the recommended engine for Conduit's voice input. The browser's own
 * recogniser is free but noticeably less accurate on names and technical
 * words, and it cannot run inside the Electron app at all — Chromium proxies
 * it to a Google service the desktop build has no keys for. Measured here at
 * roughly 0.5–1.0s for a five-second clip, against $0.04/hour for
 * whisper-large-v3-turbo.
 */

import { getApiKey } from './config.js';

/** Groq caps uploads at 25MB on the free tier; refuse early with a clear message. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

export async function transcribeGroq(
  audio: Buffer,
  mime: string,
  model: string,
  language?: string,
  /**
   * Vocabulary hint. Whisper decodes conditioned on this, so naming the wake
   * phrase and the live agent names makes it far likelier to return them
   * rather than a common word that sounds similar.
   */
  prompt?: string,
): Promise<string> {
  const apiKey = getApiKey('groq');
  if (!apiKey) throw new Error('Groq API key not set — add GROQ_API_KEY to .env or Voice Settings');
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new Error(`Audio is ${Math.round(audio.length / 1048576)}MB; Groq accepts up to 25MB`);
  }

  const ext = mime.split('/')[1]?.split(';')[0] || 'webm';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `audio.${ext}`);
  form.append('model', model || 'whisper-large-v3-turbo');
  // Whisper detects the language on its own, but naming it is faster and stops
  // a short English clip being read as another language.
  if (language) form.append('language', language.split('-')[0]);
  if (prompt) form.append('prompt', prompt.slice(0, 800));
  // Deterministic: a wake word should not decode differently run to run.
  form.append('temperature', '0');
  form.append('response_format', 'json');

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Groq STT ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { text?: string };
  // Whisper pads its output with a leading space.
  return (j.text || '').trim();
}
