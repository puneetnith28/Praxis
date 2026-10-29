import React from 'react';
import type { TargetRect } from './tourTypes';

interface TourSpotlightProps {
  targetRect: TargetRect | null;
  pulse?: boolean;
}

export const TourSpotlight: React.FC<TourSpotlightProps> = ({ targetRect, pulse = true }) => {
  if (!targetRect) {
    return <div className="tour-dim-backdrop" />;
  }

  const padding = 6;
  const top = Math.max(0, targetRect.top - padding);
  const left = Math.max(0, targetRect.left - padding);
  const width = targetRect.width + padding * 2;
  const height = targetRect.height + padding * 2;
  const borderRadius = targetRect.borderRadius ? targetRect.borderRadius + 2 : 8;

  return (
    <>
      <div
        className={`tour-spotlight-ring ${pulse ? 'pulse' : ''}`}
        style={{
          top: `${top}px`,
          left: `${left}px`,
          width: `${width}px`,
          height: `${height}px`,
          borderRadius: `${borderRadius}px`,
        }}
      />
    </>
  );
};
