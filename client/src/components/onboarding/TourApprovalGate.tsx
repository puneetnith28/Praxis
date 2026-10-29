import React, { useState } from 'react';

interface TourApprovalGateProps {
  onApproved: () => void;
  onReject?: () => void;
}

export const TourApprovalGate: React.FC<TourApprovalGateProps> = ({ onApproved, onReject }) => {
  const [approved, setApproved] = useState(false);

  const handleApprove = () => {
    if (approved) return;
    setApproved(true);
    // Allow animation feedback, then notify tour controller
    setTimeout(() => {
      onApproved();
    }, 900);
  };

  return (
    <div className="tour-gate-modal-wrap" data-tour="approval-gate">
      <div className="tour-gate-card" role="dialog" aria-modal="true">
        <div className="tour-gate-badge">
          <span>●</span> Approval Gate Intercepted
        </div>

        <h3 className="tour-gate-title">Destructive Action Intercepted</h3>
        <p className="tour-gate-desc">
          <strong>Claude Code</strong> attempted a force push to the shared branch. Execution has been paused by the Supervisor.
        </p>

        <div className="tour-gate-snippet">
          <code>$ git push origin feature/auth --force</code>
        </div>

        <div className="tour-gate-actions">
          <button
            type="button"
            className="tour-gate-btn-reject"
            onClick={onReject}
            disabled={approved}
          >
            Reject (Esc)
          </button>
          <button
            type="button"
            className={`tour-gate-btn-approve ${approved ? 'clicked' : ''}`}
            onClick={handleApprove}
            autoFocus
          >
            {approved ? '✓ Approval Received' : 'Approve with Lease (Y)'}
          </button>
        </div>
      </div>
    </div>
  );
};
