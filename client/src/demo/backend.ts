/**
 * A Conduit backend that runs in the browser, for the hosted preview only.
 *
 * The preview had nothing behind it, so every tab was empty and the console
 * read as broken software rather than as a tool with no daemon attached. A
 * banner explaining that is honest but it is not a demonstration: someone
 * evaluating this should be able to open the terminals, read what the
 * Supervisor made of the output, resolve a gate, approve a plan, and see what
 * the wiki is for — without installing anything first.
 *
 * So this answers the same REST surface `client/src/api.ts` calls, over
 * in-memory fixtures, and drives a fake socket so the panes that stream have
 * something to stream. It is a stand-in, not a simulation: no process is
 * running, no model is called, and the interface says so in its banner. What is
 * real is the interface itself — every screen here is the screen you get
 * locally, with the same components reading the same shapes.
 *
 * Off entirely unless STATIC_PREVIEW. Nothing in this directory is reachable
 * from a real install.
 *
 * State lives for the life of the tab. Reload and the sample project is back as
 * it was, which is the right behaviour for something a stranger is clicking
 * through.
 */
import type {
  ActivityEvent, Agent, GroupChatMsg, Plan, Project, SharedContent,
} from '../api';
import * as F from './fixtures';

type Frame = { type: string } & Record<string, unknown>;
type Listener = (msg: Frame) => void;

const listeners = new Set<Listener>();
/** Push a frame at whatever is standing in for the socket. */
function emit(msg: Frame) { for (const l of [...listeners]) l(msg); }

const uid = () => Math.random().toString(36).slice(2, 10);
const iso = () => new Date().toISOString();

const state = {
  projects: [F.PROJECT] as Project[],
  agents: F.AGENTS.map((a) => ({ ...a })) as Agent[],
  plans: [] as Plan[],   // arrives on the timeline — see createDemoSocket
  chat: F.GROUP_CHAT.map((m) => ({ ...m })) as GroupChatMsg[],
  activity: F.ACTIVITY.map((e) => ({ ...e })) as ActivityEvent[],
  content: F.CONTENT.map((c) => ({ ...c })) as SharedContent[],
  wiki: F.WIKI.map((w) => ({ ...w })) as SharedContent[],
  wikiReady: true,
  autoApproveRoutine: true,
  /** Appended to per agent, so a terminal that is re-attached replays. */
  terminal: Object.fromEntries(
    Object.entries(F.TRANSCRIPTS).map(([id, lines]) => [id, lines.join('\r\n') + '\r\n']),
  ) as Record<string, string>,
};

function note(agentId: string, event: string, detail: string) {
  const agent = state.agents.find((a) => a.id === agentId);
  const e: ActivityEvent = {
    id: uid(), projectId: F.PROJECT.id, agentId,
    agentName: agent?.name, event, detail, timestamp: iso(),
  };
  state.activity = [e, ...state.activity];
  emit({ type: 'activity', event: e as unknown as Record<string, unknown> });
}

function say(text: string, classification?: GroupChatMsg['classification']) {
  const m: GroupChatMsg = {
    id: uid(), ts: iso(), role: 'supervisor', sender: 'Supervisor', text, classification,
  };
  state.chat = [...state.chat, m];
  emit({ type: 'groupchat:message', projectId: F.PROJECT.id, message: m as unknown as Record<string, unknown> });
}

function write(agentId: string, text: string) {
  state.terminal[agentId] = (state.terminal[agentId] || '') + text;
  emit({ type: 'terminal:output', agentId, data: text });
}

function setStatus(agentId: string, status: Agent['status']) {
  const a = state.agents.find((x) => x.id === agentId);
  if (!a) return;
  a.status = status;
  emit({ type: 'agent:status', agentId, status, projectId: F.PROJECT.id });
}

// ── REST ──────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const noContent = () => new Response(null, { status: 204 });

/**
 * Answer one request against the fixtures.
 *
 * `path` is everything after `/api`, query string included.
 */
