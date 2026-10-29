# Verification round 6 — a fresh clone of `main`

Rounds 1–5 ran in the working copy. This one answers a different question: does
what is actually on GitHub work, from nothing?

- **Source:** `git clone https://github.com/puneetnith28/Praxis.git`, commit `84fcb5b`, branch `main`.
- **Install:** `npm install` on the clean clone — 561 packages, no errors.
- **Isolation:** the app ran against a temporary `HOME` on spare ports, so no real
  `~/.conduit` data was touched. No cloud credentials were used; the Supervisor was
  pointed at a mock local model server.

| Check | Result |
|---|---|
| `npm install` from nothing | pass |
| `npm run typecheck` (server + client) | pass |
| `npm run build` (production) | pass |
| Offline test suites | **49/49** |
| Live server, real daemon + web server | **47/47** |
| Hosted demo in a headless browser | **18/18** |

Only `test-supervisor.mjs` is left out: it spends real, paid Anthropic API calls.
Run it deliberately with `npm run test:supervisor`.

## The live server check

The daemon and web server were started from the built output, then driven over REST:

- A project and a LocalHarness agent were created; an unknown CLI was refused, and
  the message listed `localharness` among the valid ones.
- **A LocalHarness agent really started** — `localharness` 0.22.0 is installed on this
  machine and the mock model server answered, so the ACP session came up for real. Its
  controls reported it running, in **guarded** mode, offering five permission modes, on
  the configured model. A mode it never offered was refused; a real one was accepted.
  Its instruction section was written into the project, carrying the project's skill.
  It then stopped cleanly.
- Memory: recorded, searched, forgotten.
- Skills: a project `SKILL.md` was discovered.
- Agent definitions: read from `.praxis/agents`, imported, then reported as existing.
- Plugins: listed, discovered as disabled, enabled, disabled again.
- Local model settings: saved, read back, and an API key was never echoed. A malformed
  URL was refused.
- Every pre-existing route still answered, the project deleted cleanly, and the server
  logs held no crashes.

## The demo check

The preview was built the way the host builds it (`VITE_STATIC_PREVIEW=1`), served as
static files with **nothing** behind them, and driven in headless Chrome over the
DevTools protocol — the same mechanism `scripts/browser-check.mjs` uses, so no new
dependency.

It mounts, opens the control center, shows the sample project, and opens all eight tabs
(Terminals, MCP Messages, Group Chat, Shared, Wiki, **Team**, Activity, Usage) without
breaking. It makes no API calls at all, logs no console errors beyond the absent
backend, and no tab is clipped or hidden behind the buttons at 1440, 1280, 1024 or 900
pixels wide. The screenshot is `demo.png`.

## What this round found

**The hosted preview never showed its own banner** — the notice saying every screen is
real but no agent is running. `backendMissing` is cleared on `ws:open`, and the
preview's fake socket dispatches exactly that, so the fixtures switched off the banner
that exists to disclose them. Fixed in `9a8e37e`, and it predates this branch.

One thing I investigated and did **not** change: at narrow widths some tabs sit outside
the visible tab strip. Measuring it showed the strip already scrolls and nothing is
actually hidden behind the buttons — the first measurement was wrong, not the layout.
A CSS change written against that wrong reading turned out to alter nothing, and was
reverted rather than shipped.
