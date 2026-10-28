/**
 * Voice provider catalog — the lists shown in the settings page. The frontend
 * uses these for the provider/model/voice dropdowns and the server uses them
 * as the source of truth for what `config.provider/model/voice` may hold.
 *
 * "browser" means "do it in the browser" — Web Speech API (current behaviour);
 * the server doesn't handle these and the routes return an error if asked to.
 */

export interface ModelOption { id: string; label: string }
export interface VoiceOption { id: string; label: string }
export interface ProviderSpec {
  id: 'browser' | 'openai' | 'gemini' | 'groq';
  label: string;
  /** env var name — UI shows whether it's set. */
  needsKey?: 'OPENAI_API_KEY' | 'GEMINI_API_KEY' | 'GROQ_API_KEY';
  sttModels?: ModelOption[];
  ttsModels?: ModelOption[];
  voices?: VoiceOption[];
}

export const PROVIDERS: ProviderSpec[] = [
  { id: 'browser', label: 'Browser (free, current default)' },

  {
    // Recommended for speech-to-text: markedly more accurate than the browser
    // engine on names and technical words, sub-second in practice, and the
    // only cheap option that also works inside the desktop app — where the
    // browser recogniser cannot run at all.
    id: 'groq',
    label: 'Groq Whisper (fast, accurate, ~$0.04/hr)',
    needsKey: 'GROQ_API_KEY',
    sttModels: [
      { id: 'whisper-large-v3-turbo', label: 'whisper-large-v3-turbo (fastest, $0.04/hr)' },
      { id: 'whisper-large-v3', label: 'whisper-large-v3 (most accurate, $0.111/hr)' },
    ],
  },

  {
    id: 'openai',
    label: 'OpenAI',
    needsKey: 'OPENAI_API_KEY',
    sttModels: [
      { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe (best, $0.006/min)' },
      { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe (cheaper, $0.003/min)' },
      { id: 'whisper-1', label: 'whisper-1 (legacy)' },
    ],
    ttsModels: [
      { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts (steerable, 2025-03)' },
      { id: 'tts-1', label: 'tts-1' },
      { id: 'tts-1-hd', label: 'tts-1-hd' },
    ],
    voices: [
      { id: 'alloy', label: 'Alloy' },
      { id: 'ash', label: 'Ash' },
      { id: 'ballad', label: 'Ballad' },
      { id: 'coral', label: 'Coral' },
      { id: 'echo', label: 'Echo' },
      { id: 'fable', label: 'Fable' },
      { id: 'nova', label: 'Nova' },
      { id: 'onyx', label: 'Onyx' },
      { id: 'sage', label: 'Sage' },
      { id: 'shimmer', label: 'Shimmer' },
      { id: 'verse', label: 'Verse' },
    ],
  },

  {
    id: 'gemini',
    label: 'Google Gemini',
    needsKey: 'GEMINI_API_KEY',
    sttModels: [
      { id: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview (latest)' },
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
      { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
      { id: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite (cheap)' },
    ],
    ttsModels: [
      { id: 'gemini-3.1-flash-tts-preview', label: 'gemini-3.1-flash-tts-preview (latest, expressive)' },
      { id: 'gemini-2.5-flash-preview-tts', label: 'gemini-2.5-flash-preview-tts (default)' },
      { id: 'gemini-2.5-pro-preview-tts', label: 'gemini-2.5-pro-preview-tts' },
    ],
    voices: [
      { id: 'Kore', label: 'Kore (firm)' },
      { id: 'Puck', label: 'Puck (upbeat)' },
      { id: 'Charon', label: 'Charon (informative)' },
      { id: 'Leda', label: 'Leda (youthful)' },
      { id: 'Zephyr', label: 'Zephyr (bright)' },
      { id: 'Fenrir', label: 'Fenrir (excitable)' },
      { id: 'Aoede', label: 'Aoede (breezy)' },
      { id: 'Orus', label: 'Orus (firm)' },
      { id: 'Algieba', label: 'Algieba (smooth)' },
      { id: 'Callirrhoe', label: 'Callirrhoe (easy-going)' },
    ],
  },
];
