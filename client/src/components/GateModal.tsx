import { useEffect, useState } from 'react';
import type { Agent, PendingGate, Project } from '../api';
import Ic from './Icons';

interface Props {
  project?: Project;
  agent?: Agent;
  gate?: PendingGate;
  /** Total agents blocked on an approval, this one included. */
  queued?: number;
  onClose: () => void;
  /** `optionId`: for an ACP gate, the exact answer chosen from the agent's own options. */
  onResolve: (decision: 'approve' | 'reject' | 'custom', customInput?: string, optionId?: string) => Promise<void> | void;
}

const YES_NO = /\[y\/N\]|\[Y\/n\]|\(yes\/no\)|\(y\/n\)/i;

export default function GateModal({ project, agent, gate, queued = 1, onClose, onResolve }: Props) {
  const acpOptions = gate?.source === 'acp' ? gate.acpOptions || [] : [];
  const [customInput, setCustomInput] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const yesNo = !!gate && gate.source === 'regex' && YES_NO.test(gate.prompt);

  const resolve = async (decision: 'approve' | 'reject' | 'custom', input?: string, optionId?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onResolve(decision, input, optionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // Keyboard: y = approve, n = reject, Esc = close (only while not typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showCustom) return;
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); void resolve('approve'); }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); void resolve('reject'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCustom, busy]);

  if (!agent || !gate) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="gate-title">
            <Ic.stop size={12} /> {agent.name} needs your decision
            {/* Gates queue one at a time, so without this you cannot tell
                whether one agent is blocked or five are. */}
            {queued > 1 && (
              <span className="gate-queued" title={`${queued} agents are blocked on an approval`}>
                +{queued - 1} more waiting
              </span>
            )}
          </h2>
          <button className="hbtn" onClick={onClose} aria-label="Close" title="Close (Esc)"><Ic.x size={14} /></button>
        </div>

        <p className="modal-lead">
          <strong>{agent.name}</strong> in <strong>{project?.name || agent.projectId}</strong>
          {gate.source === 'supervisor'
            ? ' is about to do something the Supervisor flagged as risky.'
            : gate.source === 'acp'
              ? ' is asking permission. Choose one of its answers.'
              : yesNo
                ? ' is waiting for a yes / no answer.'
                : ' hit a command or prompt that matches a risk pattern.'}
        </p>

        <pre className="modal-pre">{gate.prompt}</pre>

        {gate.source === 'acp' && (
          <p className="modal-note">
            The agent waits until you answer. “Always” and “Never” are remembered by
            LocalHarness for this workspace; the others apply to this request only.
          </p>
        )}

        {!yesNo && gate.source === 'regex' && (
          <p className="modal-note">
            Approve leaves the agent alone. Reject sends Escape to interrupt it and tells it to stop.
          </p>
        )}
        {gate.source === 'supervisor' && (
          <p className="modal-note">
            Reject interrupts the agent and tells it not to proceed. Approve lets it continue.
          </p>
        )}

        {error && <div className="modal-error">{error}</div>}

        {!showCustom && acpOptions.length > 0 ? (
          <div className="modal-actions">
            <button type="button" onClick={() => setShowCustom(true)} disabled={busy}>Refuse and say instead…</button>
            {acpOptions.map((o) => {
              const allow = o.kind.startsWith('allow');
              const key = o.kind === 'allow_once' ? 'y' : o.kind === 'reject_once' ? 'n' : null;
              return (
                <button
                  key={o.id}
                  type="button"
                  className={allow ? 'primary' : 'danger'}
                  onClick={() => void resolve(allow ? 'approve' : 'reject', undefined, o.id)}
                  disabled={busy}
                >
                  {o.name}{key && <> <kbd>{key}</kbd></>}
                </button>
              );
            })}
          </div>
        ) : !showCustom ? (
          <div className="modal-actions">
            <button type="button" onClick={() => setShowCustom(true)} disabled={busy}>Type a reply…</button>
            <button type="button" className="danger" onClick={() => void resolve('reject')} disabled={busy}>
              Reject <kbd>n</kbd>
            </button>
            <button type="button" className="primary" onClick={() => void resolve('approve')} disabled={busy}>
              Approve <kbd>y</kbd>
            </button>
          </div>
        ) : (
          <div className="modal-custom">
            <label htmlFor="gate-custom">
              {gate.source === 'acp'
                ? 'Refuse the request, then send the agent this instead'
                : 'Send this to the agent\'s terminal'}
            </label>
            <input
              id="gate-custom"
              autoFocus
              placeholder="e.g. 2, or a short instruction…"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customInput.trim()) void resolve('custom', customInput);
                if (e.key === 'Escape') setShowCustom(false);
              }}
            />
            <div className="modal-actions">
              <button type="button" onClick={() => setShowCustom(false)} disabled={busy}>Back</button>
              <button type="button" className="primary" onClick={() => void resolve('custom', customInput)} disabled={busy || !customInput.trim()}>
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
