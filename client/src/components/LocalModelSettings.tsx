/**
 * Settings card: the local model server (used by LocalHarness agents, the
 * Supervisor's `local` provider and the Keeper's LocalHarness engine) and
 * which provider the Supervisor uses. Saves on its own button, to
 * ~/.conduit/settings.json; an environment variable still wins, and the card
 * says when one does.
 */
import { useCallback, useEffect, useState } from 'react';
import Ic from './Icons';

interface SettingsResponse {
  saved: { baseUrl: string; model: string; supervisorProvider: string; hasApiKey: boolean };
  sources: Record<'baseUrl' | 'model' | 'apiKey' | 'supervisorProvider', 'env' | 'settings' | 'default'>;
  effective: { baseUrl: string; model: string; configured: boolean; supervisorProvider: string };
}

interface ModelsResponse { ok: boolean; models?: string[]; error?: string }

export default function LocalModelSettings() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState('auto');
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d: SettingsResponse = await fetch('/api/local-llm/settings').then((r) => r.json());
      setData(d);
      setBaseUrl(d.saved.baseUrl);
      setModel(d.saved.model);
      setProvider(d.saved.supervisorProvider || 'auto');
      setModels(await fetch('/api/local-llm/models').then((r) => r.json()));
    } catch { setStatus('Could not reach the server.'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setStatus(null);
    const body: Record<string, string> = { baseUrl, model, supervisorProvider: provider };
    if (apiKey) body.apiKey = apiKey;
    const r = await fetch('/api/local-llm/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setStatus(r.ok ? 'Saved.' : (j.error || `HTTP ${r.status}`));
    setApiKey('');
    if (r.ok) await load();
  };

  const envNote = (k: keyof SettingsResponse['sources']) =>
    data?.sources[k] === 'env' ? <span className="settings-card-desc"> (set by the environment — that wins)</span> : null;

  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-icon"><Ic.hash size={15} /></div>
        <div className="settings-card-title-wrap">
          <h4 className="settings-card-title">Local model</h4>
          <span className="settings-card-desc">LocalHarness agents, and the Supervisor or Keeper without a cloud provider</span>
        </div>
      </div>
      <div className="settings-card-body">
        <div className="settings-field">
          <label className="settings-field-label">Server URL{envNote('baseUrl')}</label>
          <div className="settings-field-ctrl">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={data?.effective.baseUrl || 'http://127.0.0.1:11434/v1'} aria-label="Local model server URL" />
          </div>
        </div>
        <div className="settings-field">
          <label className="settings-field-label">Model{envNote('model')}</label>
          <div className="settings-field-ctrl">
            {models?.ok && models.models && models.models.length > 0 ? (
              <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Local model">
                <option value="">First the server lists</option>
                {models.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. qwen3:8b" aria-label="Local model" />
            )}
          </div>
        </div>
        {models && !models.ok && <p className="settings-card-desc" style={{ margin: '4px 0' }}>{models.error}</p>}
        <div className="settings-field">
          <label className="settings-field-label">API key{envNote('apiKey')}</label>
          <div className="settings-field-ctrl">
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={data?.saved.hasApiKey ? 'saved — type to replace' : 'none (most local servers)'} aria-label="Local model API key" />
          </div>
        </div>
        <div className="settings-field">
          <label className="settings-field-label">Supervisor provider{envNote('supervisorProvider')}</label>
          <div className="settings-field-ctrl">
            <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Supervisor provider">
              <option value="auto">Auto — Bedrock, then Anthropic, then local (if a URL is set)</option>
              <option value="bedrock">Bedrock only</option>
              <option value="anthropic">Anthropic only</option>
              <option value="local">Local model only</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button className="primary" onClick={() => void save()}>Save local model settings</button>
          {status && <span className="settings-card-desc">{status}</span>}
        </div>
      </div>
    </section>
  );
}
