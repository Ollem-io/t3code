# Prime Agent provider integration product contract

> Status: proposed product contract. This document defines the intended product and release phases; it does not claim the integration is implemented.

## Summary

T3 Code will ship Prime Agent as a polished, built-in provider backed by Prime Agent's dedicated subprocess RPC protocol. A user who already uses Prime Agent on the machine hosting their T3 environment should be able to select **Prime Agent**, choose one of that installation's configured models, and run a normal T3 thread without learning a second integration model.

The integration is deliberately phased. The MVP establishes a reliable first-party provider and the protocol/lifecycle foundation. Alpha adds Prime-native capabilities where T3 can present them honestly. Beta adds durable Prime session loading and resume after the ownership, recovery, and multi-device behavior are proven.

ACP is not the product runtime for this integration. Prime Agent's ACP surface intentionally omits authentication, session loading, and model discovery, while its dedicated RPC mode exposes the lifecycle and native operations needed for a first-party experience.

## Problem

Prime Agent users can run a capable coding-agent runtime from a terminal, but cannot currently select it as a supported provider in T3 Code. A thin terminal wrapper or generic ACP bridge would leave important gaps: model discovery, session continuity, rich task state, interactive requests, and exact process ownership would either be missing or presented inconsistently with T3's other providers.

The product needs one provider experience that:

- feels native in T3's provider picker, composer, timeline, settings, and lifecycle;
- preserves T3's provider-neutral orchestration rather than introducing Prime-specific behavior into clients or the decider;
- uses the protocol Prime Agent actually exposes for embedding;
- works when the client is remote from the server host;
- does not copy credentials, leak secrets, or interfere with Prime Agent sessions outside T3;
- creates a stable base for richer Prime capabilities and durable resume without rushing either into the MVP.

## Intended users

- Existing Prime Agent users who want T3 Code's web, desktop, or mobile interface around the Prime runtime and models already configured on the T3 server host.
- T3 users evaluating Prime Agent as another first-party provider.
- Teams and individuals who connect remotely to a T3 environment and need the provider to execute on that environment's host, not on the client device.
- Maintainers who need a typed, observable adapter boundary that can track Prime Agent protocol evolution safely.

## Goals

1. Ship Prime Agent as a built-in, instance-first T3 provider using `prime-agent --mode rpc` and the normal `ProviderAdapterShape` / `ProviderRuntimeEvent` path.
2. Match the core supported-provider experience in the MVP: installation and health status, ambient-auth status, model discovery and selection, thread turns, streamed output, tools, interruption, errors, session stop, and normal T3 checkpoints.
3. Make local, relay/tailnet, tunnel, desktop-hosted, and multi-device use behave consistently because all Prime execution and credentials remain on the selected T3 environment.
4. Preserve performance by normalizing once at the server adapter boundary, bounding protocol buffers and logs, and sending only canonical state needed by clients.
5. Own lifecycle precisely: T3 may stop only the subprocesses and Prime session resources it created or explicitly adopted, never unrelated Prime daemons, workers, or terminal sessions.
6. Add Prime-native features in Alpha only when T3 can give each feature a clear entry point, visible state, and reverse action.
7. Add durable loading/resume in Beta only after recovery, compatibility, and ownership behavior are deterministic.
8. Provide actionable status, version, and failure information without exposing prompt contents, model output, filesystem data, session transcripts, or credentials through telemetry.

## Non-goals

- Using ACP as the runtime transport for the first-party Prime Agent provider.
- Reimplementing Prime Agent's model providers, authentication, tools, extensions, skills, scheduler, daemon, or session store inside T3.
- Asking users to paste model-provider API keys into T3 for Prime Agent. Prime authentication remains ambient on the server host through Prime Agent's auth store, environment, or Prime CLI setup.
- Managing, shutting down, renaming, or cleaning up arbitrary Prime Agent sessions that T3 did not create or explicitly adopt.
- Making every Prime RPC command available in the MVP.
- Exposing a raw JSON-RPC/JSONL console in the product UI.
- Guaranteeing durable recovery from a Prime session in the MVP or Alpha; that is a Beta contract.
- Moving provider execution or secrets to a remote browser or mobile device.
- Making Prime Agent a hidden implementation of another T3 provider kind. It has its own built-in driver kind and provider presentation.
- Blocking the overall T3 server when Prime Agent is missing, outdated, misconfigured, slow, or unavailable.

