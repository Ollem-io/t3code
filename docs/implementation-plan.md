# Prime Agent dedicated-RPC implementation plan

> Planning base: approved `docs/product.md` and `docs/usage.md` at `6a5f0d74cd5640a9bbcbdbc26dae5ed4b329a8c1`.
> This is an implementation sequence, not a claim that Prime Agent support is shipped.

## Planning decisions and guardrails

- **Boundary:** Prime RPC framing, correlation, capability/version interpretation, resource ownership, and native-event translation stay in the Prime driver/adapter. `ProviderService`, orchestration deciders/reactors, projections, and clients consume typed provider-neutral concepts.
- **MVP session policy:** launch with a T3-scoped `--session-dir`, not `--no-session`. Scope it below T3 home by environment/instance/thread, record exact ownership, and make no resume promise until Beta. This matches approved usage and leaves a safe Beta migration path.
- **Compatibility:** minimum supported Prime Agent is 0.7.2. Known-incompatible releases are blocked. Unknown newer releases may run only after strict RPC handshake and required capability probes succeed, with an advisory. Dedicated RPC never falls back to ACP.
- **Authentication:** readiness is inferred only from a bounded non-interactive RPC handshake, `get_state`, and `get_available_models`; T3 does not inspect or reproduce Prime auth-store contents.
- **Settings:** expose typed binary/session/config options only. Do not expose unrestricted launch arguments; reject collision with T3-owned `--mode`, workspace, model, or session flags.
- **Model identity:** add a structured provider-native identity where needed (`provider` + `modelId`) while retaining a readable collision-free slug for older clients and persisted selections. Never infer the upstream provider by splitting an arbitrary model ID.
- **Review isolation:** real-binary tests may use the installed Prime Agent 0.7.2 executable, but must use temporary HOME/config/session/daemon directories and must not mutate live auth, live T3 userdata, or unrelated Prime daemon state. Capture and stop only PIDs started by the test.
- **Verification:** commands below are deliberately focused. Do not substitute repo-wide `vp check`, recursive test, lint, or typecheck commands. Backend async tests wait on receipts/worker drains, not sleeps.
- **UI evidence:** UI tasks require committed before/after screenshots (and a short video for timing/motion) as review artifacts, but implementers/reviewers must not launch browsers or simulators without explicit permission. Until permission is granted, provide exact `test-t3-app` / `test-t3-mobile` launch scripts and mark visual capture pending.

### Traceability shorthand

- **P-MVP/Alpha/Beta** refers to the corresponding release and user-observable outcomes in `docs/product.md`.
- **U1–U9** refers to MVP sections 1–9 in `docs/usage.md`; **U10–U16** to Alpha sections; **U17–U20** to Beta; **U21–U23** to update, cleanup, and privacy.
- “All providers unchanged” means Codex, Claude, Cursor, Grok, and OpenCode must retain their existing behavior and tests.

## MVP — dedicated RPC adapter and supported-provider core

### PA-M01 — Versioned Prime RPC schemas and fixture corpus (MVP)

**Objective.** Establish the explicit 0.7.2 protocol boundary before process or adapter code depends on it.

**Scope.** Add runtime-decodable schemas/types for the MVP commands, correlated success/failure responses, core events, model objects, image inputs, and extension UI messages actually consumed by T3. Add small LF byte fixtures for 0.7.2 covering normal, additive-field, malformed, and unknown-event cases. Record fixture provenance and redaction. Define the protocol scripts consumed by a deterministic process-level fake `prime-agent --mode rpc` executable fixture shared with PA-M03 and later lifecycle tests. **Exclude** Alpha/Beta commands except envelope-level forward compatibility; do not import Prime's installed TypeScript declarations at production runtime.

**Acceptance criteria.** Required fields fail locally with a compatibility-class error; unknown additive fields survive decoding or are ignored safely; unknown event types can be classified without crashing; fixtures contain no credentials, prompts, transcripts, or host paths (P compatibility/security/testing; U3, U9, U21, U23).

**Expected components.** A Prime-specific protocol module and tests under `apps/server/src/provider/prime/` (or equivalent adapter-boundary directory), versioned fixtures under `apps/server/integration/fixtures/prime-rpc/`, and a short fixture README. No orchestration changes.

**Review artifact.** A fixture decoder CLI/test invocation that prints only fixture name, decoded envelope class, and pass/fail: `vp test run apps/server/src/provider/prime/PrimeRpcProtocol.test.ts`.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeRpcProtocol.test.ts apps/server/integration/primeRpcFixtures.integration.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** Fixtures are append-only by Prime version. A schema change must preserve decoding of 0.7.2 fixtures or explicitly move the version into a blocked compatibility band.

**Applicability.** Clients: N/A, server-only. Providers: Prime only; regression asserts all existing kinds remain open/decodable. Contracts: no T3 wire change. Reverse states: malformed/unknown inputs produce terminal errors/warnings. Connections: identical in all modes because parsing is host-side. Performance: bounded schemas/fixture sizes. Security/privacy: redacted native payloads. Lifecycle: no resources. Docs: fixture README; shipped user docs remain proposed.

### PA-M02 — Strict-LF bounded transport parser/writer (MVP)

**Objective.** Implement byte-correct JSONL framing independently of subprocess lifecycle.

**Scope.** Build a streaming parser that splits only on LF, strips one trailing CR, handles arbitrary chunk boundaries and UTF-8 boundaries, preserves U+2028/U+2029 inside JSON strings, caps record and total buffered bytes, and defines EOF-fragment behavior. Build an atomic one-record-per-LF writer. **Exclude** request IDs, processes, and event mapping.

**Acceptance criteria.** Byte tests cover single/multiple records, byte-at-a-time chunks, CRLF tolerance, Unicode separators, malformed UTF-8/JSON, oversized records/buffers, empty lines, and partial EOF. No unbounded concatenation or Node `readline` is used (P-MVP core, performance/reliability/testing; U9).

**Expected components.** Prime transport codec/parser module and focused unit tests under the server provider boundary.

**Review artifact.** A deterministic parser conformance test executable via the command below; its cases are usable independently of Prime installation.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeRpcFraming.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** Limits are named constants and may be raised compatibly; lowering them requires fixture and diagnostics review. CRLF remains accepted input, LF remains output.

**Applicability.** Clients/contracts: N/A. Providers: Prime only. Reverse states: close/fail releases buffered data and reports a typed transport error. Connections: host-local transport, wire-mode neutral. Performance: bounded buffer and linear parsing. Security/privacy: stdout treated as untrusted; errors omit record content. Lifecycle: parser close is idempotent. Docs: maintainer framing section later; user docs unchanged.

### PA-M03 — Correlated RPC client and asynchronous event multiplexer (MVP)

**Objective.** Provide a reusable session-local command layer that cannot confuse responses with asynchronous events.

**Scope.** Add monotonic/opaque request IDs, an O(1) pending-request map, per-command deadlines/cancellation, response command/ID validation, asynchronous event delivery, duplicate/late response policy, process-exit fan-out, stderr capture limits, and backpressure-safe stdout draining. Exercise it both through an in-memory duplex and the deterministic process-level fake RPC executable from PA-M01, including real stdin/stdout chunking, backpressure, stderr, and exit behavior. **Exclude** production Prime subprocess launch policy and canonical event mapping.

**Acceptance criteria.** Interleaved event/response fixtures resolve the correct waiter; timeout, duplicate ID, mismatched command, late-after-abort, EOF, and child-exit paths settle each request exactly once; a slow event consumer cannot block stdout reading (P reliability/performance; U5, U6, U9).

**Expected components.** Prime RPC client module, fake duplex transport, unit tests, bounded diagnostic metadata hooks.

**Review artifact.** Fake-transport scenario test showing two concurrent commands and intervening events, runnable without source-dependent setup beyond the test command.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeRpcClient.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** Unknown events remain deliverable to later classifiers; command-specific response decoders are versioned. No persisted state.

**Applicability.** Clients/contracts: N/A. Providers: Prime only. Reverse states: cancellation removes waiter and ignores bounded late responses. Connections: N/A beyond host. Performance: constant-time maps, bounded queues/logs. Security/privacy: stderr/raw records redacted/truncated. Lifecycle: close rejects all waiters and detaches readers once. Docs: internal protocol mapping later.

### PA-M04 — Prime provider contracts, typed settings, and structured model identity (MVP)

**Objective.** Make Prime a first-class instance-driven provider without flattening native model identity.

