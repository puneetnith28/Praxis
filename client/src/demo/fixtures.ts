/**
 * The sample project the hosted preview runs on.
 *
 * Everything here is invented, and it is meant to look like a session someone
 * actually ran: agents in different states, a Supervisor that has classified
 * real-looking output, a gate already waiting, a plan awaiting approval. An
 * empty console demonstrates nothing, and a console full of lorem ipsum
 * demonstrates less.
 */
import type { Agent, ActivityEvent, GroupChatMsg, Plan, Project, SharedContent } from '../api';

const now = Date.now();
/** Minutes ago, as an ISO string. */
const ago = (m: number) => new Date(now - m * 60_000).toISOString();

export const PROJECT: Project = {
  id: 'demo-orbit',
  name: 'Orbit API',
  description: 'A small REST service the agents are working on together.',
  cwd: '~/code/orbit-api',
  createdAt: ago(240),
};

export const AGENTS: Agent[] = [
  {
    id: 'a-luna', projectId: PROJECT.id, name: 'Luna', role: 'Implements features',
    cli: 'claude', cwd: PROJECT.cwd, status: 'running', pid: 24118,
  },
  {
    id: 'a-atlas', projectId: PROJECT.id, name: 'Atlas', role: 'Reviews and tests',
    cli: 'codex', cwd: PROJECT.cwd, status: 'awaiting_input', pid: 24119,
  },
  {
    id: 'a-nova', projectId: PROJECT.id, name: 'Nova', role: 'Writes documentation',
    cli: 'gemini', cwd: PROJECT.cwd, status: 'idle', pid: 24120,
  },
  {
    id: 'a-sable', projectId: PROJECT.id, name: 'Sable', role: 'Cleans up migrations',
    cli: 'gpt', cwd: PROJECT.cwd, status: 'running', pid: 24121,
  },
  {
    id: 'a-rover', projectId: PROJECT.id, name: 'Rover', role: 'Spare capacity',
    cli: 'opencode', cwd: PROJECT.cwd, status: 'stopped',
  },
];

export const PLANS: Plan[] = [{
  id: 'plan-1',
  projectId: PROJECT.id,
  description: 'Nova has the endpoint list but not the new error codes Luna added.',
  targetAgent: 'Nova',   // the modal shows this verbatim, so use the name
  targetProject: PROJECT.id,
  proposedMessage: 'Luna added 409 and 422 responses to POST /orbits in the last commit. Update docs/api.md to cover both, with an example body for each.',
  createdAt: ago(3),
}];

export const GROUP_CHAT: GroupChatMsg[] = [
  { id: 'g1', ts: ago(41), role: 'user', sender: 'You', text: 'Luna, add pagination to GET /orbits. Atlas, review it when she pushes.' },
  { id: 'g2', ts: ago(38), role: 'supervisor', sender: 'Supervisor', classification: 'progress',
    text: 'Luna added `limit` and `cursor` to GET /orbits and updated the handler. Tests not run yet.' },
  { id: 'g3', ts: ago(31), role: 'supervisor', sender: 'Supervisor', classification: 'question',
    text: 'Atlas is asking whether the cursor should be opaque or a raw row id. It is waiting on an answer.' },
  { id: 'g4', ts: ago(29), role: 'user', sender: 'You', text: 'Opaque. Base64 the row id so we can change it later.' },
  { id: 'g5', ts: ago(22), role: 'supervisor', sender: 'Supervisor', classification: 'progress',
    text: 'Atlas confirmed the opaque cursor and re-ran the suite: 41 passed, 0 failed.' },
  { id: 'g6', ts: ago(9), role: 'supervisor', sender: 'Supervisor', classification: 'blocker',
    text: 'Sable cannot run the migration — DATABASE_URL is unset in its environment.' },
];

export const ACTIVITY: ActivityEvent[] = [
  { id: 'e1', projectId: PROJECT.id, agentId: 'a-luna', agentName: 'Luna', event: 'agent_started', detail: 'claude', timestamp: ago(44) },
  { id: 'e2', projectId: PROJECT.id, agentId: 'a-atlas', agentName: 'Atlas', event: 'agent_started', detail: 'codex', timestamp: ago(44) },
  { id: 'e3', projectId: PROJECT.id, agentId: 'a-luna', agentName: 'Luna', event: 'message_sent', detail: 'to Atlas',
    fromAgent: 'Luna', toAgent: 'Atlas', message: 'Pagination is on branch feat/paging — can you review?', timestamp: ago(33) },
  { id: 'e4', projectId: PROJECT.id, agentId: 'a-atlas', agentName: 'Atlas', event: 'gate_resolved', detail: 'approved: run the test suite', timestamp: ago(24) },
  { id: 'e5', projectId: PROJECT.id, agentId: 'a-nova', agentName: 'Nova', event: 'wiki_updated', detail: 'endpoints.md', timestamp: ago(15) },
  { id: 'e6', projectId: PROJECT.id, agentId: 'a-sable', agentName: 'Sable', event: 'agent_started', detail: 'gpt', timestamp: ago(12) },
];