## Confirmed foundations

### T3 Code

T3's orchestration is instance-first and provider-neutral. A configured provider instance selects a driver, which builds an adapter conforming to `ProviderAdapterShape`. The server routes thread operations through that adapter, consumes canonical `ProviderRuntimeEvent` values, persists domain events, and projects the read model used by web and mobile. Prime-specific protocol complexity therefore belongs in the Prime driver and adapter, not in the orchestration decider or client timelines.

### Prime Agent 0.7.2 baseline

The design baseline is the installed and documented Prime Agent 0.7.2 RPC surface:

- `prime-agent --mode rpc` uses strict LF-delimited JSONL over stdin/stdout;
- commands may carry request IDs and receive correlated responses while events stream asynchronously;
- prompt, steering, follow-up, abort, state, message, model discovery/switching, thinking level, compaction, session switching/forking, command discovery, extension UI, daemon messaging, observation, schedules, goals, and heartbeats are available in varying degrees;
- a Prime global daemon can supervise per-session workers, and some RPC actions can promote an invocation-local session to a resident daemon session;
- Prime's ACP mode deliberately advertises no session loading and does not provide the authentication or model-discovery surface required here.

This version is a compatibility baseline, not permission to depend on every RPC feature in the MVP.

## Product principles

### Instance-first, environment-local

Prime Agent appears as a normal provider driver and supports configured provider instances. Each instance has its own display identity, binary/configuration, environment overrides, health snapshot, model catalog, and adapter resources. A T3 thread binds to a provider instance, not merely to the `primeAgent` driver kind.

The T3 server host launches Prime Agent with the thread's effective workspace. Web, desktop renderer, and mobile clients issue the same typed T3 commands; none launches Prime Agent directly. A remote user sees host installation/auth/model state and receives canonical events over the existing connection.

### Native protocol, canonical product behavior

The adapter speaks Prime RPC and translates it into existing canonical runtime concepts: session and turn state, assistant/reasoning deltas, tool lifecycle, token usage, requests, tasks, warnings, and errors. Raw Prime payloads may be retained only where T3's bounded debugging policy allows; clients must not require them to render normal behavior.

Prime-specific capabilities may extend contracts when there is a real product concept, but must not bypass orchestration or create an untyped side channel.

### Ambient authentication

T3 reports whether the configured Prime installation appears usable, but does not ingest or display secret values. Setup guidance sends the user to Prime Agent/Prime CLI on the server host when authentication is missing. Provider-instance environment overrides use T3's existing sensitive-value handling and redaction rules.

Health checks must be read-only, bounded, and safe to run alongside unrelated Prime activity. They must not mutate auth stores, log a user out, start broad daemon cleanup, or echo credential-bearing environment variables.

### Exact ownership

T3 records an ownership handle for every Prime process/session resource it creates. Normal stop, provider disable/reconfigure, thread deletion where applicable, server shutdown, and crash recovery act only on those handles.

T3 must never use process-name pattern killing or Prime-wide shutdown as cleanup. If Prime promotes work to its global daemon, T3 may address only the exact T3-owned active-session/worker identity through a scoped Prime operation. A resource that cannot be proven T3-owned is left alone and surfaced as a recoverable cleanup warning rather than terminated speculatively.

## Release phases

## MVP — dedicated RPC adapter and supported-provider core

The MVP is intentionally the smallest complete provider experience, not a showcase for every Prime feature.

### Provider registration and settings

- A built-in `primeAgent` driver is available anywhere T3 lists or configures provider instances.
- The default instance is disabled or unavailable when the binary cannot be found; absence does not degrade other providers.
- Instance settings include at minimum an enabled state, Prime Agent binary path (default `prime-agent`), and optional launch arguments/environment using existing provider-instance conventions.
- Settings show display name, installed version, compatibility state, last check time, authentication/usability state, and an actionable message.
- Refresh/recheck and enable/disable have visible results. Disabling or reconfiguring the instance stops only T3-owned sessions for that instance and makes existing bound threads visibly unavailable until re-enabled or deliberately moved.
- Unsupported or unsafe launch arguments are rejected or ignored with an explicit validation message; T3-owned protocol flags and working-directory/session flags cannot be silently overridden.
- No API-key field is added solely for Prime. Authentication guidance explains that auth must be configured on the environment host through Prime Agent or Prime CLI.

