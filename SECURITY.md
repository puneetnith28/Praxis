# Security Policy

The Praxis team takes the security of our platform, agents, and users seriously. As Praxis executes coding agents with authentic shell and filesystem access, maintaining rigorous security practices is fundamental to the project.

---

## Supported Versions

We provide security fixes and updates for the following versions:

| Version | Supported |
|---|:---:|
| `1.x` (current `main`) | :white_check_mark: |
| `< 1.0` | :x: |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

If you believe you have discovered a vulnerability, security flaw, credential leakage, or unauthorized privilege escalation in Praxis, please report it privately:

### Contact Project Maintainers:
- **Puneet Yadav** (Project Maintainer): [puneetnith28@gmail.com](mailto:puneetnith28@gmail.com)

### What to Include in Your Report:
To help us triage and resolve the issue quickly, please provide:
1. **Description**: A clear summary of the potential vulnerability.
2. **Affected Components**: Specific files, routes (e.g., daemon sockets, REST endpoints, approval guards), or runtime modules.
3. **Proof of Concept / Steps to Reproduce**: Minimal steps, scripts, or payloads to demonstrate the vulnerability safely.
4. **Impact Assessment**: The potential consequences of exploiting the vulnerability (e.g., path traversal, command injection, gate bypass).
5. **Mitigation Suggestions** (if known).

---

## Response & Disclosure Process

1. **Initial Response**: A project maintainer will acknowledge receipt of your vulnerability report within **48 hours**.
2. **Assessment & Verification**: We will validate the reported issue and determine its severity.
3. **Patch Development**: A fix will be developed in a private security advisory branch.
4. **Coordinated Disclosure**: Once a patch is prepared and validated across all test suites, we will publish an update and credit the reporter (unless anonymity is requested).

---

## Security Invariants

Contributors must preserve Praxis's core security invariants:
- **Authentication (`CONDUIT_AUTH`)**: Enforced with constant-time comparison across HTTP and WebSocket upgrades.
- **Path Containment**: Paths are resolved with `storage.resolveInside` to prevent directory traversal.
- **DOMPurify Sanitization**: All model and agent markdown rendered in the browser passes through `renderMarkdown`.
- **Approval Guards**: Dangerous CLI commands and ACP permission prompts must never be auto-approved. Spoken approvals are strictly validated on the server transcript stream.