export function demoApi(path: string, init?: RequestInit): Response {
  const method = (init?.method || 'GET').toUpperCase();
  const [raw, query] = path.split('?');
  const seg = raw.split('/').filter(Boolean);
  const body = (() => {
    try { return init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}; }
    catch { return {} as Record<string, unknown>; }
  })();

  // /health
  if (seg[0] === 'health') {
    return json({
      ok: true, daemon: true, auth: false, supervisor: 'demo',
      bedrockModel: 'us.anthropic.claude-sonnet-5', region: 'us-east-1',
      supervisorHealth: { state: 'ok', provider: 'demo', model: 'sample data', strands: true },
    });
  }

  if (seg[0] === 'usage') return json(F.USAGE);
  if (seg[0] === 'codex' && seg[1] === 'models') return json({ models: ['gpt-5-codex', 'o4-mini'] });

  if (seg[0] === 'voice' && seg[1] === 'config') {
    // Must be the whole VoiceCfg shape: the hook replaces its defaults with
    // whatever comes back, and a half-shape took the console down with
    // "cannot read properties of undefined (reading 'provider')".
    return json({
      config: {
        engine: 'pipeline',
        stt: { provider: 'browser', model: '', language: 'en-US', saveRecordings: false },
        tts: { enabled: true, provider: 'browser', model: '', voice: '', speed: 1.0 },
      },
      providers: [
        { id: 'browser', name: 'Browser', stt: true, tts: true, needsKey: false },
        { id: 'groq', name: 'Groq', stt: true, tts: false, needsKey: true },
        { id: 'openai', name: 'OpenAI', stt: true, tts: true, needsKey: true },
        { id: 'gemini', name: 'Gemini', stt: true, tts: true, needsKey: true },
      ],
      keys: {},
    });
  }

  if (seg[0] === 'gate-settings') {
    if (method === 'PUT') { state.autoApproveRoutine = body.autoApproveRoutine !== false; return json({ ok: true }); }
    return json({ autoApproveRoutine: state.autoApproveRoutine });
  }

  if (seg[0] === 'brain') {
    return json({
      messages: [{ id: 'k1', role: 'assistant', text: F.KEEPER_GREETING, ts: iso() }],
      status: 'idle', engine: 'demo', currentId: 'demo-conversation',
      conversations: [{ id: 'demo-conversation', title: 'Orbit API', updatedAt: iso(), messageCount: 1 }],
    });
  }

  if (seg[0] === 'activity') {
    const pid = new URLSearchParams(query || '').get('projectId');
    return json(state.activity.filter((e) => !pid || e.projectId === pid));
  }

  // /projects…
  if (seg[0] === 'projects') {
    if (seg.length === 1) {
      if (method === 'POST') {
        const p: Project = {
          id: 'p-' + uid(),
          name: String(body.name || 'Untitled'),
          description: body.description ? String(body.description) : undefined,
          cwd: String(body.cwd || '~/code'),
          createdAt: iso(),
        };
        state.projects = [...state.projects, p];
        emit({ type: 'org:changed' });
        return json(p);
      }
      return json(state.projects);
    }

    const pid = seg[1];
    const project = state.projects.find((p) => p.id === pid);

    if (seg.length === 2) {
      if (method === 'PUT' && project) {
        Object.assign(project, {
          name: body.name ?? project.name,
          description: body.description ?? project.description,
          cwd: body.cwd ?? project.cwd,
        });
        emit({ type: 'org:changed' });
        return json(project);
      }
      if (method === 'DELETE') {
        state.projects = state.projects.filter((p) => p.id !== pid);
        state.agents = state.agents.filter((a) => a.projectId !== pid);
        emit({ type: 'org:changed' });
        return noContent();
      }
      return project ? json(project) : json({ error: 'no such project' }, 404);
    }

    // /projects/:id/agents…
    if (seg[2] === 'agents') {
      if (seg.length === 3) {
        if (method === 'POST') {
          const a: Agent = {
            id: 'a-' + uid(), projectId: pid,
            name: String(body.name || 'Agent'),
            role: body.role ? String(body.role) : undefined,
            cli: (body.cli || 'claude') as Agent['cli'],
            cwd: String(body.cwd || project?.cwd || '~/code'),
            status: 'stopped',
          };
          state.agents = [...state.agents, a];
          state.terminal[a.id] = `\x1b[2m[bedrock] ${a.name} is stopped. Press Start to run it.\x1b[0m\r\n`;
          note(a.id, 'agent_created', a.cli);
          emit({ type: 'org:changed' });
          return json(a);
        }
        return json(state.agents.filter((a) => a.projectId === pid));
      }

      const aid = seg[3];
      const agent = state.agents.find((a) => a.id === aid);

      if (seg.length === 4 && method === 'DELETE') {
        state.agents = state.agents.filter((a) => a.id !== aid);
        emit({ type: 'org:changed' });
        return noContent();
      }

      if (!agent) return json({ error: 'no such agent' }, 404);

      if (seg[4] === 'start' || seg[4] === 'restart') {
        setStatus(aid, 'running');
        write(aid, `\r\n\x1b[2m[bedrock] started ${agent.name} (${agent.cli})\x1b[0m\r\n`);
        note(aid, 'agent_started', agent.cli);
        emit({ type: 'org:changed' });
        return json({ status: 'running' });
      }
      if (seg[4] === 'stop') {
        setStatus(aid, 'stopped');
        write(aid, `\r\n\x1b[2m[bedrock] stopped ${agent.name}\x1b[0m\r\n`);
        note(aid, 'agent_stopped', agent.cli);
        emit({ type: 'org:changed' });
        return json({ status: 'stopped' });
      }

      if (seg[4] === 'gate' && seg[5] === 'resolve') {
        const decision = String(body.decision || 'approve');
        const gate = agent.pendingGate;
        delete agent.pendingGate;
        emit({ type: 'gate:resolved', agentId: aid, projectId: pid, decision });
        if (decision === 'reject') {
          write(aid, '\r\n\x1b[31m[bedrock] rejected — Esc sent, then "stop"\x1b[0m\r\n');
          say(`You rejected ${agent.name}'s ${gate ? 'force push' : 'request'}. It has been told to stop.`, 'progress');
          setStatus(aid, 'awaiting_input');
        } else if (decision === 'custom') {
          write(aid, `\r\n\x1b[36m[bedrock] sent: ${String(body.customInput || '')}\x1b[0m\r\n`);
          setStatus(aid, 'running');
        } else {
          write(aid, '\r\n\x1b[32m[bedrock] approved — keystrokes sent\x1b[0m\r\n');
          say(`You approved ${agent.name}'s request. It has resumed.`, 'progress');
          setStatus(aid, 'running');
        }
        note(aid, 'gate_resolved', `${decision}: ${gate?.prompt.split('\n')[0] || 'prompt'}`);
        emit({ type: 'org:changed' });
        return json({ success: true, action: decision });
      }
    }

    // /projects/:id/plans…
    if (seg[2] === 'plans') {
      if (seg.length === 3) return json(state.plans.filter((p) => p.projectId === pid));
      if (seg[4] === 'resolve') {
        const plan = state.plans.find((p) => p.id === seg[3]);
        const decision = String(body.decision || 'approve');
        state.plans = state.plans.filter((p) => p.id !== seg[3]);
        emit({ type: 'plan:resolved', planId: seg[3], decision });
        if (plan && decision === 'approve') {
          const target = state.agents.find(
            (a) => a.id === plan.targetAgent || a.name === plan.targetAgent);
          if (target) {
            setStatus(target.id, 'running');
            write(target.id, `\r\n\x1b[2m> ${plan.proposedMessage}\x1b[0m\r\n`);
            note(target.id, 'plan_approved', plan.description);
          }
          say(`Plan approved — the message was delivered to ${target?.name || 'the agent'}.`, 'progress');
        } else if (plan) {
          say('Plan rejected. The Supervisor will take the reason into account.', 'progress');
        }
        emit({ type: 'org:changed' });
        return json({ success: true, delivered: decision === 'approve' });
      }
    }

    // /projects/:id/groupchat
    if (seg[2] === 'groupchat') {
      if (method === 'POST') {
        const m: GroupChatMsg = {
          id: uid(), ts: iso(), role: 'user', sender: 'You', text: String(body.message || ''),
        };
        state.chat = [...state.chat, m];
        emit({ type: 'groupchat:message', projectId: pid, message: m as unknown as Record<string, unknown> });
        const live = state.agents.filter((a) => a.projectId === pid && a.status !== 'stopped');
        window.setTimeout(() => say(
          `Passed that to ${live.map((a) => a.name).join(', ') || 'nobody — every agent is stopped'}.`
          + ' In the hosted preview I answer from sample data; locally this reaches the real terminals.',
          'progress',
        ), 700);
        return json({ ...m, delivered: live.map((a) => a.name), skipped: [] });
      }
      return json({ messages: state.chat.filter((m) => !m.projectId || m.projectId === pid) });
    }

    // /projects/:id/messages  (agent → agent, the MCP path)
    if (seg[2] === 'messages' && method === 'POST') {
      const to = state.agents.find((a) => a.id === body.target || a.name === body.target);
      note(String(body.fromAgentId || ''), 'message_sent', `to ${to?.name || body.target}`);
      const e = state.activity[0];
      if (e) { e.fromAgent = String(body.fromAgentName || ''); e.toAgent = to?.name; e.message = String(body.message || ''); }
      return json({ delivered: true, toAgentName: to?.name || String(body.target || '') });
    }

    // /projects/:id/content…
    if (seg[2] === 'content') {
      if (seg.length === 3) {
        if (method === 'POST') {
          const c: SharedContent = {
            id: uid(), projectId: pid, filename: String(body.filename || 'untitled.md'),
            content: String(body.content || ''), createdBy: String(body.createdBy || 'You'), updatedAt: iso(),
          };
          state.content = [...state.content, c];
          emit({ type: 'content:updated', projectId: pid });
          return json(c);
        }
        return json(state.content.filter((c) => c.projectId === pid));
      }
      const name = decodeURIComponent(seg[3]);
      const file = state.content.find((c) => c.projectId === pid && c.filename === name);
      if (method === 'PUT' && file) {
        file.content = String(body.content ?? '');
        file.updatedAt = iso();
        emit({ type: 'content:updated', projectId: pid });
        return json(file);
      }
      if (method === 'DELETE') {
        state.content = state.content.filter((c) => !(c.projectId === pid && c.filename === name));
        emit({ type: 'content:updated', projectId: pid });
        return noContent();
      }
      return file ? json(file) : json({ error: 'no such file' }, 404);
    }

    // /projects/:id/wiki…
    if (seg[2] === 'wiki') {
      if (seg[3] === 'status') return json({ initialized: state.wikiReady });
      if (seg[3] === 'initialize') { state.wikiReady = true; return json({ initialized: true }); }
      if (seg.length === 3) return json(state.wiki.filter((w) => w.projectId === pid));
      const name = decodeURIComponent(seg[3]);
      const file = state.wiki.find((w) => w.projectId === pid && w.filename === name);
      if (method === 'PUT' && file) {
        file.content = String(body.content ?? '');
        file.updatedAt = iso();
        emit({ type: 'content:updated', projectId: pid });
        return json(file);
      }
      return file ? json(file) : json({ error: 'no such page' }, 404);
    }
  }

  return json({ error: `${method} /api${raw} is not part of the hosted preview` }, 501);
}