**Scope.** Register `prime-agent` presentation constants, define typed Prime settings (enabled, binary path, and only approved typed config/session choices), extend model/server snapshot contracts with the minimum structured native identity and compatibility/status metadata, and preserve readable slugs. Define deterministic default-instance bootstrap for settings that predate provider instances, including idempotent startup migration, stable default instance identity, and mixed old-client/new-server plus new-client/old-server behavior. Add decode/encode tests for old and new clients/settings. **Exclude** server driver and UI implementation.

**Acceptance criteria.** Two models with the same `modelId` and different Prime providers remain distinct through contracts; settings cannot encode unrestricted launch args or override owned flags; absent new fields decode safely; default bootstrap/migration runs once without duplicate instances and preserves an older client's readable settings; old/new round trips do not erase unknown instance fields; sensitive instance environment values continue redaction (P-MVP registration/models/security; U2–U4, U21, U23).

**Expected components.** `packages/contracts/src/settings.ts`, `model.ts`, `server.ts`, provider constants/exports and tests; shared model helpers only if provider-neutral.

**Review artifact.** Contract round-trip fixture containing overlapping model IDs and an older payload, runnable with focused contract tests.

**Focused verification.** `vp test run packages/contracts/src/settings.test.ts packages/contracts/src/providerInstance.test.ts packages/contracts/src/provider.test.ts`; `vp run --filter @t3tools/contracts typecheck`.

**Migration/compatibility.** New fields are optional or decoding-defaulted; legacy string slugs remain readable. Persisted selections gain structured identity lazily or through a narrow reversible migration only if required. Unknown drivers continue round-tripping.

**Applicability.** Clients: future web/desktop/mobile consumers; no UI yet. Providers: Prime added; all existing providers unchanged. Contracts: yes. Reverse states: enabled/disabled and available/unavailable representable. Connections: same wire shape all modes; no host paths/env values added. Performance: compact metadata only. Security/privacy: no auth details/secrets. Lifecycle: N/A. Docs: glossary only if “native model identity” becomes durable; user docs still proposed.

### PA-M05 — Read-only version, status, auth-usability, model, and capability probes (MVP)

**Objective.** Turn a configured Prime binary into a truthful, cached provider snapshot without mutating live Prime state.

**Scope.** Implement bounded executable/version check and isolated RPC probe using `get_state` plus `get_available_models`; classify missing, disabled, checking, ready, setup-required, incompatible, advisory, and runtime-error; map model capabilities/thinking levels; preserve stale catalog on refresh failure; cache/cancel refreshes. **Exclude** live thread sessions and account-detail promises.

**Acceptance criteria.** 0.7.2 becomes ready when models are usable; below-minimum/known-bad is blocked; unknown newer passes only after required probes and shows advisory; probe never prompts for login, changes auth, or leaves daemon/session resources; failed refresh leaves explicitly stale models where safe (P-MVP outcomes 1,3,5; U1–U3, U9, U21).

**Expected components.** `PrimeProvider` snapshot/probe layer, compatibility matrix module, status-cache integration, fake-binary tests.

**Review artifact.** Isolated probe script accepting `PRIME_AGENT_BIN` and temporary `HOME`/session dirs, printing only version, compatibility band, coarse readiness, and model count. For current-host review: `PRIME_AGENT_BIN=$(command -v prime-agent) <script>`; never point it at live daemon/session storage.

**Focused verification.** `vp test run apps/server/src/provider/Layers/PrimeProvider.test.ts apps/server/src/provider/prime/PrimeCompatibility.test.ts apps/server/src/provider/providerStatusCache.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** Compatibility bands are data-driven and tested. Last-known snapshots from older builds decode without new detail fields. No ACP fallback.

**Applicability.** Clients: data for all; UI later. Providers: Prime only, failure isolated by instance. Contracts: consumes M04 snapshot fields. Reverse states: refresh, enable/disable, recovery message. Connections: always probes environment host. Performance: TTL cache, bounded timeout, never per render. Security/privacy: coarse usability only; no account/secret/path leakage. Lifecycle: probe child and temp resources always closed. Docs: compatibility matrix draft in internal docs.

### PA-M06 — T3-scoped Prime resource layout and exact ownership registry (MVP)

**Objective.** Define and enforce the only resources T3 may stop or clean.

**Scope.** Create deterministic T3-home/environment/instance/thread session/config/daemon paths; ownership handles for captured child PID/start token, RPC session identity, and optional daemon active-session identity; atomically write/version ownership records; recover and reap stale T3-owned resources at startup only after proving identity; provide idempotent scoped cleanup and orphan warning behavior. Test two independent T3 homes on one host and unrelated Prime sentinels. **Exclude** durable resume/adoption and global Prime cleanup.

**Acceptance criteria.** Concurrent instances/threads and two T3 homes get disjoint paths; startup recovery handles complete, partial, corrupt, and stale ownership records atomically; disable/reconfigure/server shutdown can enumerate only exact T3-owned handles; every action is proof-before-action; an unprovable or foreign resource is left intact with an orphan/cleanup warning; no process-name matching or daemon-wide shutdown (P exact ownership, MVP outcome 4; U2, U4, U6, U21–U22).

**Expected components.** Prime resource-layout/ownership service near adapter/session directory, server config/home integration, focused filesystem/process doubles.

**Review artifact.** Temporary-directory ownership test that creates two instances plus an unrelated sentinel and proves cleanup removes/stops only one selected instance.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeResourceLayout.test.ts apps/server/src/provider/prime/PrimeOwnership.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** MVP ownership metadata is versioned and intentionally not a resume cursor. Unknown future versions are retained/ignored safely. Cleanup tolerates missing old directories.

**Applicability.** Clients: only canonical warnings later. Providers: Prime only. Contracts: none unless warning detail needs bounded typed metadata. Reverse states: create/stop; disable/re-enable; cleanup warning visible. Connections: resources always host-local and environment-scoped. Performance: indexed/map lookup, no global filesystem scan. Security/privacy: restrictive permissions; no prompt/transcript in metadata. Lifecycle: central concern. Docs: internal ownership policy and operations cleanup draft.

### PA-M07 — Driver registration and live session bootstrap (MVP)

**Objective.** Materialize a Prime provider instance and one scoped RPC subprocess per live T3 thread.

**Scope.** Add `PrimeDriver` to built-ins, construct snapshot/adapter/text-generation closures, launch `prime-agent --mode rpc` in the effective workspace with T3-owned `--session-dir`, perform bounded handshake/configuration, enforce one process per thread, and integrate scoped instance teardown. **Exclude** turn content/event mapping beyond readiness and terminal exit.

**Acceptance criteria.** Multiple instances and threads are isolated; duplicate start for a bound thread does not spawn another process; invalid owned-flag collisions fail validation; missing/crashed Prime affects no other provider/server operation; scope close stops only captured children (P-MVP outcomes 1–4; U2, U4, U8–U9).

**Expected components.** `Drivers/PrimeDriver.ts`, `Layers/PrimeAdapter.ts` bootstrap/session map, `builtInDrivers.ts`, runtime layer dependencies, adapter registry/session directory tests.

**Review artifact.** Fake-binary integration test whose child records argv/cwd into a temp directory, plus exact command to inspect assertions. Optional current-binary handshake uses M05 isolation script.

**Focused verification.** `vp test run apps/server/src/provider/Layers/PrimeAdapter.session.test.ts apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** Default instance ID follows existing driver convention. Existing settings without Prime remain unchanged. Scoped session files are explicitly non-resumable product state until Beta.

**Applicability.** Clients: no direct change. Providers: Prime added; existing provider adapter tests remain focused regressions. Contracts: M04 config. Reverse states: start/stop, disable/re-enable. Connections: server host launches regardless of client mode. Performance: one child/live thread, no duplicate clients. Security/privacy: validated argv, no secret echo. Lifecycle: child scope, graceful close then exact forced termination. Docs: built-in provider table remains proposed until phase integration.

### PA-M08 — Prompt, attachment, model, and thinking configuration path (MVP)

**Objective.** Deliver a validated T3 turn to Prime with the exact native model selection and supported content.

**Scope.** Configure `set_model` and `set_thinking_level` with confirmed responses, translate prompt text, resolve text attachments into bounded textual content, encode supported images, reject unsupported/oversized/unreadable attachments before acceptance, and define in-session model-switch capability. **Exclude** streamed output mapping and Alpha steer/follow-up.

**Acceptance criteria.** Native provider/model pair is passed without collision; unsupported thinking is rejected or omitted truthfully; text and supported image attachments arrive; unsupported types fail before the turn and are not dropped; unavailable selected model never silently substitutes (P-MVP outcomes 1,5; U3–U5, U9).

