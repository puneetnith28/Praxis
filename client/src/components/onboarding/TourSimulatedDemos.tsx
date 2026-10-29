import React, { useState, useEffect } from 'react';

/**
 * Step 3: Progressive terminal typing micro-demo
 */
export const TourTerminalDemo: React.FC = () => {
  const [lines, setLines] = useState<string[]>([]);
  const [cmdText, setCmdText] = useState('');

  useEffect(() => {
    let timer1: NodeJS.Timeout;
    let timer2: NodeJS.Timeout;
    let timer3: NodeJS.Timeout;
    let timer4: NodeJS.Timeout;

    // Simulate progressive typing of $ npm test
    const fullCmd = 'npm test';
    let charIdx = 0;
    const typeInterval = setInterval(() => {
      charIdx++;
      setCmdText(fullCmd.slice(0, charIdx));
      if (charIdx >= fullCmd.length) {
        clearInterval(typeInterval);
        timer1 = setTimeout(() => {
          setLines(['Running tests...']);
        }, 300);
        timer2 = setTimeout(() => {
          setLines((prev) => [...prev, '✓ auth.test.ts (110ms)']);
        }, 900);
        timer3 = setTimeout(() => {
          setLines((prev) => [...prev, '✓ session.test.ts (85ms)']);
        }, 1500);
        timer4 = setTimeout(() => {
          setLines((prev) => [...prev, '✓ middleware.test.ts (142ms)']);
        }, 2100);
      }
    }, 45);

    return () => {
      clearInterval(typeInterval);
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
      clearTimeout(timer4);
    };
  }, []);

  return (
    <div className="tour-demo-terminal-box">
      <div className="tour-demo-term-cmd">
        $ {cmdText}
        {lines.length === 0 && <span className="tour-demo-term-caret">█</span>}
      </div>
      {lines.map((l, i) => (
        <div
          key={i}
          className={l.includes('✓') ? 'tour-demo-term-pass' : 'tour-demo-term-dim'}
        >
          {l}
        </div>
      ))}
      {lines.length > 0 && lines.length < 4 && (
        <span className="tour-demo-term-caret">█</span>
      )}
    </div>
  );
};

/**
 * Step 6: Sequential Group Chat message appearance
 */
export const TourGroupChatDemo: React.FC = () => {
  const [visibleCount, setVisibleCount] = useState(0);

  const messages = [
    { sender: 'Claude Code', role: 'agent', text: 'Middleware refactor complete.' },
    { sender: 'Codex', role: 'agent', text: 'Integration tests updated.' },
    { sender: 'Gemini CLI', role: 'agent', text: 'I found an edge case.' },
    { sender: 'Engineer', role: 'human', text: 'Investigate it before continuing.' },
  ];

  useEffect(() => {
    const t1 = setTimeout(() => setVisibleCount(1), 300);
    const t2 = setTimeout(() => setVisibleCount(2), 1200);
    const t3 = setTimeout(() => setVisibleCount(3), 2100);
    const t4 = setTimeout(() => setVisibleCount(4), 3000);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, []);

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {messages.slice(0, visibleCount).map((m, i) => (
        <div
          key={i}
          style={{
            padding: '7px 10px',
            borderRadius: 6,
            background: m.role === 'human' ? '#f4f4f5' : '#ffffff',
            border: '1px solid #e4e4e7',
            fontSize: 12,
            lineHeight: 1.4,
            animation: 'tourTooltipIn 0.3s ease',
          }}
        >
          <div style={{ fontWeight: 650, fontSize: 11, color: m.role === 'human' ? '#0f0f11' : '#4f46e5', marginBottom: 2 }}>
            {m.sender}
          </div>
          <div style={{ color: '#27272a' }}>{m.text}</div>
        </div>
      ))}
    </div>
  );
};

/**
 * Step 7: MCP Inter-agent message packet animation
 */
export const TourMcpDemo: React.FC = () => {
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setPulse(true);
      setTimeout(() => setPulse(false), 800);
    }, 1800);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      style={{
        marginTop: 12,
        padding: '12px',
        borderRadius: 8,
        background: '#f8fafc',
        border: '1px solid #e2e8f0',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 650, color: '#0f172a' }}>Claude Code</span>
        <span style={{ fontSize: 10, color: '#64748b', background: '#e2e8f0', padding: '2px 6px', borderRadius: 4 }}>
          message_agent()
        </span>
      </div>

      <div style={{ textAlign: 'center', padding: '6px 0', color: pulse ? '#4f46e5' : '#94a3b8', transition: 'color 0.3s' }}>
        ↓ "auth middleware updated"
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <span style={{ fontWeight: 650, color: '#0f172a' }}>Codex CLI</span>
        <span style={{ fontSize: 10, color: '#16a34a', background: '#dcfce7', padding: '2px 6px', borderRadius: 4 }}>
          ✓ Context received
        </span>
      </div>
    </div>
  );
};

/**
 * Step 8: The Keeper command and telemetry response
 */
export const TourKeeperDemo: React.FC = () => {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setStep(1), 400);
    const t2 = setTimeout(() => setStep(2), 1400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div
      style={{
        marginTop: 12,
        padding: '12px',
        borderRadius: 8,
        background: '#18181b',
        color: '#f4f4f5',
        fontSize: 12,
        fontFamily: 'monospace',
      }}
    >
      <div style={{ color: '#a1a1aa', marginBottom: 6 }}>
        ❯ "Review the latest agent activity."
      </div>
      {step >= 1 && (
        <div style={{ color: '#e4e4e7', lineHeight: 1.5, animation: 'tourTooltipIn 0.3s ease' }}>
          {step === 1 && <span style={{ color: '#fbbf24' }}>Evaluating repository context...</span>}
          {step >= 2 && (
            <div>
              <div style={{ color: '#4ade80' }}>● 3 agents active</div>
              <div style={{ color: '#60a5fa' }}>● 1 review pending</div>
              <div style={{ color: '#a1a1aa' }}>● 0 blockers</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