// ── the socket ────────────────────────────────────────────────────────

let timeline: ReturnType<typeof setTimeout>[] = [];

/**
 * Stand in for the daemon's socket.
 *
 * Terminals ask to attach and expect output to arrive; the Keeper expects its
 * replies as events. Answering those is what separates a screenshot from
 * something you can click.
 */
export function createDemoSocket(dispatch: Listener) {
  listeners.add(dispatch);

  const at = (ms: number, fn: () => void) => { timeline.push(setTimeout(fn, ms)); };

  at(0, () => { dispatch({ type: 'hello', daemon: true }); dispatch({ type: 'ws:open' }); });

  // Luna is "running", so her pane keeps producing. Slow enough to read.
  F.LIVE_LINES.forEach((line, i) => {
    at(6000 + i * 1400, () => {
      if (state.agents.find((a) => a.id === 'a-luna')?.status === 'running') write('a-luna', line + '\r\n');
    });
  });
  at(6000 + F.LIVE_LINES.length * 1400 + 500, () => {
    say('Luna added the `limit=0` test Atlas asked for. 42 passing.', 'progress');
  });

  // A destructive command appears, is matched, and the agent is held. That
  // is the thesis of the whole project, so it is better watched than found
  // already sitting behind a modal.
  at(11_000, () => { write(F.GATE.agentId, F.GATE.line + '\r\n'); });
  at(12_400, () => {
    const a = state.agents.find((x) => x.id === F.GATE.agentId);
    if (a) a.pendingGate = { prompt: F.GATE.prompt, source: 'regex' };
    write(F.GATE.agentId, '\r\n\x1b[33m[bedrock] held — waiting on a human decision\x1b[0m\r\n');
    say('Sable is attempting `git push --force origin main`. It has been stopped and is waiting for you.', 'risky_action');
    emit({ type: 'gate:triggered', projectId: F.PROJECT.id, agentId: F.GATE.agentId,
      prompt: F.GATE.prompt, source: 'regex' });
  });

  // Then the Supervisor proposes something, which is the part worth watching:
  // it cannot send this itself, so it becomes a modal asking you.
  at(24_000, () => {
    const plan = { ...F.PLANS[0], createdAt: new Date().toISOString() };
    state.plans = [...state.plans, plan];
    say('Nova is missing the new error codes. I have proposed a message — it needs your approval.', 'question');
    emit({ type: 'plan:created', plan: plan as unknown as Record<string, unknown> });
  });

  const send = (msg: object): boolean => {
    const m = msg as Frame;

    if (m.type === 'terminal:attach') {
      const codexId = String(m.agentId);
      if (state.agents.find((a) => a.id === codexId)?.cli === 'codex') {
        // A Codex pane wants items, not bytes. Stagger them so the thread
        // reads as one that ran, rather than appearing all at once.
        F.CODEX_ITEMS.forEach((item, i) => setTimeout(
          () => dispatch({ type: 'codex:item', agentId: codexId, item: item as unknown as Record<string, unknown> }),
          60 + i * 120,
        ));
        return true;
      }

      const id = String(m.agentId);
      const replay = state.terminal[id];
      // Next tick: the pane subscribes immediately after it sends this.
      setTimeout(() => dispatch({ type: 'terminal:output', agentId: id, data: replay || '' }), 30);
      return true;
    }

    if (m.type === 'terminal:input') {
      // Echo, so typing feels connected — but say plainly that nothing runs.
      const id = String(m.agentId);
      const data = String(m.data ?? '');
      if (data === '\r') {
        write(id, '\r\n\x1b[33m[bedrock] this is the hosted preview — no process is attached to this terminal.\x1b[0m\r\n');
      } else {
        write(id, data);
      }
      return true;
    }

    if (m.type === 'brain:send') {
      const text = String(m.message ?? '');
      dispatch({ type: 'brain:event', payload: { kind: 'append', conversationId: 'demo-conversation',
        message: { id: uid(), role: 'user', text, ts: iso() } } });
      dispatch({ type: 'brain:event', payload: { kind: 'status', status: 'thinking' } });
      setTimeout(() => {
        dispatch({ type: 'brain:event', payload: { kind: 'append', conversationId: 'demo-conversation',
          message: {
            id: uid(), role: 'assistant', ts: iso(),
            text: 'In the hosted preview I answer from sample data, so I cannot actually reach an agent. '
              + 'Running Bedrock locally gives The Keeper its twelve tools — starting and stopping agents, '
              + 'asking them questions, reading the wiki and the shared folder, and proposing plans for you to approve.',
          } } });
        dispatch({ type: 'brain:event', payload: { kind: 'status', status: 'idle' } });
      }, 900);
      return true;
    }

    return true;   // resize / detach / ping — nothing to do
  };

  const stop = () => {
    listeners.delete(dispatch);
    for (const t of timeline) clearTimeout(t);
    timeline = [];
  };

  return { send, stop };
}