**Expected components.** Prime adapter turn input/attachment helpers, attachment-store integration, tests with recorded RPC commands and model fixtures.

**Review artifact.** Fake RPC transcript for plain text, text attachment, image, overlapping IDs, and rejected type; exact test command below.

**Focused verification.** `vp test run apps/server/src/provider/Layers/PrimeAdapter.turn-input.test.ts apps/server/src/attachmentStore.test.ts packages/contracts/src/provider.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** Legacy slug-only selection is resolved only when unambiguous; ambiguous old selections become unavailable and require deliberate reselection. No silent migration to another model.

**Applicability.** Clients: existing attachment/composer contracts; UI capability display later. Providers: Prime only. Contracts: structured model identity from M04. Reverse states: failed preflight leaves composer retryable; confirmed switch or new-thread requirement. Connections: attachment bytes already traverse T3 wire, resolution on host. Performance: bounded reads/base64 and no duplicate payload copies. Security/privacy: sanitize errors/paths, do not log attachment data. Lifecycle: no new long-lived resource. Docs: U4–U5 shipped later.

### PA-M09 — Canonical message, reasoning, tool, usage, error, and terminal event mapping (MVP)

**Objective.** Normalize Prime's event stream exactly once into existing `ProviderRuntimeEvent` concepts.

**Scope.** Map agent/turn/message lifecycles, assistant/reasoning deltas, tool start/update/end, usage, auto-retry/error, unknown events, and exactly-once turn completion. Convert accumulated tool updates into deltas or material replacements with fingerprints/coalescing. **Exclude** extension dialogs and Alpha task/subagent presentation.

**Acceptance criteria.** Representative 0.7.2 fixtures render as canonical items without raw-payload dependence; abort/error/normal completion terminalize exactly once; repeated accumulated tool output does not produce quadratic bytes/events; unknown additive event gives bounded warning and session continues where safe (P-MVP outcomes 1,3,5,6; U5, U9; performance/reliability).

**Expected components.** Prime event normalizer/state machine, adapter event publication, canonical fixture tests, optional transfer-budget fixture.

**Review artifact.** Golden canonical event transcript generated from redacted native fixtures, plus byte/event-count budget report for growing tool output.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeEventNormalizer.test.ts apps/server/integration/fixtures/transferBudget.ts packages/contracts/src/providerRuntime.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** Raw source enum gains a Prime source compatibly. Unknown fields/events remain warning-level unless required semantics changed. Golden fixtures version by Prime release.

**Applicability.** Clients: consume existing timeline/activity state. Providers: Prime mapping only; canonical contract remains provider-neutral. Contracts: minimal raw-source/event additions if required. Reverse states: every start has completion/failure/interruption. Connections: canonical events only across all modes. Performance: coalescing/fingerprints/bounded raw. Security/privacy: raw omitted by default, content excluded from telemetry. Lifecycle: late-after-stop ignored or warned. Docs: internal event mapping draft.

### PA-M10 — Interactions, interrupt, stop, crash, and scoped teardown (MVP)

**Objective.** Complete truthful control and terminal behavior for interactive and failed sessions.

**Scope.** Map representable extension `select`/`confirm`/`input`/`editor` dialogs into typed approvals/user input; send correlated `extension_ui_response`; safely cancel unsupported dialogs; implement `abort`, graceful stdin close, bounded child termination, abnormal exit, adapter `stopAll`, and startup recovery/reaping through PA-M06's atomic ownership records. All teardown/recovery remains proof-before-action and emits redacted orphan warnings when ownership cannot be established. **Exclude** Alpha fire-and-forget/richer widget UI.

**Acceptance criteria.** Requests appear and resolve across existing interaction contracts; unsupported dialog never hangs invisibly; interrupt terminalizes and permits later prompt when Prime does; stop/crash always exits running/waiting; disable/reconfigure stops only owned sessions; unrelated Prime sentinel survives (P-MVP outcomes 1–5; U5–U6, U8–U9, U22).

**Expected components.** Prime adapter pending-request maps and lifecycle state machine, ownership integration, ProviderService/adapter tests.

**Review artifact.** Scripted fake Prime process that opens each dialog, ignores/accepts abort, and crashes; canonical transcript and surviving unrelated-sentinel assertion.

**Focused verification.** `vp test run apps/server/src/provider/Layers/PrimeAdapter.interactions.test.ts apps/server/src/provider/Layers/PrimeAdapter.lifecycle.test.ts apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** New interaction variants must be forward-compatible; unsupported methods cancel rather than block. No global daemon operation.

**Applicability.** Clients: existing web/mobile interaction surfaces, integration later. Providers: Prime only. Contracts: reuse existing approval/user-input unless semantics require additive kind. Reverse states: respond/cancel, interrupt/continue, stop/restart. Connections: authorization remains T3; second client sees same projected request. Performance: O(1) pending maps, bounded timeouts. Security/privacy: sanitize titles/options, no native path leakage. Lifecycle: primary focus. Docs: U5–U6 shipped later.

### PA-M11 — Prime text-generation operations (MVP)

**Objective.** Ensure selecting a Prime instance does not break provider-routed title, branch, commit, or change-request generation.

**Scope.** Implement Prime-backed `TextGeneration` for thread title, branch name, commit message, and PR content using isolated short RPC sessions or a proven adapter-safe operation; apply output parsing/limits and the chosen native model identity. **Exclude** reuse of a live conversational session and Alpha commands.

**Acceptance criteria.** All four operations return their existing typed results; failures are operation-scoped and do not poison a thread; attachments supported by branch/title operations follow M08 rules; temporary resources are cleaned exactly (P provider-native/core experience; U4–U6).

**Expected components.** `apps/server/src/textGeneration/PrimeTextGeneration.ts`, driver wiring, focused tests alongside existing provider text-generation suites.

**Review artifact.** Fake-RPC text-generation transcript plus exact CLI/test instructions for all four operations.

**Focused verification.** `vp test run apps/server/src/textGeneration/PrimeTextGeneration.test.ts apps/server/src/textGeneration/TextGeneration.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** `TextGenerationProvider` and defaults gain Prime additively. If no safe default exists, configured selection is required rather than silently using another provider.

**Applicability.** Clients: existing generic operations only. Providers: Prime added; existing operations unchanged. Contracts: provider kind/default selection additions. Reverse states: retry on typed failure. Connections: executes on environment host. Performance: short bounded sessions/cache where safe. Security/privacy: prompts/results not telemetry; temp sessions scoped. Lifecycle: each operation owns/closes its child. Docs: no separate UI docs unless selection changes become visible.

### PA-M12 — Provider-neutral orchestration, checkpoints, multi-client, and remote integration (MVP)

**Objective.** Prove Prime flows through the existing command/event/projector path with no Prime branch in the decider or client transport.

**Scope.** Integrate session start/turn/interrupt/request response/stop into reactors and ingestion; verify checkpoints/diff/revert remain T3-owned; verify duplicate subscriptions/concurrent viewers do not spawn duplicate sessions; add a barrier-controlled cross-client authorization/race fixture before any UI task may claim multi-client control; add remote subscription contract tests. **Exclude** Prime conversation rollback on checkpoint revert and durable resume.

**Acceptance criteria.** Normal Prime work reaches existing projected message/activity/checkpoint surfaces; revert explicitly does not claim Prime history rewind; two clients observe/control one authoritative turn under existing authorization/conflict rules; one slow subscription cannot block provider stdout; all async tests use receipts/drains (P-MVP outcomes 1,2,6; U6–U8).

**Expected components.** Integration tests around `ProviderCommandReactor`, `ProviderRuntimeIngestion`, `CheckpointReactor`, orchestration engine, provider service; production orchestration changes only when a generic capability is missing.

**Review artifact.** Headless integration scenario with two simulated clients, one fake Prime process, a workspace change/checkpoint/revert, interrupt, and stop; output is projected state plus child spawn count.

**Focused verification.** `vp test run apps/server/integration/providerService.integration.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** Existing events/commands stay decodable; any generic capability field is optional. Persisted histories without Prime are untouched; MVP Prime histories remain readable after process loss.

**Applicability.** Clients: simulated web/mobile wire consumers. Providers: Prime plus regression cases for all existing adapters. Contracts: generic additive changes only. Reverse states: interrupt, stop, checkpoint revert with continuity disclaimer. Connections: local/LAN/relay/tunnel identical typed wire. Performance: canonical-only fan-out, drain/backpressure tests. Security/privacy: existing remote auth boundary, no raw RPC. Lifecycle: single authoritative session binding. Docs: internal provider mapping updated at phase completion.

