# Verification round 4

- When: 2026-10-25 10:50:15 UTC
- Commit: `afbbad1 fix(supervisor): pass the local model's key where OpenAIModel reads it`
- Working tree: uncommitted changes:

```
?? docs/verification/
```

## Typecheck (server + client)

PASS (11.9s)

## Test suites

| Suite | Result | Checks | Time |
|---|---|---|---|
| test-acp-client.mjs | pass | 21 / 21 | 4.0s |
| test-agent-routes.mjs | pass | — | 0.1s |
| test-anthropic-backoff.mjs | pass | 18 / 18 | 0.3s |
| test-approval-guard.mjs | pass | 38 / 38 | 0.2s |
| test-praxis-throttling.mjs | pass | — | 0.1s |
| test-brain-state.mjs | pass | — | 0.1s |
| test-branding-lint.mjs | pass | — | 0.1s |
| test-broadcast-benchmark.mjs | pass | — | 0.1s |
| test-cli-registry-matrix.mjs | pass | — | 0.1s |
| test-cli-registry.mjs | pass | 16 / 16 | 0.4s |
| test-daemon-leak-prevention.mjs | pass | — | 0.1s |
| test-dispatch-localharness.mjs | pass | 8 / 8 | 0.9s |
| test-env-precedence.mjs | pass | — | 0.1s |
| test-gate-acp.mjs | pass | 35 / 35 | 0.4s |
| test-gate-answer.mjs | pass | 55 / 55 | 0.2s |
| test-gate-bridge.mjs | pass | 32 / 32 | 0.8s |
| test-gate-policy.mjs | pass | 23 / 23 | 0.2s |
| test-gates.mjs | pass | 33 / 33 | 0.2s |
| test-instruction-files.mjs | pass | 17 / 17 | 0.2s |
| test-keeper-cli-enum.mjs | pass | 10 / 10 | 0.2s |
| test-keeper-localharness.mjs | pass | 8 / 8 | 1.0s |
| test-keeper-timeout.mjs | pass | — | 0.1s |
| test-keeper.mjs | pass | — | 0.2s |
| test-local-llm.mjs | pass | 24 / 24 | 0.3s |
| test-localharness-agents.mjs | pass | 51 / 51 | 1.2s |
| test-localharness-config.mjs | pass | 17 / 17 | 0.6s |
| test-localharness-prepare.mjs | pass | 8 / 8 | 0.7s |
| test-mcp-lifecycle.mjs | pass | — | 0.1s |
| test-process-cleanup.mjs | pass | 4 / 4 | 1.0s |
| test-project-routes.mjs | pass | — | 0.1s |
| test-security-boundaries.mjs | pass | — | 0.1s |
| test-server-app.mjs | pass | 9 / 9 | 1.6s |
| test-session-lifecycle.mjs | pass | — | 0.1s |
| test-skills-memory.mjs | pass | 24 / 24 | 0.9s |
| test-spawn-handshake.mjs | pass | — | 0.1s |
| test-storage-concurrency.mjs | pass | 6 / 6 | 0.6s |
| test-storage-failure.mjs | pass | — | 0.1s |
| test-storage-fs.mjs | pass | 17 / 17 | 0.2s |
| test-supervisor-concurrency.mjs | pass | 6 / 6 | 0.3s |
| test-supervisor-fallback.mjs | pass | 30 / 30 | 0.2s |
| test-supervisor-local.mjs | pass | 10 / 10 | 1.3s |
| test-templates-plugins.mjs | pass | 21 / 21 | 0.3s |
| test-utterance-extended.mjs | pass | — | 0.1s |
| test-utterance.mjs | pass | 14 / 14 | 0.2s |
| test-voice-picker.mjs | pass | 10 / 10 | 0.2s |
| test-voice-routing.mjs | pass | 59 / 59 | 0.2s |
| test-watcher-fastpath.mjs | pass | — | 0.1s |
| test-websocket-reconnect.mjs | pass | — | 0.1s |
| test-window-state.mjs | pass | 8 / 8 | 0.2s |

**49/49 suites passed.** Skipped (live, spends API calls): test-supervisor.mjs.

## Issues

None.
