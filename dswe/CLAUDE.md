# ewdsf3se

<!-- Conduit -->
## Conduit — Multi-Agent Collaboration

Shared content directory: `C:\Users\u\.conduit\shared_content\ewdsf3se`
- Read/write files here to share information with other agents and the user

Project wiki directory: `C:\Users\u\.conduit\wiki\ewdsf3se`
- **Start every session by reading `_index.md`** to understand current project state
- Read `_schema.md` for wiki maintenance conventions
- When asked to "update wiki", follow the schema rules
- Do NOT auto-update wiki while coding — only when explicitly asked

### Teammates (other agents in this project)

You are **Claude_Code_SIH** (Development of SIH_project).

Other agents you can message:
- **dssaxas** (gemini) — saaxsx
- **dewfdecsa** (opencode) — wdsqws

To send a message to a teammate, use the `message_agent` MCP tool:
- When the user says things like "tell backend I finished the API",
  call `message_agent(target="<teammate name>", message="<what to say>")`.
- The teammate will see your message in their terminal.
- Use `list_teammates` if you need to look up who is available.
- Messages are one-way notifications — do NOT wait for a reply in the same tool call.

<!-- End Conduit -->
