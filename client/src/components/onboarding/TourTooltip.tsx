import React, { useMemo } from 'react';
import type { TourStepConfig, TargetRect } from './tourTypes';

interface TourTooltipProps {
  step: TourStepConfig;
  totalSteps: number;
  targetRect: TargetRect | null;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  canAdvance?: boolean;
}

export const TourTooltip: React.FC<TourTooltipProps> = ({
  step,
  totalSteps,
  targetRect,
  onNext,
  onBack,
  onSkip,
  canAdvance = true,
}) => {
  // Compute best position for tooltip based on targetRect
  const positionStyle = useMemo(() => {
    if (step.isDownloadStep) {
      return {
        bottom: '24px',
        right: '24px',
        zIndex: 100002,
      };
    }

    if (!targetRect) {
      return {
        bottom: '32px',
        right: '32px',
      };
    }

    const cardWidth = 330;
    const cardHeight = 220;
    const margin = 14;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let top = 0;
    let left = 0;

    const placement = step.preferredPlacement || 'bottom';

    if (placement === 'bottom') {
      top = targetRect.top + targetRect.height + margin;
      left = targetRect.left + (targetRect.width - cardWidth) / 2;
    } else if (placement === 'top') {
      top = targetRect.top - cardHeight - margin;
      left = targetRect.left + (targetRect.width - cardWidth) / 2;
    } else if (placement === 'right') {
      top = targetRect.top + (targetRect.height - cardHeight) / 2;
      left = targetRect.left + targetRect.width + margin;
    } else if (placement === 'left') {
      top = targetRect.top + (targetRect.height - cardHeight) / 2;
      left = targetRect.left - cardWidth - margin;
    }

    // Viewport clamp
    left = Math.max(16, Math.min(left, viewportW - cardWidth - 16));
    top = Math.max(16, Math.min(top, viewportH - cardHeight - 16));

    return {
      top: `${top}px`,
      left: `${left}px`,
    };
  }, [targetRect, step.preferredPlacement, step.isDownloadStep]);

  const isFirstStep = step.stepNumber === 1;
  const isLastStep = step.stepNumber === totalSteps;

  return (
    <div
      className="tour-tooltip-card"
      style={positionStyle}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-tooltip-title"
      aria-describedby="tour-tooltip-desc"
    >
      {/* Header */}
      <div className="tour-card-header">
        <span className="tour-phase-chip">
          Phase {step.phase}: {step.phaseTitle}
        </span>
        <span className="tour-step-counter">
          Step {step.stepNumber} of {totalSteps}
        </span>
      </div>

      {/* Progress Dots */}
      <div className="tour-progress-row" aria-hidden="true">
        {Array.from({ length: totalSteps }).map((_, idx) => {
          const num = idx + 1;
          const isCurrent = num === step.stepNumber;
          const isFilled = num < step.stepNumber;
          return (
            <span
              key={num}
              className={`tour-progress-dot ${isFilled ? 'filled' : ''} ${isCurrent ? 'active' : ''}`}
            />
          );
        })}
      </div>

      {/* Content */}
      <h3 id="tour-tooltip-title" className="tour-card-title">
        {step.title}
      </h3>
      <p id="tour-tooltip-desc" className="tour-card-desc">
        {step.tooltipText || step.description}
      </p>

      {/* Controls */}
      <div className="tour-actions-row">
        <button
          type="button"
          className="tour-btn tour-btn-ghost"
          onClick={onSkip}
          aria-label="Skip product tour"
        >
          Skip tour
        </button>

        <div className="tour-btn-group-right">
          {!isFirstStep && (
            <button
              type="button"
              className="tour-btn tour-btn-secondary"
              onClick={onBack}
            >
              Back
            </button>
          )}

          {canAdvance && (
            <button
              type="button"
              className="tour-btn tour-btn-primary"
              onClick={onNext}
            >
              {isLastStep ? 'Finish Tour' : 'Next →'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