### PA-M13 — Web/desktop provider settings and health UI (MVP)

**Objective.** Make Prime instances administrable and diagnosable from web and desktop.

**Scope.** Add Prime to provider add flow, instance card/form, enable/disable/remove/reconfigure confirmations, refresh status, version/compatibility/auth-usability/stale-model presentation, host-only setup copy, and unavailable bound-thread messaging. Desktop reuses web/server contracts and does not launch Prime in Electron. **Exclude** mobile administration and composer/model picker.

**Acceptance criteria.** User can add named instances with binary path and sensitive env conventions, see every approved status and last check, refresh, disable/re-enable, reconfigure, and remove with scoped-impact copy; no Prime API-key field or unrestricted args; other provider cards unchanged (P-MVP outcomes 1,3,4; U1–U3, U8–U9, U21–U23).

**Expected components.** `apps/web/src/components/settings/ProviderSettingsPanel.tsx`, `ProviderInstanceCard.tsx`, schema-driven form/presentation helpers, provider icon/name mappings, focused component tests. Desktop-specific code only if an existing wrapper assumption blocks reuse.

**Review artifact.** Before/after screenshots at desktop and narrow responsive widths for Ready, Setup required, Incompatible, Stale, Disabled, and cleanup warning; exact `test-t3-app` scenario/seed instructions. Do not launch without permission.

**Focused verification.** `vp test run apps/web/src/providerInstances.test.ts apps/web/src/components/settings/ProviderInstanceCard.test.tsx apps/web/src/components/settings/ProviderSettingsPanel.test.tsx`; `vp run --filter @t3tools/web typecheck`.

**Migration/compatibility.** Older servers omit Prime; UI simply lacks the driver. Older clients ignore additive snapshot fields. Form round-trips unknown config fields where existing settings policy requires it.

**Applicability.** Clients: web yes, desktop same renderer, mobile view-only later. Providers: Prime presentation; existing cards regression-tested. Contracts: consumes M04/M05. Reverse states: enable/disable, add/remove, refresh, reconfigure. Connections: labels all paths/binary/auth as environment-host state. Performance: refresh user/cache driven, no polling/animation. Security/privacy: redacted sensitive values and sanitized messages. Lifecycle: UI invokes server-scoped teardown only. Docs: screenshots retained; user docs not yet graduated until M16.

### PA-M14 — Web/desktop picker, composer, timeline, and recovery UI (MVP)

**Objective.** Complete the normal Prime thread workflow on web and desktop.

**Scope.** Show Prime instance/model structured labels and capabilities, thinking options, stale/unavailable state, confirmed session-switch rules, attachment validation, composer/provider status, normal activity/interactions, interrupt/continue/stop, crash/retry messages, and checkpoint continuity disclaimer. Cover command palette/keybindings where provider-neutral actions already exist. **Exclude** Alpha controls.

**Acceptance criteria.** The MVP first-use and failed-start checklists can be completed; overlapping model IDs are distinct; vanished model never silently changes; interactions and terminal states are truthful; remote second viewer sees the same state; normal diff/checkpoint surfaces remain available (P-MVP outcomes 1–6; U3–U9).

**Expected components.** `apps/web/src/components/chat/ProviderModelPicker.tsx`, model rows/sidebar/content, `ChatComposer.tsx`, activity/request/error components, command palette/keybinding integration, shared provider helpers and focused tests.

**Review artifact.** Before/after screenshots for picker collision/capabilities, streaming tool activity, interaction, interrupted/continued turn, unavailable model, and crash recovery; short video only if new timing/motion exists; exact seeded `test-t3-app` instructions, no unapproved launch.

**Focused verification.** `vp test run apps/web/src/components/chat/modelPickerSearch.test.ts apps/web/src/modelSelection.test.ts apps/web/src/components/chat/ProviderModelPicker.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx`; `vp run --filter @t3tools/web typecheck`.

**Migration/compatibility.** Legacy model slugs remain displayable; ambiguity requires reselection. Capability-gated actions disappear/disable with explanation. No changes to non-Prime picker behavior.

**Applicability.** Clients: web and desktop yes; mobile separate. Providers: Prime plus regression for existing rows/actions. Contracts: M04 and canonical runtime only. Reverse states: interrupt/continue, stop, retry/reselect, close/cancel interaction. Connections: same UI over local/relay/tunnel. Performance: no full raw payloads or repainting status; tool updates bounded. Security/privacy: no host path/credentials. Lifecycle: renderer never owns process. Docs: evidence retained; graduation at M16.

### PA-M15 — Mobile selection, control, interactions, and host-status parity (MVP)

**Objective.** Make an already-configured Prime instance fully usable and controllable from mobile without pretending the phone is the host.

**Scope.** Add instance/model/thinking selection, capability/stale/unavailable labels, normalized timeline/tool/request rendering, interrupt/continue/stop, retry/reselect, and host-only setup/compatibility guidance. **Exclude** adding/editing provider instances on mobile and all Alpha controls.

**Acceptance criteria.** Mobile can perform the normal thread flow against a remote host, answer supported interactions, interrupt and stop, and see actionable missing/auth/version/model/crash states; it never shows a phone-local binary/login/API-key flow (P-MVP outcomes 1–5 and mobile surface; U1–U9).

**Expected components.** `apps/mobile/src/features/threads/NewTaskDraftScreen.tsx`, thread route/feed/action UI, selected-request state, shared `packages/client-runtime` provider/model helpers where genuinely shared, focused mobile tests.

**Review artifact.** Before/after iOS and Android-equivalent screenshots for picker, host setup error, tool activity, interaction, interrupt/stop, plus exact seeded `test-t3-mobile` instructions. Do not launch simulators/emulators without permission.

**Focused verification.** `vp test run apps/mobile/src/state/use-selected-thread-requests.test.ts apps/mobile/src/features/threads/prime-provider.test.tsx`; `vp run --filter @t3tools/mobile typecheck`; `node scripts/mobile-native-static-check.ts` only if native-facing files change.

**Migration/compatibility.** Mobile tolerates servers without structured identity/additive status fields. Persisted drafts with unavailable Prime selection remain visible and unsendable until changed.

**Applicability.** Clients: mobile yes; web/desktop already M13–M14. Providers: Prime presentation, existing providers regression-tested. Contracts: consumes prior fields. Reverse states: interrupt/continue, stop, retry/reselect/cancel. Connections: explicitly remote-ready; host semantics prominent. Performance: canonical bounded state, no polling/continuous animation. Security/privacy: no host paths/secrets. Lifecycle: server owns all resources. Docs: mobile screenshots retained; graduation at M16.

### PA-M16 — Isolated real-binary integration gate and MVP documentation graduation (MVP)

**Objective.** Validate the complete phase against the installed supported binary without touching live state, then graduate only the behavior actually proved.

**Scope.** Maintain two explicitly separate conformance lanes:

- **Always-safe isolated lane:** run the real installed `prime-agent` executable with temporary T3 home, `HOME`, config, session, and daemon roots; exercise version/handshake and all behavior that does not require current-host credentials. Missing authentication is an expected setup-required result, not a reason to borrow live stores.
- **Explicit-permission authenticated lane:** only after the reviewer grants permission, run a minimal current-host authenticated smoke using the installed binary and existing credentials read-only. Use T3-created session/resource roots, capture every PID/identity, avoid auth setup or mutation, and report cost-bearing/model-turn prerequisites before execution.

Use the deterministic fake executable for repeatable streaming, tools, interaction, interrupt, crash, multiple-thread, and race coverage that a credential-free real binary cannot guarantee. Update user/internal/operations docs, the compatibility matrix, and a rollout runbook covering staged enablement, rollback, an emergency Prime-only disable that leaves other providers running, drain/stop, redacted diagnostics, orphan warnings, and downgrade preservation. **Exclude** Alpha/Beta claims, live auth mutation, and broad Prime daemon administration.

**Acceptance criteria.** The always-safe lane is runnable in CI/review without secrets and proves isolation, compatibility classification, setup-required behavior, exact resource manifests, and cleanup. The authenticated lane is never implicit and, when permitted, proves a minimal real model turn plus supported control paths without modifying auth/session/daemon/T3 userdata outside T3-owned temporary roots. Fake-peer and real-binary evidence together cover P-MVP outcomes 1–6; every artifact is redacted. Rollout and rollback can disable/drain only `prime-agent`, preserve settings and unknown/newer fields for downgrade/re-enable, diagnose failures without content/secrets/host paths, and leave unproved orphans intact with actionable warnings. All clients have focused coverage and approved visual evidence; docs mark only MVP as shipped (U development section and MVP checklists).

