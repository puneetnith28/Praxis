import React, { useState, useEffect } from 'react';
import Ic from '../Icons';

// ============================================================================
// STEP 01: Watch & Classify in Real Time
// Uncluttered, silky-smooth animated classification showcase
// ============================================================================
export const WatchClassifyDemo: React.FC = () => {
  const [index, setIndex] = useState<number>(0);

  const classifications = [
    {
      agent: 'claude-code',
      tag: 'Progress',
      color: '#15803d',
      bg: '#ecfdf5',
      text: 'Verified 14/14 auth tests passing with zero regressions.',
      icon: <Ic.check size={13} />,
    },
    {
      agent: 'gemini-cli',
      tag: 'Schema Audit',
      color: '#7c3aed',
      bg: '#f5f3ff',
      text: 'Migration verified non-destructive. Schema append approved.',
      icon: <Ic.shield size={13} />,
    },
    {
      agent: 'codex',
      tag: 'Blocker Detected',
      color: '#b45309',
      bg: '#fffbeb',
      text: 'Missing STRIPE_WEBHOOK_SECRET. Agent paused awaiting input.',
      icon: <Ic.bolt size={13} />,
    },
    {
      agent: 'opencode',
      tag: 'Regex Scan',
      color: '#0f0f11',
      bg: '#f4f4f5',
      text: 'Terminal output scanned: zero destructive patterns detected.',
      icon: <Ic.sparkles size={13} />,
    },
  ];

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % classifications.length);
    }, 3600);
    return () => clearInterval(timer);
  }, [classifications.length]);

  const current = classifications[index];

  return (
    <div className="preview-prompt-card animated-prompt-card" role="region" aria-label="Supervisor live classification">
      <div className="animated-prompt-content">
        <div className="prompt-meta-header">
          <span className="prompt-agent-badge">{current.agent}</span>
          <span
            className="prompt-classification-pill"
            style={{ color: current.color, backgroundColor: current.bg }}
          >
            <span className="pill-dot" style={{ backgroundColor: current.color }} />
            {current.tag}
          </span>
        </div>

        <div key={index} className="preview-prompt-text fade-swap">
          {current.text}
        </div>
      </div>

      <div className="preview-submit-arrow animated-arrow" title="Active Supervisor Classification">
        {current.icon}
      </div>
    </div>
  );
};

// ============================================================================
// STEP 02: Gate & Plan Approval
// Uncluttered, clean animated human-in-the-loop gate resolution
// ============================================================================
export const GateApprovalDemo: React.FC<{ onOpenConsole?: () => void }> = ({ onOpenConsole }) => {
  // Phase 0: Risky command intercepted & agent paused
  // Phase 1: Human engineer clicks "Reject & Reroute"
  // Phase 2: Agent redirected safely to feature branch
  const [phase, setPhase] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setPhase((prev) => {
        if (prev === 0) return 1;
        if (prev === 1) return 2;
        return 0;
      });
    }, 3800);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="preview-result-card animated-gate-card" role="region" aria-label="Approval Gate Simulation">
      {/* Dynamic Agent Speech Bubble */}
      <div className="preview-user-query-wrap">
        <div
          key={phase === 2 ? 'reroute' : 'initial'}
          className={`preview-user-query ${phase === 2 ? 'rerouted' : ''}`}
        >
          {phase === 2
            ? 'claude: git checkout -b feat/auth && git push origin feat/auth'
            : 'claude: git push origin main --force'}
        </div>
      </div>

      {/* Dynamic Status Tag */}
      <div className="preview-status-tag" style={{ color: phase === 2 ? '#15803d' : '#dc2626' }}>
        <span
          className="check-icon"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: phase === 2 ? '#15803d' : '#dc2626',
          }}
        >
          {phase === 2 ? <Ic.check size={12} /> : <Ic.logo size={12} />}
        </span>
        {phase === 0 && 'APPROVAL GATE REQUIRED'}
        {phase === 1 && 'HUMAN REVIEW: VETO FORCE PUSH'}
        {phase === 2 && 'GATE RESOLVED SAFELY'}
      </div>

      {/* Dynamic Explanation Text */}
      <div key={phase} className="preview-summary-text fade-swap">
        {phase === 0 && (
          <>
            Destructive force push detected on <strong>'main'</strong>. Agent paused until human review.
          </>
        )}
        {phase === 1 && (
          <>
            Force push vetoed. Rerouting agent to a dedicated feature branch...
          </>
        )}
        {phase === 2 && (
          <>
            Branch <strong>'feat/auth'</strong> safely created. Main branch protected.
          </>
        )}
      </div>

      {/* Clean, Non-Cluttered Action Pill */}
      <div className="gate-footer-row">
        {phase === 0 && (
          <button
            type="button"
            className="preview-action-pill gate-reject-pill"
            onClick={() => setPhase(1)}
          >
            Reject & Reroute
          </button>
        )}
        {phase === 1 && (
          <button
            type="button"
            className="preview-action-pill gate-active-pill"
            onClick={() => setPhase(2)}
          >
            Redirecting Agent...
          </button>
        )}
        {phase === 2 && (
          <button
            type="button"
            className="preview-action-pill"
            onClick={onOpenConsole}
          >
            Review in Console
          </button>
        )}

        {/* Minimalist 3-dot step indicator */}
        <div className="gate-mini-dots" aria-label={`Step ${phase + 1} of 3`}>
          <span className={`mini-dot ${phase === 0 ? 'active' : ''}`} onClick={() => setPhase(0)} />
          <span className={`mini-dot ${phase === 1 ? 'active' : ''}`} onClick={() => setPhase(1)} />
          <span className={`mini-dot ${phase === 2 ? 'active' : ''}`} onClick={() => setPhase(2)} />
        </div>
      </div>
    </div>
  );
};