export const CONTENT: SharedContent[] = [
  {
    id: 'c1', projectId: PROJECT.id, filename: 'pagination-contract.md', createdBy: 'Luna', updatedAt: ago(30),
    content: [
      '# Pagination contract',
      '',
      '`GET /orbits?limit=&cursor=`',
      '',
      '- `limit` — 1..100, default 25',
      '- `cursor` — opaque, base64 of the last row id',
      '- response carries `next_cursor`, absent on the last page',
      '',
      'Atlas: the cursor is deliberately opaque so the underlying key can change.',
    ].join('\n'),
  },
  {
    id: 'c2', projectId: PROJECT.id, filename: 'review-notes.md', createdBy: 'Atlas', updatedAt: ago(20),
    content: [
      '# Review notes',
      '',
      '- handler looks right; `limit` is clamped, good',
      '- missing: a test for `limit=0`',
      '- missing: `next_cursor` should be absent, not null, on the last page',
    ].join('\n'),
  },
];

export const WIKI: SharedContent[] = [
  {
    id: 'w1', projectId: PROJECT.id, filename: 'overview.md', createdBy: 'Nova', updatedAt: ago(120),
    content: [
      '# Orbit API',
      '',
      'A REST service for scheduling satellite passes. Three tables, one worker,',
      'no framework beyond Express.',
      '',
      'The agents share this wiki as long-term memory: it survives restarts and',
      'every agent can read it.',
    ].join('\n'),
  },
  {
    id: 'w2', projectId: PROJECT.id, filename: 'endpoints.md', createdBy: 'Nova', updatedAt: ago(15),
    content: [
      '# Endpoints',
      '',
      '| Method | Path | Notes |',
      '| --- | --- | --- |',
      '| GET | /orbits | paginated, see the shared contract |',
      '| POST | /orbits | 409 on overlap, 422 on a bad window |',
      '| GET | /orbits/:id | |',
      '| DELETE | /orbits/:id | soft delete |',
    ].join('\n'),
  },
  {
    id: 'w3', projectId: PROJECT.id, filename: 'conventions.md', createdBy: 'Luna', updatedAt: ago(60),
    content: [
      '# Conventions',
      '',
      '- migrations are forward-only',
      '- no force pushes to `main` — history is shared',
      '- every endpoint gets a test before it gets documentation',
    ].join('\n'),
  },
];

export const USAGE = {
  claude: {
    session: { utilization: 41, resetsAt: new Date(now + 92 * 60_000).toISOString() },
    week: { utilization: 63, resetsAt: new Date(now + 3.1 * 86_400_000).toISOString() },
  },
  codex: {
    session: { utilization: 18, resetsAt: new Date(now + 140 * 60_000).toISOString() },
    week: { utilization: 27, resetsAt: new Date(now + 4.4 * 86_400_000).toISOString() },
  },
};

/**
 * What each agent's terminal has printed so far.
 *
 * Written as a real session rather than filler: the point of the Terminals tab
 * is that these are actual processes, and a pane of placeholder text would say
 * the opposite.
 */