**Expected components.** `apps/server/integration/primeAgent.integration.test.ts`, deterministic fake executable helpers, isolated and permission-gated test entry points, `docs/user/providers/prime-agent.md` (or repository-conventional location), `docs/internals/providers.md`, Prime RPC/compatibility documentation, `docs/operations/` rollout/rollback/recovery runbook, and glossary updates as needed. Update `docs/usage.md` status carefully without erasing future-phase contract.

**Review artifact.** Separate reports for the isolated and authenticated lanes. Each contains the test result, redacted spawn/resource manifest, compatibility result, canonical transcript hashes rather than content, cleanup outcome, and UI evidence links. The authenticated report records the permission and prerequisite used; browser/simulator steps remain separately permission-gated.

**Focused verification.** Always-safe: set `PRIME_AGENT_BIN=$(command -v prime-agent)` and test-specific temporary roots, then run the isolated integration test only. Authenticated: run the separately named current-host lane only after explicit permission. Also run `vp test run packages/contracts/src/providerRuntime.test.ts apps/web/src/providerInstances.test.ts apps/mobile/src/features/threads/prime-provider.test.tsx` and targeted server/contracts/web/mobile typechecks.

**Migration/compatibility.** Gate 0.7.2 fixtures and minimum-version behavior. Unknown newer versions remain advisory only after probes. Rollback and downgrade preserve Prime settings, opaque unknown fields, and owned-resource records as unavailable/read-only data rather than crashing or deleting them. No resume promise.

**Applicability.** Clients: web/desktop/mobile integrated. Providers: existing providers smoke-regressed; emergency controls target Prime only. Contracts: end-to-end. Reverse states: all MVP recovery/cleanup actions plus disable/re-enable and drain. Connections: simulated/local plus relay/tunnel contract paths; real UI/remote passes require permission. Performance: report bounded event/byte/coalescing totals. Security/privacy: lane separation, isolation, permission, and redaction audited. Lifecycle: exact ownership, stale recovery, orphan warning, drain, and cleanup gate. Docs: MVP graduates; Alpha/Beta remain explicitly proposed.

## Alpha — richer Prime-native capabilities

Alpha tasks are capability-gated. An older compatible Prime version must retain the complete MVP and see a disabled action with an explanation. Each task must add both web/desktop and mobile presentation unless explicitly called out, and must not expose broad daemon administration.

### PA-A01 — Capability negotiation and provider-neutral Alpha operation contracts (Alpha)

**Objective.** Add the minimum typed command/state surface on which independently shippable Alpha features can rely.

**Scope.** Define capability flags and generic operations/state for queued actions, context/compaction, commands, richer interactions, observation/tasks, owned goals/heartbeats, naming/forking, usage/retry; extend adapter/service/reactor interfaces only where the concept is provider-neutral. **Exclude** feature implementations and raw Prime command passthrough.

**Acceptance criteria.** Every Alpha action is capability-gated, has typed success/failure/current-state/reverse-state representation, and older payloads decode; no `prime.*` side-channel bypasses orchestration (P-Alpha outcomes 1–3; U10–U16).

**Expected components.** Contracts, adapter capabilities, orchestration command/event schemas, projector tests, client-runtime reducers/helpers.

**Review artifact.** Encode/decode matrix showing old server/client, MVP-only Prime, and Alpha-capable Prime snapshots.

**Focused verification.** `vp test run packages/contracts/src/providerRuntime.test.ts packages/contracts/src/orchestration.test.ts apps/server/src/orchestration/commandInvariants.test.ts packages/client-runtime/src/prime-capabilities.test.ts`; targeted contracts/server/client-runtime typechecks.

**Migration/compatibility.** All additions optional/forward-compatible; persisted unknown capabilities ignored. No Alpha feature may become required for MVP readiness.

**Applicability.** Clients: shared contracts for all, UI later. Providers: Prime supports; others explicitly unsupported unless naturally mapped. Contracts: yes. Reverse states: mandatory schema for each action. Connections: same typed wire. Performance: compact capability/state snapshots. Security/privacy: no native payload/text in analytics. Lifecycle: ownership IDs opaque. Docs: Alpha architecture remains proposed.

### PA-A02 — Steering and queued follow-up with visible cancellation (Alpha)

**Objective.** Let users deliberately steer the running turn or queue work after it, with synchronized state and a reverse action.

**Scope.** Map Prime `steer`, `follow_up`, and `session_action_update`; present mode choice, ordered pending actions, active action, and removal/cancellation where Prime permits (otherwise truthful abort/clear semantics). Integrate web composer, command palette if appropriate, and mobile composer/action sheet. **Exclude** schedules/heartbeats.

**Acceptance criteria.** Running-turn send never guesses behavior; queued actions synchronize across clients, visibly progress/disappear, and can be cancelled by the supported scoped operation; version lacking capability leaves MVP prompt behavior intact with explanation (P-Alpha 1–3; U10).

**Expected components.** Prime adapter command/state mapping, orchestration/projector state, web composer/queue UI, mobile queue UI, tests.

**Review artifact.** Scripted two-client transcript plus before/after screenshots and, because timing is material, a short video; exact permission-gated web/mobile launch scenarios.

**Focused verification.** `vp test run apps/server/src/provider/Layers/PrimeAdapter.queue.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.activity.test.ts apps/web/src/components/chat/prime-queue.test.tsx apps/mobile/src/features/threads/prime-queue.test.tsx`; targeted server/web/mobile typechecks.

**Migration/compatibility.** Queue state is additive/ephemeral; old clients see normal running state, not duplicate messages. Capability gates older Prime.

**Applicability.** Clients: all. Providers: Prime yes; others unsupported unless existing semantic match. Contracts: A01. Reverse states: remove/cancel/abort and visible resolution. Connections: multi-device conflict-authoritative server state. Performance: bounded queue, coalesced updates. Security/privacy: queued text not telemetry/logged. Lifecycle: dies/terminalizes with owned session. Docs: U10 graduates when task ships.

### PA-A02.1 — PA-A02 review-debt cleanup (Alpha)

**Objective.** Retire the accepted non-blocker findings from PA-A02's four review rounds before they compound into later milestones.

**Scope.** (1) Derive cancellation copy from the negotiated `followUpCancel` capability instead of hard-coded text on web and mobile. (2) Surface `primeSendDecision.reason` inline in the web composer while typing (mobile parity). (3) Apply disabled styling to disabled mobile runtime-action buttons. (4) Render `PrimeActionState.active` in `renderPrimeQueue` on both clients. (5) Add a regression test for the invalid-runtime-action-ID fail-closed path asserting the "identifier is invalid" failure activity without text leakage. (6) Make the runnable artifact's two-client convergence assertion falsifiable by deriving each client's projection independently, and add a genuine two-client convergence test through the read model. (7) Coalesce byte-identical consecutive `session_action_update` snapshots so they do not produce duplicate durable events and projection writes. (8) On startup/recovery, clear or mark stale `action_state_json` on sessions whose provider process no longer exists, so dead queues are never displayed. (9) Document the interrupt handler's optimistic action-state clear as an explicit exception to the authoritative-snapshot invariant at its call site. (10) Add a guard or warning comment on the writer-less `"orchestration"` log stream noting `thread.session-set` payloads would carry unredacted action text if a writer is ever attached. (11) Capture the permission-gated visual evidence for the PA-A02 runtime-action panel once UI launch is approved. **Exclude** all new Prime capabilities (A03+ scope) and any change to the handoff or snapshot contract semantics.

**Acceptance criteria.** Every listed item is closed or explicitly re-accepted with rationale; all PA-A02 behavior tests keep passing; no new typecheck diagnostics; capability copy and controls remain independently truthful (P-Alpha 1–3; U10).

**Expected components.** Web/mobile composer and queue rendering, runtime ingestion coalescing and recovery, reactor test coverage, artifact fixture, docs.

**Review artifact.** Updated `packages/contracts/fixtures/pa-a02-prime-runtime-transcript.mjs` whose convergence check can fail, plus before/after screenshots of the runtime-action panel when UI-launch permission is granted (otherwise exact launch instructions and truthful pending status).

**Focused verification.** `vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/web/src/components/prime-queue.test.ts apps/mobile/src/features/threads/prime-queue.test.ts packages/contracts/src/providerCapabilities.test.ts`; `node packages/contracts/fixtures/pa-a02-prime-runtime-transcript.mjs`; targeted web/mobile/server typechecks with attribution against the recorded baseline.