### Models

- The server discovers models from the configured Prime instance through `get_available_models`, rather than shipping a stale hard-coded catalog as the primary source.
- Models are identified by both Prime provider and model ID so equal model IDs from different upstream providers do not collide. T3 shows a readable name and retains enough identity to call `set_model` correctly.
- Model capabilities exposed by Prime, including image and reasoning support, are mapped to T3's model presentation where supported.
- Thinking/reasoning selection uses Prime's supported levels and is validated for the chosen model. Unsupported choices produce a clear error or are omitted; they are never silently claimed.
- Discovery is cached and refreshed with the normal provider health policy. A slow or failed refresh leaves the last known catalog visibly stale when safe, rather than freezing the picker.
- An unavailable previously selected model remains visible as unavailable and requires a deliberate replacement; T3 does not silently route to another model unless Prime itself reports a reroute, which T3 surfaces.
- In-session model switching is enabled only if the adapter can confirm it. Otherwise the UI states that a new thread/session is required.

### Core thread and turn behavior

- Starting a Prime-backed thread launches an exact T3-owned `prime-agent --mode rpc` subprocess with strict LF JSONL framing and the thread's effective workspace.
- The adapter correlates command responses by request ID independently from async events, handles chunk boundaries and optional CR before LF, rejects malformed/oversized records safely, and never uses a parser that splits valid JSON strings at Unicode line separators.
- A normal prompt, text attachment, and supported image attachment reach Prime. Unsupported attachment types fail before the turn with an actionable message rather than being dropped.
- Assistant text, reasoning where allowed by T3 presentation, tool start/progress/completion, errors, and turn completion map into the normal T3 timeline/activity surfaces.
- Tool progress is replacement/delta-normalized so accumulated Prime updates do not cause quadratic websocket traffic or repeated full-message transfer.
- T3 interrupt sends Prime `abort`, transitions the turn to a truthful terminal state, and leaves the thread usable for a later prompt when Prime does.
- T3 session stop closes the owned RPC input gracefully, waits a bounded period, then terminates only the captured child process if required. The UI exits running/waiting state even on abnormal process exit and reports whether retry is possible.
- A Prime extension UI dialog maps to an existing approval/user-input interaction only when semantics are representable. Unsupported dialogs fail visibly or use a safe cancellation; they never hang invisibly.
- T3 checkpoint capture, diff, and revert continue to use T3's existing workspace lifecycle. MVP does not claim that a checkpoint revert rewinds Prime conversation history.
- A second client viewing the same environment sees the same projected thread state and can interrupt/respond according to existing T3 authorization and conflict rules. Duplicate client connections do not spawn duplicate Prime sessions.

### MVP lifecycle and compatibility

- One live adapter session owns at most one Prime RPC process/session for a T3 thread. Concurrent T3 threads remain isolated even if Prime uses a shared daemon internally.
- Startup has a bounded handshake/state probe. Protocol output before readiness, stderr diagnostics, process exit, request timeout, and unknown event types cannot deadlock the provider worker.
- Unknown additive events are logged in bounded/redacted form and ignored or mapped to `runtime.warning`; incompatible response shapes fail that operation without crashing the server.
- The provider snapshot distinguishes at least: missing binary, disabled, checking, ready, authentication/setup required, incompatible version/protocol, and runtime error.
- The release declares a tested Prime version range beginning with 0.7.2. Versions outside it receive a compatibility advisory; known-incompatible versions are blocked from starting sessions with upgrade/downgrade guidance.
- Provider configuration changes use scoped teardown/rebuild. Other provider instances and unrelated Prime sessions remain unaffected.

## Alpha — richer Prime-native integration

Alpha capabilities are feature-flagged or clearly labeled until their interaction and recovery behavior is proven. Each addition requires contracts, web and mobile presentation where applicable, a reverse action, and fallback behavior for older Prime versions.

