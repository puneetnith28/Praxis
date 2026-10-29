import { useEffect, useState } from 'react';
import type { Plan, Project } from '../api';
import Ic from './Icons';

interface PlanModalProps {
  project?: Project;
  plan: Plan;
  /** How many more plans are queued behind this one. */
  queued?: number;
  onClose: () => void;
  onResolve: (decision: 'approve' | 'reject', reason?: string) => Promise<void> | void;
}

export default function PlanModal({ project, plan, queued = 0, onClose, onResolve }: PlanModalProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (decision: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onResolve(decision, reason.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal-plan"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="plan-title"><Ic.sparkles size={14} style={{ color: 'var(--accent)' }} /> Supervisor plan awaiting approval</h2>
          <button className="hbtn" onClick={onClose} aria-label="Dismiss for now" title="Dismiss for now (Esc)"><Ic.x size={14} /></button>
        </div>

        <div className="modal-kv">
          <div className="k">Project</div><div className="v">{project?.name || plan.projectId}</div>
          <div className="k">Target agent</div><div className="v">{plan.targetAgent}</div>
          <div className="k">Proposed</div><div className="v">{new Date(plan.createdAt).toLocaleString()}</div>
        </div>

        <label>Why the Supervisor wants this</label>
        <div className="modal-pre wrap">{plan.description}</div>

        <label>Exact message that would be sent to {plan.targetAgent}</label>
        <pre className="modal-pre accent">{plan.proposedMessage}</pre>

        <label htmlFor="plan-reason">Reason (used if you reject — the Supervisor sees it)</label>
        <input
          id="plan-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Optional — e.g. not now, we're mid-release"
        />

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          {queued > 0 && <span className="modal-queued">{queued} more waiting</span>}
          <button type="button" onClick={onClose} disabled={busy}>Later</button>
          <button type="button" className="danger" onClick={() => void resolve('reject')} disabled={busy}>Reject</button>
          <button type="button" className="primary" onClick={() => void resolve('approve')} disabled={busy}>
            Approve &amp; send
          </button>
        </div>
      </div>
    </div>
  );
}
