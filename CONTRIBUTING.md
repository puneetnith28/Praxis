# Contributing to Praxis

Thank you for your interest in contributing to **Praxis**! Praxis is an open-source, local-first foundation for persistent, secure, and verifiable AI agent execution.

We welcome contributions from developers, researchers, technical writers, and designers. This guide outlines everything you need to get your development environment running, test your code, and submit pull requests.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Prerequisites & Supported Runtimes](#prerequisites--supported-runtimes)
- [Getting Started: Local Setup](#getting-started-local-setup)
- [Running Praxis Locally](#running-praxis-locally)
- [Quality Gates & Verification Commands](#quality-gates--verification-commands)
- [Genuinely Useful First Contributions](#genuinely-useful-first-contributions)
- [Architectural & Security Invariants](#architectural--security-invariants)
- [Protecting Secrets & Local Data](#protecting-secrets--local-data)
- [Submitting Changes](#submitting-changes)
- [Continuous Integration (CI) Overview](#continuous-integration-ci-overview)
- [Where to Get Help & Report Issues](#where-to-get-help--report-issues)

---

## Code of Conduct

All contributors and maintainers are expected to adhere to our [Code of Conduct](CODE_OF_CONDUCT.md) (adapted from Contributor Covenant v2.1). Please read it to understand our community standards and reporting guidelines.

---

## Prerequisites & Supported Runtimes

Before setting up Praxis locally, verify that your machine has:

- **Node.js 22.0 or higher** (`node --version`):
  *Node.js 22.x is strictly required* because the automated test runner uses native `--experimental-strip-types` (introduced in Node.js 22.6+). On older Node versions (such as Node 20), test execution will fail.
- **npm** (`npm --version`): Version 10 or higher (bundled with Node.js 22).
- **Git** (`git --version`): Installed and available on your system `PATH`.
- **Supported Operating Systems**:
  - **Linux**: Ubuntu 22.04+ or equivalent modern distribution.
  - **macOS**: macOS 13 (Ventura) or newer (Apple Silicon and Intel).
  - **Windows**: Windows 11 / Windows 10 (WSL2 recommended for CLI agent tools; native PowerShell supported).
- **Python 3.10–3.12 with `uv` (Optional)**: Only needed if you plan to run local `aider` agents (GPT-OSS / Nemotron) or `LocalHarness` agents. Install `uv` via `curl -LsSf https://astral.sh/uv/install.sh | sh`.
- **C/C++ Build Tools (Optional)**: Needed only if prebuilt binaries for `node-pty` native bindings are unavailable on your platform (`build-essential` on Ubuntu, Xcode Command Line Tools on macOS).

---

## Getting Started: Local Setup

1. **Fork and Clone the Repository**:
   ```bash
   git clone https://github.com/puneetnith28/Praxis.git
   cd Praxis
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   # or for clean CI-like installation:
   npm ci
   ```
   > **Note on Peer Dependencies**: The repository includes a `.npmrc` file with `legacy-peer-deps=true` pre-configured to resolve dependencies between Express and model SDKs.

3. **Configure Environment (Optional)**:
   Praxis requires **zero API keys** to start and run basic local terminals:
   ```bash
   cp .env.example .env
   ```
   See [docs/environment.md](docs/environment.md) and [.env.example](.env.example) for documentation on optional cloud keys (Amazon Praxis, Anthropic, Groq, OpenRouter) and authentication settings (`CONDUIT_AUTH`).

---

## Running Praxis Locally

### Development Mode (with Hot Reloading)
Runs `tsup` in watch mode, the background Praxis daemon, the web server, and Vite dev server concurrently:
```bash
npm run dev
```
- **Vite Web Console**: [http://localhost:5173](http://localhost:5173)
- **Web API Server**: [http://localhost:3200](http://localhost:3200)
- **Daemon Socket**: `ws://127.0.0.1:3210`

### Production Mode
Builds all production bundles and launches both the daemon and web server:
```bash
npm run build
npm run start:all
```
Open [http://localhost:3200](http://localhost:3200) in your browser.

### Seeding Demo Data
To inspect an active multi-agent studio with sample agents and context:
```bash
npm run seed:demo
```

---

## Quality Gates & Verification Commands

All pull requests must pass our automated quality gates before merging. Contributors can run the complete quality pipeline locally with a single command:

```bash
npm run check:all
```

This runs the exact verification suite that CI enforces:

| Command | Purpose | What it validates |
|---|---|---|
| `npm run check:brand` | Brand & Convention Lint | Enforces consistent terminology and naming assertions. |
| `npm run lint` | Linting Check | Project linting rules. |
| `npm run format` | Formatting Check | Code formatting verification. |
| `npm run typecheck` | TypeScript Type Check | Runs `tsc --noEmit` across backend (`tsconfig.json`) and frontend (`client/tsconfig.json`). |
| `npm test` | Automated Test Suite | Executes all 50 test suites in `scripts/test-*.mjs` via Node 22 native type-stripping. |
| `npm run build` | Build Verification | Compiles server bundles (`tsup`) and client assets (`vite build`). |
| `npm run check:all` | Comprehensive Gate | Sequentially runs brand linting, lint, format, typecheck, tests, and build. |

---

## Genuinely Useful First Contributions

If you are looking for impactful ways to contribute to Praxis, here are concrete areas grounded in our active codebase:

1. **Expanding Agent CLI Integrations (`src/cli-registry.ts`)**:
   - Add configuration templates for emerging agent CLIs or alternative tool-calling agents.
   - Improve argument flags and environment mapping for local providers.

2. **Refining Safety Interceptors (`src/gate-policy.ts`)**:
   - Enhance the zero-latency regex interceptor library with additional patterns for dangerous operations (e.g. database schema drops, sensitive credential scraping, destructive package uninstalls).

3. **Authoring Reusable Domain Skills (`.praxis/skills/`)**:
   - Create focused `SKILL.md` instruction bundles that teach agents domain-specific workflows (e.g. Docker containerization, Prisma database migrations, Kubernetes deployments, Rust toolchains).

4. **UI & Keyboard Usability (`client/src/components/`)**:
   - Improve keyboard accessibility across the eight console views.
   - Refine terminal layout controls and theme customization options.

5. **Expanding Integration Tests (`scripts/`)**:
   - Add test coverage for edge-case gate decisions, WebSocket reconnect scenarios, or ACP protocol corner cases.

---

## Architectural & Security Invariants

When writing code in Praxis, preserve these core architectural invariants:

1. **State Mutation Requires Broadcast**:
   Any REST route or daemon method that mutates state must broadcast changes over WebSocket (`broadcast(...)`). Never add a route that modifies state silently.
2. **Single Gate Resolution Path**:
   Gate resolution has exactly one implementation: `src/gate-resolve.ts`. Both REST and voice paths share this function to prevent divergent safety logic.
3. **No Auto-Approval for ACP / LocalHarness Gates**:
   Local model permission requests (`source: 'acp'`) must never be auto-approved, and approvals must default to allow-once.
4. **Strict Path Containment**:
   Never concatenate untrusted user inputs with `path.join()`. Always use `storage.resolveInside()` or helper functions (`sharedDirFor()`, `wikiDirFor()`).
5. **DOMPurify Sanitization**:
   All markdown or raw text emitted by agents/models rendered in the React UI must pass through `renderMarkdown()` in `client/src/utils/md.ts`.
6. **Supervisor Bounded Authority**:
   The supervisor only produces *proposals*. It possesses zero direct write permissions to send unapproved instructions to agents.

---

## Protecting Secrets & Local Data

Praxis executes agents with authentic filesystem access. Maintain strict safety when working locally:

- **Never Commit Secrets**: Do not commit API keys, `.env` files, SSH keys, or cloud credentials.
- **Gitignore Protection**: The repository `.gitignore` automatically excludes `.env`, `node_modules/`, `dist/`, `dist-desktop/`, and `.vite/`.
- **Local Credentials File**: Sensitive API keys configured through the web UI are stored on your local filesystem at `~/.conduit/api-keys.json` with restricted permissions (`0600`) and are never sent over WebSocket client streams.
- **Sanitize Contributions**: Before opening a pull request, run `git diff` to confirm no personal paths, machine usernames, or tokens are included in logs, tests, or documentation.

---

## Submitting Changes

### 1. Branching Strategy
Create a descriptive branch for your work:
- `feat/<feature-name>`: New capabilities, UI views, or provider integrations.
- `fix/<bug-name>`: Bug fixes and edge-case handling.
- `chore/<task-name>`: Build tooling, dependencies, or maintenance.
- `docs/<topic>`: Documentation enhancements.

### 2. Commit Message Conventions
We recommend writing clear, descriptive commit messages following the [Conventional Commits](https://www.conventionalcommits.org/) convention:
```text
<type>(<scope>): <short summary>

[optional body explaining motivation and technical approach]
```
Common types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`, `build`, `security`.

### 3. Open a Pull Request
1. Push your branch to your fork on GitHub.
2. Open a Pull Request targeting the `main` branch of `puneetnith28/Praxis`.
3. Fill out the [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md) completely, including the summary, related issues, and testing performed.
4. Keep pull requests focused: aim for small, reviewable PRs addressing a single concern rather than multi-topic bundle PRs.
5. Verify that all CI checks pass. If a check fails, review the GitHub Actions log, fix the issue locally, and push an update to your branch.

---

## Continuous Integration (CI) Overview

Praxis runs an automated CI pipeline (`.github/workflows/ci.yml`) on every pull request and push to `main`:
- Runs in an isolated environment with **least-privilege permissions** (`permissions: contents: read`).
- Uses pinned, immutable GitHub Actions (`actions/checkout`, `actions/setup-node`).
- Executes reproducible dependency installation (`npm ci`).
- Executes brand linting, type checks, all 50 automated test suites, and production bundle builds.

---

## Where to Get Help & Report Issues

- **Bug Reports & Feature Requests**: Submit an issue via the [GitHub Issue Tracker](https://github.com/puneetnith28/Praxis/issues) using the dedicated bug or feature request forms.
- **Security Vulnerabilities**: Report security issues privately to the project maintainers per [SECURITY.md](SECURITY.md):
  - **Puneet Yadav**: [puneetnith28@gmail.com](mailto:puneetnith28@gmail.com)