Candidate Alpha scope:

- **Steer and follow-up:** while a turn runs, users can choose whether a new instruction steers the current run or queues after completion; queued actions are visible, removable/cancellable where Prime permits, and synchronized across clients.
- **Compaction and context state:** show context usage and compaction state, allow manual compaction, and report failure/retry without pretending compaction is a T3 checkpoint.
- **Prime command discovery:** expose eligible Prime skills, prompt templates, and extension commands through T3's composer/command surfaces with origin labels. TUI-only commands are excluded.
- **Richer extension UI:** select, confirm, input, and editor requests map to typed, remotely operable T3 interactions; notify/status updates use bounded transient UI rather than transcript spam.
- **Subagents and observation:** Prime root/subagent activity maps into T3's Agents surface using stable Prime active-session identities. Users can inspect state and output without duplicating it into the main timeline, and stop/observe actions target only authorized T3-owned or explicitly adopted sessions.
- **Goals and heartbeats:** expose goal progress and T3-owned heartbeat controls only after ownership, persistence, scheduling, and multi-device conflict semantics are designed. Creating one makes its resident-daemon consequence explicit; pause/resume/stop and current state are always available.
- **Usage and retry:** show model usage, context window, automatic retry, and compaction lifecycle through canonical state with bounded update frequency.
- **Session naming/fork affordances:** allow Prime-native naming and fork/clone operations when T3 can keep provider session identity, T3 thread ancestry, and checkpoints consistent. These are not yet durable cross-restart resume guarantees.

Alpha does not expose broad daemon administration (`shutdown`, cleanup of all agents) from T3.

## Beta — durable Prime session loading and resume

Beta makes provider conversation continuity a supported, user-visible contract.

- T3 persists an opaque, versioned Prime resume cursor containing only the minimum stable identity needed to reload the correct Prime session; raw transcript content is not copied into general settings or telemetry.
- Prime session storage for T3-created sessions has a documented location and ownership policy. Where configurable, it is scoped below T3 home or another explicit instance setting, not mixed ambiguously with unrelated sessions.
- After server restart or owned subprocess loss, the first operation adopts a still-live T3-owned session or launches Prime and uses supported session switching/loading to restore the exact durable session.
- Recovery validates provider instance, workspace, session identity, and compatibility before sending new work. It never resumes a session from another T3 environment, instance, project, or user merely because an ID resembles the expected one.
- The UI distinguishes reconnecting, resumed, resume unavailable, incompatible session, missing session, and fork required. A failed resume does not silently create a fresh conversation under the old thread.
- Users can explicitly choose a safe recovery action: retry, fork into a new Prime/T3 thread where supported, or start a fresh session. The original projected transcript and checkpoints remain readable.
- Concurrent devices cannot race two Prime workers onto the same durable session. Server-side single-writer arbitration makes one turn authoritative and returns a typed conflict to the loser.
- Session stop and thread archive are not destructive deletion. If permanent deletion is later offered, it requires confirmation, targets only T3-owned session files/resources, and has a visible result.
- Compatibility migrations are versioned and reversible where possible. A newer cursor remains decodable as unavailable by an older T3 build rather than crashing settings or projection loading.
- Recovery is tested across graceful restart, abrupt child exit, server restart, provider disable/re-enable, binary upgrade within the supported range, multiple T3 environments on one host, and multiple clients attached to one environment.

## Surface contract

### Web and desktop

Prime appears in provider-instance settings, add-provider flow, model picker, thread/composer provider status, command palette entries that are provider-neutral or Prime-supported, activity/timeline, and error recovery. The desktop renderer uses the same server contracts; Electron is responsible only for its existing host/server lifecycle and must not create a second Prime process path.

### Mobile

Mobile can select a configured Prime instance/model, create and control threads, view normalized activity, answer supported interactions, interrupt, stop, and see setup/compatibility errors. Host-only setup steps are labeled as such rather than presenting a mobile API-key form. Alpha/Beta controls that cannot fit the mobile surface are still viewable and reversible through an appropriate mobile flow, not silently omitted.

### Remote modes

