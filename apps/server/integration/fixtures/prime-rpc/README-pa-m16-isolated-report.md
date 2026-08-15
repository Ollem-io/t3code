# PA-M16 isolated integration report

Run `node apps/server/integration/fixtures/prime-rpc/prime-agent-isolated-report.mjs` for the always-safe installed-binary lane, or add `--fake` for deterministic end-to-end fixture evidence. The runner is dependency-free and emits a canonical hash-only/redacted JSON report. It creates and removes a fresh T3/Prime namespace; it has no fallback to a user's home, configuration, daemon, session, workspace or ambient authentication environment.

The separately named authenticated lane is intentionally not invoked by tests or this task. `--authenticated` reports `not-run` unless **both** `PRIME_AGENT_AUTHENTICATED_TEST=1` and `PRIME_AGENT_AUTHENTICATED_PERMISSION=I_GRANT_READ_ONLY_SMOKE` are set. It also requires an explicit `PRIME_AGENT_AUTH_HOME`; the checked-in runner still declines cost-bearing activity pending a provider-approved read-only mount. This makes absence of permission auditable rather than implicit.

The fake peer scenarios are deterministic source fixtures used for client/event projections: streaming, tools, interaction, multi-request response ordering, interrupt race, and crash. They are not a claim about an authenticated model turn.

## Lifecycle guarantee

Each temporary directory is recorded in the manifest with every spawned child. The RPC runner ends stdin after its required responses, then requires the exact child to close. A lingering owned child is reaped only after its Linux `/proc/<pid>/stat` start-time token matches the launch token; missing or changed identity fails cleanup and retains the root. Cleanup must report `removed` for a ready/passed result. The `linger` fake scenario regression verifies this path. No name- or command-based process discovery is used.
