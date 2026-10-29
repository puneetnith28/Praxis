/**
 * JarvisHud — a floating, non-modal voice cockpit for The Keeper.
 *
 * An always-present orb (bottom-right) that pulses with the Keeper's state —
 * breathing when idle, radiating rings while listening, spinning while it
 * works. Click it for a floating HUD: talk or type to the Keeper and glance
 * at which agents need you, without opening the full Command drawer and
 * without a scrim — everything underneath stays fully interactive.
 */

import { useState, useEffect, useRef } from 'react';
import Ic from './Icons';
import { useSpeechInput } from '../hooks/useSpeechInput';
import type { AgentNotif } from './NotificationCenter';
import { renderMarkdown } from '../utils/md';
import { stopSpeaking, type TtsCfg } from '../utils/speech';

// The TTS queue used to live here, but App unmounts this component whenever
// the Command panel opens — which killed speech mid-sentence. It now lives in
// utils/speech.ts so the voice session and announcer can speak too.
export { stopSpeaking } from '../utils/speech';
export type { TtsCfg } from '../utils/speech';

interface Props {
  send: (msg: object) => void;
  /** Brain state, fed from App (whose ws.onmessage is the reliable sink). */
  working: boolean;
  lastReply: { text: string; ts: number } | null;
  onClearReply: () => void;
  sttCfg: { provider: 'browser' | 'openai' | 'gemini' | 'groq'; language: string };
  /** Spoken output on/off. Owned by App — this component only toggles it. */
  voiceOut: boolean;
  onToggleVoiceOut: () => void;
  /** True when the App-level header voice (⌘; hotkey / header mic button)
   *  is recording — lets the orb pulse "listening" so the user sees the
   *  hotkey took effect even when their eyes are on the HUD, not the header. */
  headerListening: boolean;
  wake: {
    enabled: boolean; supported: boolean; armed: boolean; phrase: string;
    onToggle: () => void; onPhraseChange: (v: string) => void;
  };
  /**
   * The live Nova session, when that engine is on. The orb is the only place
   * the user can see whether it is actually listening — without it, "is this
   * thing on?" has no answer, which was the complaint about the old wake word.
   */
  live?: {
    status: 'off' | 'connecting' | 'live' | 'error';
    speaking: boolean;
    hearing: boolean;
    error: string | null;
  };
  awaiting: AgentNotif[];
  running: number;
  idle: number;
  onSelectAgent: (projectId: string, agentId: string) => void;
  onOpenFull: () => void;
}

