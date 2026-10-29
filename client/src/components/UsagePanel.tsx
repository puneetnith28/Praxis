import { useState, useEffect } from 'react';
import claudeIcon from '../assets/claude.svg';
import codexIcon from '../assets/codex.svg';

interface UsageData {
  session: { utilization: number; resetsAt: string } | null;
  week: { utilization: number; resetsAt: string } | null;
  updatedAt: string;
}

interface AllUsage {
  claude: UsageData | null;
  codex: UsageData | null;
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return 'Unknown';
  const reset = new Date(resetsAt);
  const now = new Date();
  const diffMs = reset.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return diffMins + 'm';
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return diffHrs + 'h ' + (diffMins % 60) + 'm';
  const diffDays = Math.floor(diffHrs / 24);
  return diffDays + 'd ' + (diffHrs % 24) + 'h';
}

function UsageCard({
  title,
  icon,
  data,
  color,
}: {
  title: string;
  icon: string;
  data: UsageData | null;
  color: string;
}) {
  if (!data) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col items-center justify-center text-gray-500 min-h-[200px]" style={{ background: 'var(--bg2)', borderColor: 'var(--border)' }}>
        <img src={icon} alt={title} className="w-8 h-8 opacity-50 mb-3" style={{ filter: 'grayscale(100%)', width: 32, height: 32 }} />
        <p>No usage data available for {title}</p>
        <p className="text-xs mt-1" style={{ fontSize: 12 }}>Check your API credentials</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col relative overflow-hidden" style={{ background: 'var(--bg2)', borderColor: 'var(--border)' }}>
      <div className="absolute top-0 right-0 p-4" style={{ position: 'absolute', top: 0, right: 0, padding: 16 }}>
        <img src={icon} alt={title} className="w-8 h-8 opacity-20" style={{ width: 32, height: 32, opacity: 0.2 }} />
      </div>
      
      <div className="flex items-center gap-3 mb-6" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <img src={icon} alt={title} className="w-6 h-6" style={{ width: 24, height: 24 }} />
        <h3 className="text-xl font-bold text-gray-100" style={{ fontSize: 20, fontWeight: 'bold', margin: 0, color: 'var(--fg)' }}>{title} Usage</h3>
      </div>
      
      <div className="space-y-6 flex-1" style={{ display: 'flex', flexDirection: 'column', gap: 24, flex: 1 }}>
        <div>
          <div className="flex justify-between text-sm mb-2" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
            <span className="text-gray-400 uppercase tracking-wider font-semibold" style={{ color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Session</span>
            <div className="flex gap-3" style={{ display: 'flex', gap: 12 }}>
              <span className="text-gray-200 font-medium" style={{ color: 'var(--fg)', fontWeight: 500 }}>
                {data.session ? Math.round(data.session.utilization) : 0}%
              </span>
              <span className="text-gray-500" style={{ color: 'var(--text-3)' }}>
                resets in {data.session ? formatResetTime(data.session.resetsAt) : 'N/A'}
              </span>
            </div>
          </div>
          <div className="w-full h-3 bg-black rounded-full overflow-hidden border border-gray-800" style={{ width: '100%', height: 12, background: 'var(--bg)', borderRadius: 999, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <div 
              className="h-full rounded-full transition-all duration-1000 ease-out" 
              style={{ 
                height: '100%',
                borderRadius: 999,
                transition: 'all 1s ease-out',
                width: `${Math.min(100, data.session?.utilization || 0)}%`,
                backgroundColor: color,
                boxShadow: `0 0 10px ${color}80`
              }} 
            />
          </div>
        </div>

        <div>
          <div className="flex justify-between text-sm mb-2" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
            <span className="text-gray-400 uppercase tracking-wider font-semibold" style={{ color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Week</span>
            <div className="flex gap-3" style={{ display: 'flex', gap: 12 }}>
              <span className="text-gray-200 font-medium" style={{ color: 'var(--fg)', fontWeight: 500 }}>
                {data.week ? Math.round(data.week.utilization) : 0}%
              </span>
              <span className="text-gray-500" style={{ color: 'var(--text-3)' }}>
                resets in {data.week ? formatResetTime(data.week.resetsAt) : 'N/A'}
              </span>
            </div>
          </div>
          <div className="w-full h-3 bg-black rounded-full overflow-hidden border border-gray-800" style={{ width: '100%', height: 12, background: 'var(--bg)', borderRadius: 999, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <div 
              className="h-full rounded-full transition-all duration-1000 ease-out" 
              style={{ 
                height: '100%',
                borderRadius: 999,
                transition: 'all 1s ease-out',
                width: `${Math.min(100, data.week?.utilization || 0)}%`,
                backgroundColor: color,
                boxShadow: `0 0 10px ${color}80`
              }} 
            />
          </div>
        </div>
      </div>
      
      <div className="mt-6 text-xs text-gray-600 text-right" style={{ marginTop: 24, fontSize: 11, color: 'var(--text-3)', textAlign: 'right' }}>
        Last updated: {new Date(data.updatedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

export default function UsagePanel() {
  const [usage, setUsage] = useState<AllUsage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsage = () => {
      fetch('/api/usage')
        .then(res => res.json())
        .then(data => {
          setUsage(data);
          setLoading(false);
        })
        .catch(err => {
          console.error('Failed to fetch usage', err);
          setLoading(false);
        });
    };

    fetchUsage();
    const interval = setInterval(fetchUsage, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="panel-h">
        <div className="panel-h-l">
          <h2>Usage & Quotas</h2>
          <span className="panel-sub">
            Monitor API limits across intelligence providers
          </span>
        </div>
      </div>
      
      <div className="scroll" style={{ flex: 1, padding: '24px', display: 'flex', flexDirection: 'column' }}>
        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
            Loading usage data...
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 24, maxWidth: 1000, margin: '0 auto', width: '100%' }}>
            <UsageCard 
              title="Claude (AgentCore)" 
              icon={claudeIcon} 
              data={usage?.claude || null} 
              color="var(--accent)" 
            />
            <UsageCard 
              title="Codex" 
              icon={codexIcon} 
              data={usage?.codex || null} 
              color="oklch(70% 0.12 300)" 
            />
          </div>
        )}
      </div>
    </div>
  );
}