**Migration/compatibility.** No schema changes; coalescing is write-path-only and replay-safe; recovery marking must not alter healthy running sessions.

**Applicability.** Clients: all. Providers: Prime only. Contracts: A01/A02 unchanged. Reverse states: unchanged. Connections: multi-device unchanged. Performance: fewer duplicate writes. Security/privacy: closes the orchestration-stream latent gap and tests the fail-closed ID path. Lifecycle: adds dead-session queue clearing. Docs: status doc debt list retired.

### PA-A03 — Context usage, compaction, retry, and bounded status UI (Alpha)

**Objective.** Expose honest context/usage and manual compaction/retry controls without conflating them with T3 checkpoints.

**Scope.** Map `get_session_stats`, token usage, compaction/retry events, `compact`, auto-compaction/auto-retry state if approved by capability, and abort/retry actions. Add web/mobile context and transient activity UI. **Exclude** refinement and checkpoint semantics changes.

**Acceptance criteria.** Current context/compaction/retry state is visible with bounded update frequency; manual compaction shows success/failure/retry and has cancel/abort where supported; UI explicitly distinguishes compaction from checkpoint/revert (P-Alpha 1–3; U11; U7).

**Expected components.** Prime normalizer/operations, generic usage/activity projection, web/mobile status controls, tests.

**Review artifact.** Golden event/state transcript for manual/automatic/failure/abort plus before/after screenshots; no continuous animation.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeCompaction.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.activity.test.ts apps/web/src/components/chat/prime-context.test.tsx apps/mobile/src/features/threads/prime-context.test.tsx`; targeted typechecks.

**Migration/compatibility.** Null post-compaction usage is valid. Older versions omit controls. Existing token usage fields remain decodable.

**Applicability.** Clients: all. Providers: Prime; generic usage can benefit others without requiring them. Contracts: A01/additive. Reverse states: abort retry/cancel when supported, retry failure. Connections: canonical summary only. Performance: sample/coalesce; no repaint loop. Security/privacy: usage metadata only. Lifecycle: commands tied to owned live session. Docs: U11 and relevant privacy notes graduate.

### PA-A04 — Prime commands, skills, and prompt templates (Alpha)

**Objective.** Surface eligible `get_commands` results through existing T3 command/composer affordances with clear origin.

**Scope.** Discover/cache extension commands, prompts, and skills; filter TUI-only/unsafe entries; map names/descriptions/source/location without exposing absolute source paths; invoke via normal prompt; add web command palette/composer and mobile command sheet. **Exclude** arbitrary JSON-RPC console and command file editing.

**Acceptance criteria.** Eligible commands are labeled Prime + source, searchable, capability-gated, and invoke correctly; stale/removed commands fail actionably; TUI-only commands never appear; remote clients receive no absolute host path (P-Alpha 1–3; U12; U23).

**Expected components.** Prime discovery mapper/cache, server snapshot or generic command contracts, web/mobile command surfaces, tests.

**Review artifact.** Isolated fixture extension/skill/prompt directory, discovery output, invocation transcript, and UI before/after screenshots.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeCommands.test.ts apps/web/src/components/CommandPalette.test.tsx apps/mobile/src/features/threads/prime-commands.test.tsx`; targeted typechecks.

**Migration/compatibility.** Command source/location fields additive; absent capability hides feature. Cache invalidation bounded and explicit.

**Applicability.** Clients: all. Providers: Prime origin, existing provider commands unchanged. Contracts: command metadata may extend generically. Reverse states: close palette; failed/removed invocation leaves composer usable. Connections: discovery on host, sanitized metadata on wire. Performance: cached, not per render. Security/privacy: paths/content omitted from analytics. Lifecycle: cache instance-scoped. Docs: U12 graduates.

### PA-A05 — Rich extension UI and transient status integration (Alpha)

**Objective.** Support the full approved representable extension UI remotely without transcript spam.

**Scope.** Complete typed select/confirm/input/editor dialogs and cancellation; map notify/status/title/widget/editor-text operations into bounded transient provider-neutral UI where representable; define fallback/cancellation for unsupported methods; support web/desktop/mobile. **Exclude** custom TUI components/themes and raw extension console.

**Acceptance criteria.** Each dialog has visible pending/resolved/cancelled state and works remotely; fire-and-forget status is bounded and dismissible/replaced; unsupported methods never hang; timeouts resolve truthfully (P-Alpha 1–3; U13).

**Expected components.** Prime interaction mapper, request/projector contracts, web/modal/status UI, mobile modal/status UI, tests.

**Review artifact.** Fixture extension exercising every method, two-client transcript, before/after screenshots, exact launch instructions.

**Focused verification.** `vp test run apps/server/src/provider/Layers/PrimeAdapter.extension-ui.test.ts apps/web/src/components/chat/prime-extension-ui.test.tsx apps/mobile/src/features/threads/prime-extension-ui.test.tsx`; targeted typechecks.

**Migration/compatibility.** Unknown UI methods safe-cancel or ignore per blocking semantics. Older clients can still resolve MVP-representable requests.

**Applicability.** Clients: all. Providers: Prime only initially. Contracts: typed generic interactions/status. Reverse states: cancel/close/clear/replace. Connections: T3 auth controls responders; resolution conflicts typed. Performance: bounded widgets/status and no transcript flood. Security/privacy: sanitize content and omit telemetry. Lifecycle: pending dialogs cancel on stop. Docs: U13 graduates.

### PA-A06 — Subagents, observation, and Agents-surface controls (Alpha)

**Objective.** Represent Prime root/subagent work in the existing Agents surface without duplicating output into the main timeline.

**Scope.** Map stable active-session identities, task/agent lifecycle and `observe`/`unobserve`; scope inspect/stop to T3-owned or explicitly adopted identities; add web/desktop and mobile view/control paths. **Exclude** arbitrary daemon-session browsing and broad shutdown.

**Acceptance criteria.** Agents have stable identity/state/output, observation can start and stop, main transcript is not flooded, unauthorized/unowned target actions fail, and multi-client views converge (P-Alpha 1–3; U14; U22–U23).

**Expected components.** Prime task/observation mapper, generic Agents contracts/projectors, existing web Agents surface, mobile equivalent, ownership authorization tests.

**Review artifact.** Scripted root + two subagents fixture, observed event transcript, ownership-negative test, screenshots of agent list/detail/reverse controls.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeObservation.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.activity.test.ts apps/web/src/components/agents/prime-agents.test.tsx apps/mobile/src/features/threads/prime-agents.test.tsx`; targeted typechecks.

**Migration/compatibility.** Opaque native IDs remain adapter-owned; projected task state additive. Versions without observation show disabled explanation.

**Applicability.** Clients: all. Providers: Prime mapping; Agents surface remains generic. Contracts: tasks/observation additions if existing ones insufficient. Reverse states: unobserve/stop/close detail. Connections: remote authorization and multi-device tested. Performance: bounded observation streams, no duplication. Security/privacy: output only to authorized thread viewers; no cross-daemon enumeration. Lifecycle: ownership checked on every action. Docs: U14 graduates.

### PA-A07 — Owned goals and heartbeats with daemon-promotion disclosure (Alpha)

**Objective.** Add goals and heartbeats only with exact resident-resource ownership and complete reverse controls.

**Scope.** Map current goal state and T3-created heartbeat create/get/pause/resume/stop; disclose that creation may promote to a resident daemon session; persist minimal ownership handles; add web/mobile state and confirmations. **Exclude** arbitrary schedules, global heartbeat lists/admin, and unowned resources.

**Acceptance criteria.** Create shows daemon consequence; current state survives client reconnect; pause/resume/stop are always reachable and target only owned identity; failure/unknown ownership leaves resource alone with guidance; multi-device conflicts resolve server-side (P-Alpha 1–3; U15; U22).

**Expected components.** Prime RPC operations, ownership extension, provider-neutral goal/heartbeat contracts/projector, web/mobile controls, tests.

**Review artifact.** Isolated daemon-root scenario with create/pause/resume/stop and unrelated heartbeat sentinel; screenshots/confirmation copy. Never use live daemon state.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeGoalsHeartbeats.test.ts apps/server/src/provider/prime/PrimeOwnership.test.ts apps/web/src/components/chat/prime-heartbeat.test.tsx apps/mobile/src/features/threads/prime-heartbeat.test.tsx`; targeted typechecks.

**Migration/compatibility.** Ownership metadata versioned separately from Beta resume cursor. Unknown versions become unavailable, never globally cleaned. Capability-gated.

