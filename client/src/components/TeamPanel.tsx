/**
 * Team panel — what every agent on the project shares beyond its terminal:
 * project memory, skills, agent definitions from .bedrock/agents, and the
 * machine's plugins. Ideas from LocalHarness, available to every CLI.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import type { AgentTemplate, MemoryFact, PluginInfo, Skill } from '../api';

interface WsLike {
  subscribe: (fn: (msg: { type: string; [k: string]: unknown }) => void) => () => void;
}

interface Props {
  projectId: string;
  ws: WsLike;
}

const section: React.CSSProperties = { marginBottom: 24 };
const muted: React.CSSProperties = { opacity: 0.7, fontSize: 12 };
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' };

export default function TeamPanel({ projectId, ws }: Props) {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [problems, setProblems] = useState<Array<{ file: string; error: string }>>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginDir, setPluginDir] = useState('');
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [f, s, t, p] = await Promise.allSettled([
      api.listMemory(projectId), api.listSkills(projectId), api.listAgentTemplates(projectId), api.listPlugins(),
    ]);
    if (f.status === 'fulfilled') setFacts(f.value);
    if (s.status === 'fulfilled') setSkills(s.value);
    if (t.status === 'fulfilled') { setTemplates(t.value.templates); setProblems(t.value.problems); }
    if (p.status === 'fulfilled') { setPlugins(p.value.plugins); setPluginDir(p.value.dir); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => ws.subscribe((msg) => {
    if (msg.type === 'memory:updated' || msg.type === 'org:changed' || msg.type === 'plugins:changed') void load();
  }), [ws, load]);

  const remember = async () => {
    const text = draft.trim();
    if (!text) return;
    try { await api.addMemory(projectId, text); setDraft(''); await load(); }
    catch (err) { setNote((err as Error).message); }
  };

  const importAgents = async () => {
    try {
      const r = await api.importAgentTemplates(projectId);
      setNote(`Created ${r.created.length} agent${r.created.length === 1 ? '' : 's'}`
        + (r.skipped.length ? `; already present: ${r.skipped.join(', ')}` : '') + '.');
      await load();
    } catch (err) { setNote((err as Error).message); }
  };

  const togglePlugin = async (p: PluginInfo) => {
    try { await api.setPluginEnabled(p.name, !p.enabled); await load(); }
    catch (err) { setNote((err as Error).message); }
  };

  return (
    <div className="team-panel" style={{ padding: 16, overflow: 'auto', height: '100%' }}>
      {note && <div className="modal-note" style={{ marginBottom: 12 }}>{note}</div>}

      <div style={section}>
        <h3>Project memory</h3>
        <p style={muted}>Facts every agent on this project is told when it starts. The Keeper can add them too.</p>
        <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void remember(); }}
            placeholder="e.g. API errors use RFC 7807 problem details"
            style={{ flex: 1 }}
            aria-label="New fact"
          />
          <button className="primary" onClick={() => void remember()} disabled={!draft.trim()}>Remember</button>
        </div>
        {facts.length === 0 ? <p style={muted}>Nothing remembered yet.</p> : [...facts].reverse().map((f) => (
          <div key={f.id} style={row}>
            <span style={{ flex: 1 }}>{f.text}</span>
            <span style={muted}>{f.source}</span>
            <button onClick={() => void api.forgetMemory(projectId, f.id).then(load)} title="Forget this fact">Forget</button>
          </div>
        ))}
      </div>

      <div style={section}>
        <h3>Skills</h3>
        <p style={muted}>
          SKILL.md procedures from <code>.bedrock/skills</code>, <code>.agents/skills</code> and <code>~/.conduit/skills</code>.
          Each agent is told about them; a skill grants no tools.
        </p>
        {skills.length === 0 ? <p style={muted}>No skills found.</p> : skills.map((s) => (
          <div key={s.name} style={row}>
            <strong>{s.name}</strong>
            <span style={{ flex: 1 }}>{s.description}</span>
            <span style={muted}>{s.scope}</span>
          </div>
        ))}
      </div>

      <div style={section}>
        <h3>Agent definitions</h3>
        <p style={muted}>Agents declared in <code>.bedrock/agents/*.yaml</code> (name, cli, role, cwd, terminal).</p>
        {templates.length === 0 ? <p style={muted}>None in this project.</p> : templates.map((t) => (
          <div key={t.file} style={row}>
            <strong>{t.name}</strong>
            <span>{t.cli}</span>
            <span style={{ flex: 1, ...muted }}>{t.role || ''}</span>
            <span style={muted}>{t.exists ? 'exists' : 'new'}</span>
          </div>
        ))}
        {problems.map((p) => <div key={p.file} className="modal-error" style={{ marginTop: 4 }}>{p.file}: {p.error}</div>)}
        {templates.some((t) => !t.exists) && (
          <button className="primary" style={{ marginTop: 8 }} onClick={() => void importAgents()}>Import new agents</button>
        )}
      </div>

      <div style={section}>
        <h3>Plugins</h3>
        <p style={muted}>
          Machine-level only, from <code>{pluginDir || '~/.conduit/plugins'}</code>. A plugin is code that runs with your
          privileges; it can observe events but never answer a gate. Enable only what you trust.
        </p>
        {plugins.length === 0 ? <p style={muted}>No plugins installed.</p> : plugins.map((p) => (
          <div key={p.name} style={row}>
            <strong>{p.name}</strong>
            <span style={{ flex: 1, ...muted }}>{p.error ? `error: ${p.error}` : p.loaded ? 'loaded' : p.enabled ? 'enabled' : 'off'}</span>
            <button onClick={() => void togglePlugin(p)}>{p.enabled ? 'Disable' : 'Enable'}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