Local browser, desktop-hosted server, LAN/tailnet, relay, and tunnel use the same T3 wire contracts. Binary checks, auth, filesystem paths, processes, models, and session files always refer to the environment host. No absolute host path, credential, or raw environment value is sent merely to make the client render provider status.

### Documentation

When shipped, user docs cover installation on the environment host, ambient authentication, adding/enabling an instance, choosing models/thinking, normal turns, remote behavior, errors, updates, and cleanup. Maintainer docs cover the RPC mapping, strict framing, ownership, compatibility matrix, event normalization, resume cursor, and test strategy. New Prime-specific vocabulary is added to the internal glossary only where it becomes a durable T3 concept.

## Quality attributes and constraints

### Performance

- Parsing is streaming and bounded by record and buffered-byte limits.
- Request correlation and session lookup are constant-time maps keyed by IDs.
- High-frequency text/tool updates are coalesced or delta-normalized before websocket publication.
- Model discovery and status probes are cached, bounded, cancellable, and never performed per render.
- Raw protocol data is not copied into every canonical event when a compact normalized payload suffices.
- No continuously repainting Prime-specific UI is introduced.

### Reliability

- Every accepted turn reaches a terminal canonical state exactly once from T3's perspective.
- Async events arriving before/after responses, duplicate events, unknown events, late events after abort, and partial final frames have explicit handling.
- Backpressure or one slow remote client cannot block reading Prime stdout and deadlock the child.
- Provider failures are isolated by instance and thread.
- Cleanup is idempotent and bounded.

### Security and privacy

- T3 never reads or transmits more of Prime's auth store than a safe usability probe requires; secret values are never returned to clients.
- Instance environment secrets are redacted in settings responses, diagnostics, logs, analytics, and error messages.
- Prompt text, assistant output, tool arguments/results, file contents/paths, session transcripts, goal text, heartbeat prompts, and agent messages are excluded from analytics.
- Logs default to canonical metadata. Opt-in native protocol logging is bounded, stored under T3-controlled diagnostics, clearly disclosed, and aggressively redacted.
- Remote authorization remains T3's authorization boundary. A connected client does not gain access to arbitrary Prime daemon sessions through this provider.
- RPC stdout is untrusted protocol input: schemas, size limits, and path/URL sanitization apply before persistence or client delivery.

### Observability and telemetry

Operational logs and metrics may include provider driver/instance identifiers, T3 thread/turn correlation IDs, operation name, duration, outcome/error class, process exit code, protocol event type, queue depth, dropped/coalesced update counts, installed version, and compatibility band. User-provided instance display names should not be analytics dimensions.

Product analytics may record feature use in coarse terms (session started, interrupt used, resume outcome, Prime-native feature invoked) with provider kind and compatibility version band. It must not record RPC payloads, model prompts, generated text, model-provider account identity, auth status details beyond coarse configured/not-ready state, or host paths.

A diagnostics bundle, if added, shows the user what will be included and excludes secrets/content by default.

### Compatibility

- The adapter has explicit schemas for commands, responses, and consumed events at the tested baseline.
- Additive unknown fields/events are tolerated; missing or changed required semantics produce a compatibility error.
- Capability detection/version gating controls Alpha/Beta features independently from MVP core.
- T3 never silently falls back from dedicated RPC to ACP.
- The supported version range and most recently tested Prime version are visible in maintainer documentation and provider advisories.

## Testing contract

Before a phase ships, focused automated tests cover:

- driver configuration decoding, instance creation/rebuild/removal, snapshot states, model mapping, and version advisories;
- byte-level LF framing across chunks, CRLF tolerance, Unicode separators inside JSON, malformed JSON, oversized frames, EOF fragments, and stderr noise;
- request ID correlation with interleaved events/responses, timeouts, duplicates, abort races, and process exit;
- mapping representative Prime messages, reasoning, tools, usage, errors, extension UI, tasks, compaction, and terminal states into canonical events;
- exact subprocess ownership, graceful/forced scoped cleanup, disable/reconfigure, multiple threads, multiple instances, and coexistence with an unrelated Prime process/daemon session;
- orchestration ingestion, checkpoints, remote subscriptions, and multi-client single-turn behavior using receipts/worker drains rather than sleeps;
- contract decode/encode compatibility for server, web, desktop, and mobile;
- model picker, status/error/reverse-state UI, and mobile parity for the features included in that phase;
- Beta recovery scenarios listed in the Beta section using isolated session directories and no live user data.