**Applicability.** Clients: all. Providers: Prime only initially. Contracts: typed goal/heartbeat state/actions. Reverse states: pause/resume/stop/clear as supported. Connections: remote controls operate on host. Performance: event/state changes, no polling. Security/privacy: goal/prompt text not analytics; scoped auth. Lifecycle: central, resident daemon ownership exact. Docs: U15 and operations daemon cleanup graduate.

### PA-A08 — Session naming/fork affordances and Alpha phase integration/docs (Alpha)

**Objective.** Add non-durable Prime naming/forking consistently with T3 ancestry, then gate the entire Alpha phase.

**Scope.** Map `set_session_name`, eligible `get_fork_messages`, `fork`/`clone`; create deliberate T3 thread ancestry/checkpoint semantics; expose web/mobile rename/fork/reverse navigation; run integrated Alpha capability/version/multi-client tests and graduate shipped Alpha docs. **Exclude** cross-restart exact resume and destructive deletion.

**Acceptance criteria.** Rename/fork results stay consistent between Prime identity, T3 thread ancestry, and checkpoints; cancelled fork has no half-created thread; UI never labels this durable resume; older Prime retains MVP with each Alpha feature disabled/explained; all Alpha controls have reverse state and remote parity (P-Alpha outcomes 1–3; U10–U16).

**Expected components.** Prime session operations, orchestration thread ancestry integration, web/mobile affordances, integrated Alpha tests, user/internal/operations docs.

**Review artifact.** Parent/fork canonical transcript and checkpoint graph, before/after web/mobile screenshots, full Alpha manual checklist and capability-negative fixture.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeFork.test.ts apps/server/integration/primeAgentAlpha.integration.test.ts apps/web/src/components/chat/prime-fork.test.tsx apps/mobile/src/features/threads/prime-fork.test.tsx`; targeted server/contracts/web/mobile typechecks.

**Migration/compatibility.** Fork metadata additive and readable without Prime. No resume cursor created. Capability matrix per operation.

**Applicability.** Clients: all. Providers: Prime native operations; generic ancestry unchanged. Contracts: typed thread operation/state. Reverse states: cancel fork, navigate/archive resulting thread, rename again. Connections: server-authoritative multi-device. Performance: messages for fork choices paged/bounded. Security/privacy: do not expose session file paths/transcripts beyond authorized projected history. Lifecycle: new owned session/thread handle. Docs: shipped Alpha features graduate; unshipped candidates and Beta remain proposed.

## Beta — durable session loading, arbitration, and recovery

### PA-B01 — Versioned resume cursor and scoped durable storage policy (Beta)

**Objective.** Define the minimum persistent identity and migration boundary before any session is activated or resumed.

**Scope.** Add an opaque versioned cursor binding environment, provider instance, project/workspace identity, Prime session identity/path token, ownership generation, compatibility metadata, and lifecycle state; define T3-home storage, permissions, backup, retention, and downgrade preservation. Build a migration fixture matrix spanning no-Prime data, MVP/Alpha data, each supported cursor version, corrupt/partial rows, unknown future versions, interrupted migration, rollback, and two T3 homes. **Exclude** raw transcript copying, settings/telemetry content, and actual adoption.

**Acceptance criteria.** A cursor cannot be confused across environment/instance/project/user; future or corrupt versions become readable unavailable state rather than a crash; interrupted migration is atomic/idempotent; rollback preserves opaque unknown data; raw prompt/transcript/model output is absent; storage is T3-scoped and documented (P-Beta outcomes 1–4; U17, U20, U23).

**Expected components.** Contracts/persistence schema migration, Prime cursor codec/storage, versioned migration fixtures, and two-home isolation tests.

**Review artifact.** Encode/decode/redaction and migration matrix report for old/new/corrupt/future/cross-environment/two-home cases, with no content or host paths.

**Focused verification.** `vp test run packages/contracts/src/primeResume.test.ts apps/server/src/provider/prime/PrimeResumeCursor.test.ts apps/server/src/persistence/migrations/prime-resume.test.ts`; targeted contracts/server typechecks.

**Migration/compatibility.** MVP/Alpha records remain readable. Migration is additive/atomic where possible, creates a backup per repository convention before destructive steps, and never deletes unknown cursor versions. B03's lease schema must be present before B02 may activate a cursor.

**Applicability.** Clients: coarse unavailable state only until B04. Providers: Prime. Contracts: cursor/state is opaque and additive. Reverse states: rollback/invalidate later. Connections: environment-scoped host storage. Performance: indexed lookup, no global scans. Security/privacy: restrictive permissions and redacted diagnostics. Lifecycle: storage policy only; no activation. Docs: storage/migration operations draft.

### PA-B02 — Exact adoption/resume state machine and compatibility validation (Beta)

**Objective.** Recover the exact durable Prime session without ever activating it outside PA-B03's authoritative single-writer lease.

**Scope.** After restart/process loss, validate cursor, instance, workspace, storage, version/capabilities, ownership generation, and PA-B03 lease/fence; adopt a provably still-live owned active session or launch scoped RPC and `switch_session`; reconcile state/messages without duplicating the T3 transcript; publish reconnecting/resumed/unavailable states. Activation or prompt acceptance must acquire and revalidate the B03 lease. **Exclude** user recovery UI.

**Acceptance criteria.** Graceful server restart, abrupt child loss, disable/re-enable, and supported binary upgrade resume the exact session; mismatch/missing/incompatible/unauthorized/conflicted state never silently starts fresh; no prompt is accepted before lease acquisition; repeated recovery is idempotent (P-Beta outcomes 1–2; U17, U21).

**Expected components.** Prime resume coordinator/state machine, B01 cursor and M06 ownership integration, B03 lease integration, adapter bootstrap changes, crash/restart/race fixtures.

**Review artifact.** Barrier-controlled restart/adoption report containing session identity and projected transcript hashes before/after, with no content.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeResumeCoordinator.test.ts apps/server/integration/primeAgentResume.integration.test.ts apps/server/integration/primeAgentResumeRace.integration.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** B01 migration and B03 arbitration land first. Compatibility changes mark unavailable with guidance. Never fall back to a new session or ACP.

**Applicability.** Clients: coarse states until B04. Providers: Prime. Contracts: B01/B03 state. Reverse states: retry/invalidate/fork/fresh later; stop remains non-destructive. Connections: host performs resume under server authorization. Performance: one bounded validation, no transcript copy. Security/privacy: canonical-path, ownership, authorization, and fence validation; no cross-environment adoption. Lifecycle: exact adopt-or-launch ownership transfer under lease.

### PA-B03 — Server-side single-writer arbitration and turn conflict receipts (Beta)

**Objective.** Prevent two clients or processes from becoming authoritative writers for one durable session, and make this gate precede B02 activation.

**Scope.** Add a server-side lease/generation keyed by durable thread/session, authorization-before-acquire, acquire/release/fencing, crash expiry/recovery, and typed conflict receipts. Wire the lease into resume activation, send, worker/turn ownership, stop, crash, and provider-instance removal. Use barrier-controlled multi-client and multi-process fixtures; never use sleeps. **Exclude** client recovery-choice UI (B04), retention/deletion policy (B05), and any distributed lock outside one T3 environment.

**Acceptance criteria.** At most one writer can activate or send; a stale owner cannot commit after fencing; unauthorized clients cannot acquire or infer owner identity; crash/restart produces a deterministic recoverable lease state; one client receives the authoritative result and others a typed retryable conflict (P-Beta outcomes 1–3; U17–U19).

**Expected components.** Generic lease/receipt contracts where useful, Prime session lease service, persistence integration, provider reactor wiring, and race fixtures.

**Review artifact.** Deterministic two-client/two-process race trace proving one activation/send, fenced stale completion rejection, and redacted conflict receipts.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeSessionLease.test.ts apps/server/integration/primeAgentResumeRace.integration.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`; targeted contracts/server typechecks.

**Migration/compatibility.** Conflict errors are additive and forward-compatible. Lease schema is introduced by/with B01 before B02 activation. Existing non-resumable sessions retain current behavior.

**Applicability.** Clients: all receive a generic conflict. Providers: generic where useful, Prime first adopter. Contracts: typed receipt/error. Reverse states: retry after authoritative turn/release. Connections: critical for relay/tunnel/multi-device. Performance: O(1) lock/fence, no polling. Security/privacy: authorization before lease and opaque owner data. Lifecycle: lease ownership, expiry, release, and fencing explicit.

### PA-B04 — Web/desktop/mobile resume and recovery-choice UI (Beta)

**Objective.** Present truthful continuity and explicit retry/fork/new-session recovery on every client.

