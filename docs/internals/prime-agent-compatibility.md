# Prime Agent compatibility matrix (MVP shipped)

The Prime provider uses a data-driven adapter-boundary compatibility decision before any RPC process is started.

| Installed version                     | Band                   | Behavior                                                                                |
| ------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| missing / unparseable                 | unknown / incompatible | unavailable; no RPC probe                                                               |
| below `0.7.2`                         | incompatible           | blocked; no RPC probe                                                                   |
| `0.7.2+known-bad` conformance fixture | incompatible           | blocked; no RPC probe                                                                   |
| `0.7.2` or `0.7.2+other`              | compatible             | ready only after `get_state` and `get_available_models` succeed with at least one model |
| newer unknown                         | advisory               | usable only after the same required probes pass; warning remains visible                |

`0.7.2+known-bad` is a synthetic matrix fixture, not a claim about a published release. It keeps the known-bad data path executable and reviewable until a documented upstream defect needs an entry.

The probe runs both `--version` and RPC inside the same isolated namespace. It launches `prime-agent --mode rpc` with disposable `HOME`, working, and session directories. It sends only `get_state` and `get_available_models`, never login/logout, session mutation, prompts, or daemon-wide commands. All captured child resources and temporary directories are closed exactly. Failures are coarse and do not expose account, environment, secret, or host path details. A safe previous model catalog may remain with `availability: "stale"`.

The probe subprocess receives a minimal environment allowlist (platform executable lookup,
locale/color controls, and disposable `HOME`/XDG/temp paths). It does not inherit provider
tokens, API keys, or arbitrary caller variables. Authentication and configuration discovery
therefore comes from the isolated, settings-scoped architecture rather than ambient env auth.

Prime model image input is preserved in the native RPC protocol for PA-M08 to consume. The
current `ServerProviderModel` contract has no image capability field, so this readiness mapping
does not claim an image capability that it cannot represent. The transient `checking` readiness
maps to provider `warning` because the provider snapshot contract has no checking status.

## PA-M16 integration evidence

`apps/server/integration/fixtures/prime-rpc/prime-agent-isolated-report.mjs` is a dependency-free isolated report runner. Its default lane gives an installed binary a fresh disposable `HOME`, T3 home, XDG config/data/cache, workspace, session and daemon roots; it uses only an allowlist environment and records exact spawned PID/start-token manifests. It performs `--version` and bounded `get_state`/`get_available_models`; an unauthenticated result is **setup required**, never a reason to borrow live auth. The canonical transcript is hash-only and cleanup is reported.

`--fake` covers deterministic streaming, tools, interactions, interrupt/race, crash and multi-request ordering fixtures. `--authenticated` is separately named and skips unless both `PRIME_AGENT_AUTHENTICATED_TEST=1` and `PRIME_AGENT_AUTHENTICATED_PERMISSION=I_GRANT_READ_ONLY_SMOKE` are supplied; it is not run in this repository/current host. No browser, simulator, or authenticated current-host lane is part of this proof.

## PA-A03 context, compaction, and retry

Prime 0.7.2 exposes two no-argument context commands, `get_session_stats` and `compact`, and
reports progress as bounded `compaction_update` / `retry_update` status snapshots. T3 maps them to
the provider-neutral `session.context.updated` event.

- **Compaction is not a checkpoint.** It shrinks the provider's context window and never reverts
  user work. No compaction path produces a revert, rollback, or checkpoint concept, on the wire or
  in client copy.
- **Absent usage is valid.** Prime may report no usage until it recomputes after compacting; T3
  keeps the previous usage rather than publishing an invented zero.
- **Cancellation is negotiated separately.** `compaction` and `compactionCancel` are independent
  capability flags. Prime 0.7.2 advertises `compaction: true, compactionCancel: false`: there is no
  compaction-cancel RPC, and T3 does not map cancellation onto the turn-wide `abort`.
- **Bounded updates.** Snapshots byte-identical to the last published one are dropped, and streamed
  token usage keeps its own canonical event instead of republishing context status. The status
  surface is a short list of discrete states with nothing to animate.
- **Usage metadata only.** Context events carry counts, status, trigger, and a bounded runtime
  reason string — never transcript content.

`packages/contracts/fixtures/pa-a03-prime-context-transcript.mjs` verifies the phase/status and
activity-summary tables against the shipped source and fails if either drifts.
