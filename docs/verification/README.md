# Verification: LocalHarness integration (`feat/localharness`)

The integration was verified in five rounds, each written up in its own report. Each round
ran the server and client typecheck and every offline test suite. Some rounds also ran the
production build and an end-to-end run against the real LocalHarness.

| Round | At commit | Typecheck | Suites | Build | End to end | Issues |
|---|---|---|---|---|---|---|
| [1](round-1.md) | `9fb9d37` local Supervisor | pass | 46/46 | — | 5/5 | none |
| [2](round-2.md) | `253e8d7` skills, memory | pass | 47/47 | — | — | none |
| [3](round-3.md) | `1e396fa` controls, Team tab | pass | 48/48 | pass | — | none |
| [4](round-4.md) | `afbbad1` Supervisor key fix | pass | 49/49 | — | — | none |
| [5](round-5.md) | `33dd8e6` docs | pass | 49/49 | pass | 5/5 | none |
| [6](round-6-from-github.md) | `84fcb5b` a fresh clone of `main` | pass | 49/49 | pass | live 47/47 · demo 18/18 | the preview banner (fixed) |

Only one suite is left out of every round: `test-supervisor.mjs`. It makes real, paid Anthropic
API calls with the machine's credentials, so run it on purpose with `npm run test:supervisor`.

## The end-to-end check

`localharness` 0.22.0 is the real one, installed from the upstream repository. It runs over ACP,
driven by Praxis's own runtime (`prepareLocalHarnessAgent` → `localharness init` →
`localharness acp`), against a mock model server that looks like Ollama. Each run checks
these steps:

1. LocalHarness's first-run workspace-trust question becomes a Praxis gate, offering its real
   options ("Trust this workspace" · "Not now").
2. The first turn replies.
3. The model calls `write`. LocalHarness asks permission, and a gate with all four options is
   raised.
4. Answering it "Allow once" lets the turn finish.
5. `hello.txt` is on disk.

## Issues found along the way, and how they were fixed

| Found | Fix |
|---|---|
| A fresh clone could not `npm install` (no `.npmrc`) | `9b99c1f` |
| Two tests always failed on Windows, so the runner skipped every suite after them | `e18b33c`, `13b0d6f` |
| The instruction section was appended again on every agent start and never removed | `dc964c9` |
| An ACP gate could have been "auto-approved" by typing `y` into the composer | `ce4d14a`: `classifyGate` calls every non-regex gate harmful |
| On Windows the real LocalHarness hung forever on its first prompt (stdin read vs. numpy import) | `0d699a4`: keep-awake newlines while a request waits |
| LocalHarness's "Starting the session…" progress line was returned as the agent's reply | `0d699a4` |
| The local Supervisor's key went where `OpenAIModel` ignores it, so it depended on `OPENAI_API_KEY` | `afbbad1` |

## Round 6

Rounds 1-5 ran in the working copy. Round 6 clones `main` from GitHub, installs from
nothing, and checks the built app three ways: every offline suite, a **live** daemon and
web server driven over REST (which started a real LocalHarness agent), and the **hosted
demo** in a headless browser with no backend behind it. See
[round-6-from-github.md](round-6-from-github.md).

## Not verified here

- **A real local model.** Neither Ollama nor LM Studio is installed on the machine these rounds
  ran on, so the model was a mock. The harness, the protocol and every Praxis code path were
  real.
- **The new UI clicked through against a live backend.** Round 6 drives the whole interface in
  a real browser, but against the demo fixtures. The live-server round exercises the same
  features over REST rather than by clicking.
