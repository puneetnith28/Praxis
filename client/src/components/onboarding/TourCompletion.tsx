import React from 'react';

interface TourCompletionProps {
  onFinish: () => void;
}

export const TourCompletion: React.FC<TourCompletionProps> = ({ onFinish }) => {
  return (
    <div className="tour-completion-backdrop" role="dialog" aria-modal="true">
      <div className="tour-completion-card">
        <div className="tour-completion-icon">✓</div>
        <h3 className="tour-completion-title">You're ready to use Bedrock</h3>

        <div className="tour-completion-bullets">
          <span>Run agents.</span>
          <span>Watch their work.</span>
          <span>Stay in control.</span>
        </div>

        <button
          type="button"
          className="tour-btn tour-btn-primary"
          style={{ width: '100%', height: 38, fontSize: 13 }}
          onClick={onFinish}
          autoFocus
        >
          Start exploring →
        </button>
      </div>
    </div>
  );
};
