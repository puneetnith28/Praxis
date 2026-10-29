import React, { useEffect } from 'react';

interface TourPhaseTransitionProps {
  onComplete: () => void;
  durationMs?: number;
  eyebrow?: string;
  heading?: string;
  message?: string;
}

export const TourPhaseTransition: React.FC<TourPhaseTransitionProps> = ({
  onComplete,
  durationMs = 1200,
  eyebrow = 'PHASE 2',
  heading = 'Inside the Control Center',
  message = "Now let's step inside the live Bedrock Control Center workspace.",
}) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onComplete();
    }, durationMs);
    return () => clearTimeout(timer);
  }, [onComplete, durationMs]);

  return (
    <div className="tour-transition-backdrop" role="alert" aria-live="polite">
      <div className="tour-transition-card">
        <div className="tour-transition-eyebrow">{eyebrow}</div>
        <h3 className="tour-transition-heading">{heading}</h3>
        <p className="tour-transition-lead">{message}</p>
        <div className="tour-transition-bar">
          <div className="tour-transition-fill" />
        </div>
      </div>
    </div>
  );
};