export default function JarvisHud({
  send, working, lastReply, onClearReply, sttCfg, voiceOut, onToggleVoiceOut, headerListening, wake, live, awaiting, running, idle, onSelectAgent, onOpenFull,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState('');
  const reply = (lastReply?.text || '').trim();

  const submit = (textArg?: string) => {
    const t = (textArg ?? input).trim();
    if (!t) return;
    send({ type: 'brain:send', message: t });
    setInput('');
  };

  // Voice input — fill the box, and on a final result send automatically.
  // The provider/language come from the user's settings (Browser / OpenAI / Gemini).
  const speech = useSpeechInput(
    (t, final) => { setInput(t); if (final && t.trim()) submit(t); },
    { provider: sttCfg.provider, language: sttCfg.language },
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [expanded]);

  // A live session speaks for itself: it is hearing you, talking, or waiting.
  const state = live && live.status !== 'off'
    ? (live.speaking ? 'thinking' : live.hearing ? 'listening' : 'idle')
    : working ? 'thinking'
      : (speech.listening || wake.armed || headerListening) ? 'listening'
      : 'idle';

  return (
    <div className="jv">
      {expanded && (
        <div className="jv-panel">
          <div className="jv-panel-h">
            <div className={'jv-mini-orb ' + state}><Ic.logo size={12} /></div>
            <span className="jv-panel-t">The Keeper</span>
            <button
              className={'jv-x' + (voiceOut ? ' on' : '')}
              onClick={onToggleVoiceOut}
              title={voiceOut ? 'Voice replies: on' : 'Voice replies: off'}
            >
              <Ic.volume size={13} />
            </button>
            {wake.supported && (
              <button
                className={'jv-x' + (wake.enabled ? ' on' : '')}
                onClick={wake.onToggle}
                title={wake.enabled ? `Wake word on — say “${wake.phrase}”` : 'Wake word off'}
              >
                <Ic.mic size={13} />
              </button>
            )}
            <button className="jv-x" onClick={onOpenFull} title="Open full conversation">
              <Ic.message size={12} />
            </button>
            <button className="jv-x" onClick={() => setExpanded(false)} title="Collapse">
              <Ic.x size={12} />
            </button>
          </div>

          {wake.enabled && (
            <div className="jv-wake-cfg">
              <Ic.mic size={11} />
              <span className="jv-wake-lbl">Wake word</span>
              <input
                className="jv-wake-input"
                value={wake.phrase}
                onChange={(e) => wake.onPhraseChange(e.target.value)}
                placeholder="e.g. jarvis, travis"
                spellCheck={false}
                aria-label="Wake word"
                // Near-misses already match, but a recogniser that consistently
                // hears something else (Jarvis → Travis) needs that spelling
                // listed. Comma separated; any of them wakes it.
                title={'Say any of these to wake Bedrock. Separate spellings with commas — '
                  + 'add whatever your microphone actually hears.'}
              />
            </div>
          )}

          <div className="jv-status">
            <span className="jv-stat"><i className="sdot running" />{running} running</span>
            <span className="jv-stat"><i className="sdot awaiting_input" />{awaiting.length} awaiting</span>
            <span className="jv-stat"><i className="sdot idle" />{idle} idle</span>
          </div>

          {awaiting.length > 0 && (
            <div className="jv-await">
              {awaiting.slice(0, 6).map((n) => (
                <button
                  key={n.agentId}
                  className="jv-await-row"
                  onClick={() => onSelectAgent(n.projectId, n.agentId)}
                >
                  <span className="sdot awaiting_input" />
                  <span className="jv-await-t">{n.agentName}</span>
                  <span className="jv-await-s">{n.projectName}</span>
                </button>
              ))}
            </div>
          )}

          {(working || reply) && (
            <div className="jv-reply">
              {working ? (
                <span className="jv-reply-w">
                  <span className="cmd-dot" /><span className="cmd-dot" /><span className="cmd-dot" />
                  The Keeper is working…
                  <button
                    className="jv-stop"
                    onClick={() => { stopSpeaking(); send({ type: 'brain:abort' }); }}
                    title="Stop"
                  >
                    <Ic.stop size={11} /> Stop
                  </button>
                </span>
              ) : (
                <>
                  <button
                    className="jv-reply-x"
                    onClick={() => { stopSpeaking(); onClearReply(); }}
                    title="Clear reply"
                  >
                    <Ic.x size={10} />
                  </button>
                  <div
                    className="jv-reply-t cmd-md"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(reply) }}
                  />
                </>
              )}
            </div>
          )}

          <div className="jv-compose">
            {speech.supported && (
              <button
                className={'jv-mic' + (speech.listening ? ' on' : '')}
                onClick={speech.toggle}
                title={speech.error || (speech.listening ? 'Stop listening' : 'Voice')}
              >
                <Ic.mic size={14} />
              </button>
            )}
            <input
              ref={inputRef}
              className="jv-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
              placeholder="Speak or type to The Keeper…"
            />
            <button className="jv-send" onClick={() => submit()} disabled={!input.trim()} title="Send">
              <Ic.send size={13} />
            </button>
          </div>
        </div>
      )}

      <button
        className={'jv-orb ' + state}
        onClick={() => setExpanded((e) => !e)}
        title="The Keeper"
      >
        <span className="jv-ring" />
        <span className="jv-ring jv-ring2" />
        <span className="jv-core"><Ic.logo size={21} /></span>
        {awaiting.length > 0 && <span className="jv-orb-badge">{awaiting.length}</span>}
      </button>
    </div>
  );
}
