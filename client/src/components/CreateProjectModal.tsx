import { useState } from 'react';

interface Props {
  onClose: () => void;
  onCreate: (data: { name: string; cwd: string; description?: string }) => void;
  /** Prefilled working directory — the desktop app's native folder picker. */
  initialCwd?: string;
}

export default function CreateProjectModal({ onClose, onCreate, initialCwd }: Props) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(initialCwd || '');
  const [description, setDescription] = useState('');

  // Only the desktop shell can open a native directory dialog; in a browser the
  // path has to be typed.
  const desktop = window.conduitDesktop;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !cwd) return;
    onCreate({ name, cwd, description: description || undefined });
  };

  const browse = async () => {
    const dir = await desktop?.selectDirectory();
    if (dir) {
      setCwd(dir);
      // A fresh project usually wants the folder's own name.
      if (!name) setName(dir.split(/[\\/]/).filter(Boolean).pop() || '');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>New Project</h2>
        <form onSubmit={handleSubmit}>
          <label>Project Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. MyProject" autoFocus />

          <label>Working Directory</label>
          {desktop ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1, minWidth: 0 }}
                value={cwd}
                onChange={e => setCwd(e.target.value)}
                placeholder="e.g. C:\\Users\\you\\projects\\myapp"
              />
              <button type="button" onClick={browse}>Browse…</button>
            </div>
          ) : (
            <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="e.g. /home/user/projects/myapp" />
          )}

          <label>Description (optional)</label>
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description" />

          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={!name || !cwd}>Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}
