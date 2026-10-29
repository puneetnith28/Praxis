import React from 'react';
import { BrandIcons, ToolItem } from './BrandIcons';

interface ToolMarqueeRowProps {
  direction: 'left' | 'right';
  speedSec: number;
  tools: ToolItem[];
  rowId: string;
}

export const ToolMarqueeRow: React.FC<ToolMarqueeRowProps> = ({
  direction,
  speedSec,
  tools,
  rowId,
}) => {
  // Seamless loop: repeat tools to ensure unbroken infinite track
  const trackItems = [...tools, ...tools, ...tools];

  return (
    <div
      className="ecosystem-marquee-row"
      role="region"
      aria-label={`Ecosystem row: ${rowId}`}
    >
      <div
        className={`marquee-infinite-track marquee-${direction}`}
        style={{ animationDuration: `${speedSec}s` }}
      >
        {trackItems.map((tool, idx) => {
          const IconComponent = BrandIcons[tool.iconKey];
          return (
            <div
              key={`${tool.id}-${idx}`}
              className="ecosystem-logo-item"
              tabIndex={0}
              role="img"
              aria-label={tool.name}
            >
              <span className="logo-brand-icon" aria-hidden="true">
                {IconComponent ? <IconComponent size={19} /> : null}
              </span>
              <span className="logo-brand-name">{tool.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
