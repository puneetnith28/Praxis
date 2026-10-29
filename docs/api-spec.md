# Praxis API & WebSocket Specification

## REST Endpoints
- `GET /api/projects`: List active projects.
- `POST /api/projects`: Create or clone project.
- `GET /api/agents`: Retrieve all agent runtime states.
- `POST /api/agents/start`: Spawn agent PTY or Codex session.
- `POST /api/agents/stop`: Terminate agent process tree.

## WebSocket Frames
- `terminal_input`: Inbound keystrokes `{ type: 'terminal_input', agentId, data }`.
- `terminal_output`: Outbound terminal chunks `{ type: 'terminal_output', agentId, data }`.
- `keeper_progress`: Supervisor reasoning events `{ type: 'keeper_progress', threadId, step, message }`.
