import React from 'react';
import { ECOSYSTEM_ROWS } from './BrandIcons';
import { ToolMarqueeRow } from './ToolMarqueeRow';

export const ToolEcosystemSection: React.FC = () => {
  return (
    <section
      id="ecosystem"
      className="landing-section tool-ecosystem-section"
      aria-label="Bedrock Supported Tool Ecosystem"
    >
      {/* Section Header */}
      <div className="ecosystem-header">
        <h2 className="ecosystem-heading">
          WORKS WITH THE TOOLS<br />
          <span className="highlight-pill">ENGINEERS ALREADY USE</span>
        </h2>
        <p className="ecosystem-subtext">
          Bring your existing agents, development tools, and AI infrastructure into one control center.
        </p>
      </div>

      {/* Marquee Viewport with Edge Fade Masking */}
      <div className="ecosystem-marquee-viewport">
        {/* Subtle Edge Fade Gradients for Older Browser Fallback */}
        <div className="edge-fade-mask left" aria-hidden="true" />
        <div className="edge-fade-mask right" aria-hidden="true" />

        {/* 4 Alternating Horizontal Lanes */}
        <div className="ecosystem-rows-container">
          {ECOSYSTEM_ROWS.map((row) => (
            <ToolMarqueeRow
              key={row.id}
              rowId={row.id}
              direction={row.direction}
              speedSec={row.speedSec}
              tools={row.tools}
            />
          ))}
        </div>
      </div>
    </section>
  );
};

export default ToolEcosystemSection;
