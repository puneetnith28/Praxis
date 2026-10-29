import React from 'react';
import type { CursorPosition } from './tourTypes';

interface TourCursorProps {
  cursor: CursorPosition;
}

export const TourCursor: React.FC<TourCursorProps> = ({ cursor }) => {
  if (!cursor.visible) return null;

  return (
    <div
      className={`tour-cursor ${cursor.clicking ? 'clicking' : ''}`}
      style={{
        transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)`,
      }}
      aria-hidden="true"
    >
      <svg
        className="tour-cursor-svg"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M5.5 3.5L18.5 12L12 13.5L9.5 19.5L5.5 3.5Z"
          fill="#0f0f11"
          stroke="#ffffff"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
      </svg>
      {cursor.clicking && <span className="tour-click-ripple" />}
    </div>
  );
};