**Scope.** Render reconnecting, resumed, unavailable, incompatible, missing, conflict, and fork-required states; block composer until outcome; provide retry, fork, and fresh-session choices with confirmation; preserve readable history/checkpoints; cover command palette/keybindings where generic. **Exclude** destructive durable deletion.

**Acceptance criteria.** No failed resume silently becomes a fresh conversation; all three clients can understand and reverse/recover; two-device conflict identifies authoritative state without leaking identity; archive/stop copy is non-destructive (P-Beta outcomes 1–4; U17–U20).

**Expected components.** Client-runtime resume state reducer, web thread/composer/recovery dialog, mobile equivalents, desktop reuse, tests.

**Review artifact.** Before/after web/desktop/mobile screenshots for every state and a short reconnect/conflict video; exact permission-gated seeded launch instructions.

**Focused verification.** `vp test run packages/client-runtime/src/prime-resume.test.ts apps/web/src/components/chat/prime-resume.test.tsx apps/mobile/src/features/threads/prime-resume.test.tsx`; targeted client-runtime/web/mobile typechecks.

**Migration/compatibility.** Older clients see provider unavailable rather than sending into unresolved resume. Older servers simply lack durable states. Cursor remains server-only.

**Applicability.** Clients: all. Providers: Prime UI behind generic recovery state; others unchanged. Contracts: B01/B03. Reverse states: retry/fork/fresh/cancel; stop/archive non-delete. Connections: multi-device and remote central. Performance: state transitions only, no polling animation. Security/privacy: opaque/coarse state, no session path/ID. Lifecycle: UI never owns resource. Docs: screenshots retained; graduation B06.

### PA-B05 — Durable cleanup, retention, migrations, and rollback safety (Beta)

**Objective.** Make every destructive durable lifecycle path scoped, crash-safe, resumable, and reversible where data preservation permits.

**Scope.** Implement retention/backup-aware cleanup for explicit delete, provider removal, reconfiguration, and migration; coordinate with B02 adoption and B03 leases so active/adopting resources cannot be deleted. Add journaled/idempotent cleanup that resumes after a crash, proof-before-action manifests, and `prime-agent`-specific staged rollout/rollback behavior. Cover races among cleanup, resume/adoption, provider removal, server crash, and deletion. Never translate stop/archive into durable deletion or invoke Prime-global cleanup. **Exclude** broad Prime daemon/session administration, deletion of resources without exact T3 ownership proof, and redesign of generic T3 archival semantics.

**Acceptance criteria.** Stop/archive preserve history/session; provider removal and explicit deletion require scoped confirmation and refuse or defer while a valid lease/adoption exists; a crash at every cleanup checkpoint resumes idempotently; rollback/downgrade preserves unknown cursor/settings/ownership data; other T3 homes/environments and unrelated Prime resources survive; partial failure yields a redacted actionable report (P-Beta outcome 4; U20–U23).

**Expected components.** Prime durable resource manager, cleanup journal/manifests, persistence migrations, provider-removal lifecycle, rollout/rollback hooks, operations tooling/docs, and multi-environment crash/race fixtures.

**Review artifact.** Dry-run then destructive run against a disposable two-home tree containing owned/unowned sentinels, with barrier-controlled cleanup-vs-resume/removal/deletion crash points and a rollback decode report.

**Focused verification.** `vp test run apps/server/src/provider/prime/PrimeDurableCleanup.test.ts apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts apps/server/src/persistence/migrations/prime-resume.test.ts apps/server/integration/primeAgentResumeRace.integration.test.ts`; `vp run --filter t3 typecheck`.

**Migration/compatibility.** Explicit schema/journal versions; backups before destructive migration where repository conventions support it; old builds preserve opaque unknown cursor and ownership records. Staged rollout can disable only `prime-agent`; rollback does not delete durable resources. No automatic global scan.

**Applicability.** Clients: coarse cleanup result/confirmation on applicable admin surfaces; mobile remains view/recovery unless environment administration already exists. Providers: Prime. Contracts: additive cleanup result if user-visible. Reverse states: dry-run/cancel; irreversible delete only after confirmation. Connections: environment host executes. Performance: scope-indexed paths and bounded manifests. Security/privacy: paths withheld remotely and diagnostics redacted. Lifecycle: central. Docs: operations retention, crash recovery, rollout, and rollback.

### PA-B06 — Full Beta recovery matrix, remote integration gate, and documentation graduation (Beta)

**Objective.** Prove durable continuity across supported lifecycle and connection scenarios and publish only behavior that passed.

**Scope.** Run isolated real-binary recovery matrix: graceful/abrupt child exit, server restart, disable/re-enable, compatible upgrade, missing/incompatible binary, multiple environments on one host, multiple clients/race, exact resume, retry/fork/fresh, stop/archive/cleanup. Include canonical wire/client contract tests, performance/security review, and shipped user/internal/operations docs. **Exclude** broad daemon admin and any capability not completed in earlier tasks.

**Acceptance criteria.** All P-Beta outcomes 1–4 and U17–U23 are demonstrated; one writer only; no silent fresh session; other environments/unrelated Prime resources survive; future cursor rollback is safe; web/desktop/mobile evidence is complete; MVP/Alpha still work on capability-limited versions.

**Expected components.** `apps/server/integration/primeAgentBeta.integration.test.ts`, barrier/restart harness, web/mobile integrated scenario tests, compatibility/storage/operations/user docs, `docs/usage.md` phase status update.

**Review artifact.** Redacted Beta certification bundle: version matrix, scenario results, spawn/ownership manifests, cursor-state hashes, performance counts, and before/after UI evidence. Exact real-binary command uses `PRIME_AGENT_BIN=$(command -v prime-agent)` and test-created temp roots only; UI execution remains permission-gated.

**Focused verification.** `PRIME_AGENT_BIN=$(command -v prime-agent) vp test run apps/server/integration/primeAgentBeta.integration.test.ts`; focused contract/server/web/mobile tests named in B01–B05; targeted package typechecks only.

**Migration/compatibility.** Verify upgrade and rollback paths explicitly, including 0.7.2 baseline and unknown-newer probe gates. Beta cursor versions remain unavailable-not-corrupt on old builds.

**Applicability.** Clients: web/desktop/mobile complete. Providers: Prime plus focused non-Prime regression. Contracts: end-to-end. Reverse states: every resume/recovery/cleanup action. Connections: local, desktop-hosted, LAN/tailnet, relay, tunnel, multi-device; use simulated wire paths unless browser permission is granted. Performance: bounded recovery and event/byte report. Security/privacy: isolation, authorization, redaction, no content telemetry. Lifecycle: complete ownership/adoption/cleanup proof. Docs: Beta graduates to shipped; proposed warnings removed only for behavior actually certified.

## Phase gates and review order

1. Execute the acyclic dependency graph in `docs/task-dependencies.md`, sequentially by default. Numeric IDs remain stable labels, not a mandate to run numerically.
2. MVP foundation order is `PA-M01`, `PA-M02`, `PA-M04`, `PA-M03`, `PA-M06`, then `PA-M05`: settings identity must exist before ownership layout, and ownership/resource layout must exist before any probe spawns. `PA-M07`–`PA-M12` complete server behavior; `PA-M13`–`PA-M15` integrate clients; `PA-M16` is the only MVP graduation gate.
3. Alpha starts only after `PA-M16`. `PA-A01` precedes each capability. The graph permits some Alpha concurrency, but merges remain sequential by default to reduce contract conflicts. `PA-A08` integrates and graduates Alpha.
4. Beta starts only after `PA-A08` and a maintainer decision that session identity/storage semantics are stable. `PA-B01` defines cursor and lease persistence; `PA-B03` arbitration lands before `PA-B02` may activate/adopt a session. `PA-B04` and non-destructive B05 work follow the stable resume/arbitration slice; all B05 crash-race and rollback proof precedes `PA-B06`.
5. Every task is mergeable only with its independent artifact/instructions and focused automated proof. User-visible changes also need before/after evidence, or explicit permission-blocked capture instructions, and both black-box product and code review on the same commit.
6. Every task's tests use disposable T3 homes and captured child identities. They must not write live T3 userdata, Prime auth/session stores, or daemon state; destructive behavior is exercised only against task-created fixtures. Browser/simulator and authenticated current-host lanes require explicit permission.
7. A material change to phase scope, client responsibility, resource ownership, attachment/interaction kinds, or approved usage requires documentation reconciliation before implementation continues. Top-level IDs stay the 30 IDs in this plan unless maintainers explicitly approve a scope split.