A small versioned RPC fixture suite is kept from supported Prime versions. At least one integration test runs the real supported `prime-agent` binary in an isolated home/session directory, with no dependence on the maintainer's live auth store or daemon. Browser/simulator validation follows repository policy and is performed only with explicit permission.

## User-observable acceptance outcomes

### MVP

1. On a host with a compatible authenticated Prime Agent installation, a user can add/enable Prime Agent, see it as ready, select a discovered model and supported thinking level, start a thread, receive streamed output/tool activity, interrupt a running turn, send another prompt, and stop the session.
2. The same thread can be observed and controlled from another connected web or mobile client without launching a duplicate agent or exposing host credentials.
3. With Prime missing, unauthenticated, incompatible, or crashed, the user sees a specific actionable state; other providers and the T3 server continue working.
4. Disabling/reconfiguring Prime stops the exact T3-owned work for that instance. An unrelated terminal Prime session or daemon worker continues unaffected.
5. Model discovery failure, unsupported attachment, malformed protocol output, and a selected model disappearing all produce truthful recoverable UI rather than silent fallback or a stuck spinner.
6. Prime-backed work appears through the normal T3 message, activity, diff, checkpoint, and restore surfaces. Restore does not claim to rewind Prime conversation state.

### Alpha

1. Every shipped Prime-native control has visible current/pending state, works from applicable remote clients, and has a clear cancel/stop/pause/close reverse action.
2. Subagent, queue, compaction, command, extension UI, usage, goal, or heartbeat data included in Alpha is presented in its appropriate T3 surface without flooding the main timeline or websocket.
3. An older compatible Prime version lacking an Alpha capability retains MVP operation and sees that capability disabled with an explanation.

### Beta

1. After a T3 server restart, a previously durable Prime-backed thread resumes the exact provider session before accepting a new prompt, and the UI confirms the resume outcome.
2. If exact resume is unsafe or impossible, T3 never silently starts fresh; it offers retry, fork, or new-session recovery while preserving readable T3 history.
3. Two devices racing to resume/send work cannot create two authoritative Prime workers for one durable T3 thread.
4. T3 can remove or stop only its own durable resources, and upgrades/rollbacks preserve undecodable future cursors as unavailable state rather than corrupting configuration.

## Assumptions

- Prime Agent continues to provide a stable subprocess RPC mode and model discovery at or beyond the 0.7.2 baseline.
- T3 can represent Prime provider/model identity without flattening the upstream provider component.
- Existing T3 approval/user-input and Agents surfaces can host the subset of Prime interactions chosen for each phase; contract extensions may still be required.
- The environment owner is responsible for installing and authenticating Prime Agent on the server host.
- T3's existing provider-instance sensitive environment storage is the only T3-managed secret input needed for unusual deployments.

## Unresolved decisions before implementation planning

These are design decisions to settle during usage review/planning; none changes the selected dedicated RPC direction.

1. Whether the MVP launches invocation-local sessions with `--no-session` or uses a T3-scoped session directory while withholding resume guarantees until Beta. The choice must avoid accidental mixing with global user sessions and leave a clean Beta migration path.
2. The minimum and maximum supported Prime versions at first release, and whether unknown newer versions are warning-only or blocked until a handshake succeeds.
3. The exact user-facing auth probe Prime can guarantee without prompting, mutating auth state, or revealing account information.
4. Which launch arguments are safe to expose versus requiring typed settings.
5. Whether Prime provider/model pairs fit the existing model slug contract directly or require a structured provider-native model identity field.
6. Which extension UI dialogs and attachment types meet MVP semantics versus deferral to Alpha.
7. Whether T3-created resident daemon sessions are prohibited until Alpha/Beta, or permitted for a narrowly scoped feature with explicit ownership metadata.
8. How a T3 checkpoint revert should prompt the user about Prime conversational divergence before Beta fork/resume integration exists.
9. The retention/deletion policy for Beta session files and how it interacts with thread archive, delete, environment removal, and backups.
