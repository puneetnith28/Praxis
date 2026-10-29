# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Comprehensive Phase 3 contributor experience and release documentation.
- Unified `npm run check:all` quality gate aggregating all CI checks locally.
- Explicit release checklist and procedure guide (`docs/release-procedure.md`).

---

## [1.0.0] - Initial Release (Pending Tag)

### Added
- **Multi-Agent Orchestration**: Unified management for Claude Code, OpenAI Codex (`app-server`), Gemini CLI, and LocalHarness agents.
- **Dual-Layer Approval Gates**: Zero-latency in-process regex interceptors paired with AWS Strands supervisory activity classification.
- **Process Decoupling**: Persistent background daemon (`:3210`) isolates agent execution from web server (`:3200`) and browser restarts.
- **LocalHarness Integration**: 100% offline agent operation with local model servers (Ollama, LM Studio, vLLM) via Agent Client Protocol (ACP).
- **Interactive PTY Multiplexer**: Native pseudo-terminals with configurable layouts (1-Up, 2-Up, 3-Up, Tmux grid, and draggable Canvas).
- **Inter-Agent Communication**: Model Context Protocol (MCP) servers enabling agents to message teammates directly.
- **Project Knowledge & Skills**: Shared project workspace, persistent Markdown Wiki, and automatic `SKILL.md` skill discovery.
- **Hands-Free Voice Control**: Voice HUD integration with Amazon Nova 2 Sonic audio streaming and server-validated approval guards.
- **Open-Source CI/CD Infrastructure**:
  - Primary CI pipeline running lint, format, type checks, 50 automated test suites, and production builds on Node.js 22.
  - CodeQL static application security testing (SAST) for JavaScript and TypeScript.
  - Automated dependency review blocking vulnerable dependencies and copyleft license contamination.
  - Automated markdown documentation link validation.
  - Multi-OS Electron desktop packaging workflow for Linux (AppImage, deb), macOS (dmg, zip), and Windows (nsis, zip).
  - Issue forms for bug reports and feature requests.
  - Security policy (`SECURITY.md`) and Contributor Covenant 2.1 Code of Conduct (`CODE_OF_CONDUCT.md`).
