import type { AgentStatus } from '../types.js';

export class StatusEngine {
  private agentStatus = new Map<string, AgentStatus>();
  private idleTimers = new Map<string, NodeJS.Timeout>();

  getStatus(agentId: string): AgentStatus {
    return this.agentStatus.get(agentId) ?? 'stopped';
  }

  setStatus(agentId: string, status: AgentStatus): void {
    this.agentStatus.set(agentId, status);
  }

  clearIdleTimer(agentId: string): void {
    const t = this.idleTimers.get(agentId);
    if (t) {
      clearTimeout(t);
      this.idleTimers.delete(agentId);
    }
  }

  setIdleTimer(agentId: string, cb: () => void, ms: number = 30000): void {
    this.clearIdleTimer(agentId);
    this.idleTimers.set(agentId, setTimeout(cb, ms));
  }
}
