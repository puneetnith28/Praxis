import { useState } from 'react';

interface Flags {
  dangerouslySkipPermissions?: boolean;
  remoteControl?: boolean;
  terminal?: boolean;
}

interface Props {
  projectCwd: string;
  onClose: () => void;
  onCreate: (data: { name: string; cli: string; cwd?: string; role?: string; flags?: Flags }) => void;
}

export default function CreateAgentModal({ projectCwd, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [cli, setCli] = useState('claude');
  const [cwd, setCwd] = useState(projectCwd);
  const [role, setRole] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [remoteControl, setRemoteControl] = useState(false);
  const [terminalMode, setTerminalMode] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;
    const flags: Flags = {};
    if (cli === 'claude' || cli === 'opencode') {
      if (skipPermissions) flags.dangerouslySkipPermissions = true;
    }
    if (cli === 'claude') {
      if (remoteControl) flags.remoteControl = true;
    }
    if (cli === 'localharness' && terminalMode) flags.terminal = true;
    onCreate({
      name, cli,
      cwd: cwd || undefined,
      role: role || undefined,
      flags: Object.keys(flags).length > 0 ? flags : undefined,
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>New Agent</h2>
        <form onSubmit={handleSubmit}>
          <label>Agent Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Frontend" autoFocus />

          <label>CLI</label>
          <select value={cli} onChange={e => setCli(e.target.value)}>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex CLI</option>
            <option value="gemini">Gemini CLI</option>
            <option value="opencode">OpenCode</option>
            <option value="gpt">GPT-OSS 120B (Groq)</option>
            <option value="nemotron">Nemotron (OpenRouter)</option>
            <option value="localharness">LocalHarness (local model)</option>
          </select>

          {cli === 'localharness' && (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontSize: 12, opacity: 0.75, margin: '0 0 8px' }}>
                Runs on your local model server (LOCAL_LLM_BASE_URL, default Ollama at
                127.0.0.1:11434). Every permission it asks for becomes an approval gate here.
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', margin: 0 }}>
                <input
                  type="checkbox"
                  checked={terminalMode}
                  onChange={e => setTerminalMode(e.target.checked)}
                  style={{ width: 'auto' }}
                />
                <span style={{ fontSize: 13 }}>Terminal mode — the interactive REPL instead of the structured view</span>
              </label>
            </div>
          )}

          {(cli === 'claude' || cli === 'opencode') && (
            <div style={{ marginTop: 12 }}>
              <label style={{ marginBottom: 8 }}>Flags</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={skipPermissions}
                    onChange={e => setSkipPermissions(e.target.checked)}
                    style={{ width: 'auto' }}
                  />
                  <span style={{ fontSize: 13 }}>--dangerously-skip-permissions</span>
                </label>
                {cli === 'claude' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={remoteControl}
                      onChange={e => setRemoteControl(e.target.checked)}
                      style={{ width: 'auto' }}
                    />
                    <span style={{ fontSize: 13 }}>--remote-control</span>
                  </label>
                )}
              </div>
            </div>
          )}

          <label>Working Directory</label>
          <input value={cwd} onChange={e => setCwd(e.target.value)} />

          <label>Role (optional)</label>
          <input value={role} onChange={e => setRole(e.target.value)} placeholder="e.g. Frontend Developer" />

          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={!name}>Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}
