import React from 'react';

interface TourWelcomeProps {
  onStart: () => void;
  onSkip: () => void;
}

export const TourWelcome: React.FC<TourWelcomeProps> = ({ onStart, onSkip }) => {
  return (
    <div
      className="tour-welcome-card"
      role="dialog"
      aria-labelledby="tour-welcome-heading"
      aria-describedby="tour-welcome-text"
    >
      <div className="tour-welcome-brand">
        <span className="tour-brand-badge">Tour</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#71717a' }}>Product Walkthrough</span>
      </div>

      <h3 id="tour-welcome-heading" className="tour-welcome-title">
        Welcome to Bedrock
      </h3>

      <p id="tour-welcome-text" className="tour-welcome-desc">
        Your control center for AI coding agents. Let's take a quick tour.
      </p>

      <div className="tour-welcome-actions">
        <button
          type="button"
          className="tour-btn tour-btn-ghost"
          onClick={onSkip}
        >
          Skip
        </button>
        <button
          type="button"
          className="tour-btn tour-btn-primary"
          onClick={onStart}
          autoFocus
        >
          Start Tour →
        </button>
      </div>
    </div>
  );
};
