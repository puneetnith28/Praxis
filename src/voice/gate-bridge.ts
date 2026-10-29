/**
 * The voice Keeper's door to approval gates.
 *
 * This is the half of approve-by-voice that touches real state: finding the
 * gate an agent is actually waiting on, and resolving it through the same code
 * path the UI button uses. The half that decides whether an approval is allowed
 * at all is `ApprovalGuard`, and the two are kept apart deliberately — the
 * guard is pure and exhaustively tested, and this is the thin layer that hands
 * it the truth.
 *
 * It lived inside the `/ws/voice` connection closure in `server.ts`, where
 * nothing could reach it. Approving a gate by voice is the most dangerous thing
 * Conduit can do on a mishearing, so the code that does it should be the
 * easiest to test, not the hardest.
 */
import * as storage from '../storage.js';
import { resolveGate } from '../gate-resolve.js';
import { ApprovalGuard } from './approval-guard.js';
import type { GateBridge, GateFound, GateLookup } from './nova-tools.js';
import type { DaemonClient } from '../daemon/client.js';

/**
 * Build the bridge for one voice session.
 *
 * The guard is passed in rather than created here because the session also
 * feeds it the user's speech, and consent must be scoped to that one socket.
 */
export function createGateBridge(
  daemon: DaemonClient,
  broadcast: (msg: any) => void,
  guard: ApprovalGuard,
): GateBridge {
  /**
   * Find the gate an agent is waiting on, by spoken project and agent name.
   *
   * Names come from a speech recogniser, so exact matches are the exception.
   * Falls back through id, exact name, partial name — and, when there is only
   * one project, that one, because "approve Claude" should not need the project
   * named out loud when there is nothing to confuse it with.
   */
  const find = (projectRef: string, agentRef: string): GateLookup => {
    const wantP = projectRef.toLowerCase();
    const projects = storage.listProjects();
    const project = projects.find((x) => x.id === projectRef)
      || projects.find((x) => x.name.toLowerCase() === wantP)
      || projects.find((x) => x.name.toLowerCase().includes(wantP))
      || (projects.length === 1 ? projects[0] : undefined);
    if (!project) return { found: false, reason: `I cannot find a project called "${projectRef}".` };

    const wantA = agentRef.toLowerCase();
    const agents = storage.listAgents(project.id);
    const agent = agents.find((x) => x.id === agentRef)
      || agents.find((x) => x.name.toLowerCase() === wantA)
      || agents.find((x) => x.name.toLowerCase().includes(wantA));
    if (!agent) return { found: false, reason: `There is no agent called "${agentRef}" in ${project.name}.` };
    if (!agent.pendingGate) return { found: false, reason: `${agent.name} is not waiting on anything.` };

    return {
      found: true,
      gate: {
        projectId: project.id,
        agentId: agent.id,
        agentName: agent.name,
        prompt: agent.pendingGate.prompt,
        source: agent.pendingGate.source,
      },
    };
  };

  return {
    find,

    noteDescribed: (gate: GateFound) => guard.noteDescribed(gate),

    reject: (gate: GateFound) => {
      // Refusing is always safe, so it needs no ceremony.
      const r = resolveGate(daemon, broadcast, gate.projectId, gate.agentId, 'reject', {
        via: 'voice',
      });
      guard.clear(gate.agentId);
      return r.ok
        ? { ok: true, message: `Rejected. ${gate.agentName} has been told to stop.` }
        : { ok: false, message: r.error };
    },

    approve: (gate: GateFound) => {
      // Re-read the gate at this instant. One of the four conditions is "still
      // open and unchanged", and the agent may have moved on since it was
      // described — checking the snapshot we were handed would check nothing.
      const now = find(gate.projectId, gate.agentId);
      const verdict = guard.authorize(gate.agentId, now.found ? now.gate : null);
      if (!verdict.ok) return { ok: false, message: verdict.reason };

      const r = resolveGate(daemon, broadcast, gate.projectId, gate.agentId, 'approve', {
        via: 'voice',
        authorisingPhrase: verdict.phrase,
      });
      guard.clear(gate.agentId);
      return r.ok
        ? { ok: true, message: `Approved. ${gate.agentName} is carrying on.` }
        : { ok: false, message: r.error };
    },
  };
}