export const TRANSCRIPTS: Record<string, string[]> = {
  'a-luna': [
    '\x1b[38;5;208m✻\x1b[0m Claude Code v2.0.14',
    '  cwd: ~/code/orbit-api',
    '',
    '\x1b[2m> add pagination to GET /orbits\x1b[0m',
    '',
    '\x1b[36m⏺\x1b[0m Read src/routes/orbits.ts (118 lines)',
    '\x1b[36m⏺\x1b[0m Read src/db/queries.ts (64 lines)',
    '\x1b[36m⏺\x1b[0m Update src/routes/orbits.ts',
    '    \x1b[32m+ const limit = Math.min(Number(req.query.limit) || 25, 100);\x1b[0m',
    '    \x1b[32m+ const cursor = decodeCursor(req.query.cursor);\x1b[0m',
    '\x1b[36m⏺\x1b[0m Update src/db/queries.ts',
    '    \x1b[32m+ export function pageOrbits(limit: number, after?: number) {\x1b[0m',
    '',
    'Pagination is in. `limit` is clamped to 100 and the cursor is opaque —',
    'base64 of the last row id, so the underlying key can change later.',
    '',
    '\x1b[36m⏺\x1b[0m message_agent(Atlas) — "Pagination is on feat/paging, can you review?"',
    '',
  ],
  'a-atlas': [
    '\x1b[38;5;39mcodex\x1b[0m  app-server thread 7f3a1c',
    '  cwd: ~/code/orbit-api',
    '',
    '\x1b[2m> review the pagination branch and run the tests\x1b[0m',
    '',
    '\x1b[36m▸\x1b[0m git diff main..feat/paging --stat',
    '    src/routes/orbits.ts   | 14 ++++++++---',
    '    src/db/queries.ts      | 22 +++++++++++++++',
    '    tests/orbits.test.ts   |  9 +++++++',
    '',
    '\x1b[36m▸\x1b[0m npm test',
    '    \x1b[32m✓\x1b[0m 41 passed  \x1b[2m(2.8s)\x1b[0m',
    '',
    'The handler is correct and `limit` is clamped. Two things missing:',
    'a test for `limit=0`, and `next_cursor` should be absent rather than',
    'null on the last page.',
    '',
    '\x1b[2mWaiting for your next instruction.\x1b[0m',
    '',
  ],
  'a-nova': [
    '\x1b[38;5;33mGemini CLI\x1b[0m',
    '  cwd: ~/code/orbit-api',
    '',
    '\x1b[2m> document the endpoints in the wiki\x1b[0m',
    '',
    '\x1b[36m›\x1b[0m read_wiki(endpoints.md)',
    '\x1b[36m›\x1b[0m write endpoints.md — 4 endpoints, one table',
    '',
    'Done. The table covers GET/POST/GET :id/DELETE :id.',
    '',
    '\x1b[2mIdle — nothing queued.\x1b[0m',
    '',
  ],
  'a-sable': [
    '\x1b[38;5;70maider\x1b[0m  gpt-oss-120b on Groq',
    '  cwd: ~/code/orbit-api',
    '',
    '\x1b[2m> squash the migrations and push the cleanup\x1b[0m',
    '',
    '\x1b[36m›\x1b[0m Applied edit to migrations/0007_squash.sql',
    '\x1b[36m›\x1b[0m Applied edit to migrations/README.md',
    '',
    '',
  ],
  'a-rover': [
    '\x1b[2m[bedrock] Rover is stopped. Press Start to run it.\x1b[0m',
    '',
  ],
};

/** Lines that keep arriving in Luna's pane, so a running agent looks running. */
export const LIVE_LINES: string[] = [
  '\x1b[36m⏺\x1b[0m Read tests/orbits.test.ts (74 lines)',
  '\x1b[36m⏺\x1b[0m Update tests/orbits.test.ts',
  '    \x1b[32m+ it("rejects limit=0", async () => {\x1b[0m',
  '\x1b[36m⏺\x1b[0m Bash(npm test -- orbits)',
  '    \x1b[32m✓\x1b[0m 42 passed  \x1b[2m(3.1s)\x1b[0m',
  '',
  'Added the `limit=0` case Atlas asked for. 42 passing.',
  '',
];

export const KEEPER_GREETING =
  'I can see one project, **Orbit API**, with five agents. Luna is working, '
  + 'Atlas is waiting on you, and Sable is held at a gate — it tried to force-push '
  + '`main`.\n\nThis is the hosted preview, so I am answering from sample data '
  + 'rather than a live daemon. Running Bedrock locally gives me the real thing: '
  + 'starting and stopping agents, asking them questions, and reading the wiki.';

/** The gate the preview raises a few seconds in, so it is watched, not found. */
export const GATE = {
  agentId: 'a-sable',
  line: '\x1b[31m›\x1b[0m Running: git push --force origin main',
  prompt: 'Sable wants to run:\n\n  git push --force origin main\n\nThis rewrites history on the shared branch.',
};

/** Atlas is a Codex agent: its pane renders structured items, not raw output. */
export const CODEX_ITEMS = [
  { id: 'i1', kind: 'message', role: 'user', text: 'review the pagination branch and run the tests' },
  { id: 'i2', kind: 'reasoning', text: 'Read the diff first, then run the suite rather than guessing from the patch.' },
  { id: 'i3', kind: 'command', command: 'git diff main..feat/paging --stat', status: 'done', exitCode: 0,
    output: ' src/routes/orbits.ts   | 14 ++++++++---\n src/db/queries.ts      | 22 +++++++++++++++\n tests/orbits.test.ts   |  9 +++++++' },
  { id: 'i4', kind: 'command', command: 'npm test', status: 'done', exitCode: 0,
    output: '  41 passing (2.8s)' },
  { id: 'i5', kind: 'message', role: 'agent',
    text: 'The handler is correct and `limit` is clamped. Two things missing: a test for `limit=0`, and `next_cursor` should be absent rather than null on the last page.' },
];
