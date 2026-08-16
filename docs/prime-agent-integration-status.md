# Prime Agent integration status

_Last updated: 2026-08-16. Run: `prime-agent-perfect-integration-20260813`._

## Desired feature

T3 Code is adding a polished, first-party **Prime Agent** provider. T3 launches the installed host binary exclusively as `prime-agent --mode rpc`, registers it as driver kind `prime-agent`, and normalizes Prime RPC at the server adapter boundary so web, desktop, mobile, orchestration, checkpoints, and remote clients remain provider-neutral.

The finished feature must provide:

- Host-scoped installation/authentication health, exact provider-instance/model identity, model/thinking selection, attachments, live turns, streaming, interactions, interrupt/stop, crash recovery, and isolated text-generation operations.
- Alpha Prime-native steering, queued follow-up, compaction, command/skill discovery, rich extension UI, subagent observation, goals, heartbeats, naming, and forking.
- Beta durable session loading/resume, compatibility checks, single-writer arbitration, explicit recovery choices, retention, migration, rollback, and remote recovery validation.
- The same truthful state across web/desktop/mobile clients without phone-local Prime setup or ownership controls.
- Strict security boundaries: no ACP fallback, no ambient/live auth mutation, bounded RPC/event queues, no invented native IDs or cancellation, proof-before-action cleanup of exact T3-owned processes/resources, and no secret/native queued text in logs, telemetry, failure activities, or durable intent events.

## Delivery and review plan

The work is split into 30 dependency-ordered milestones. Each milestone is developed on an isolated branch/worktree, validated with focused production tests and a source-derived runnable artifact, and independently reviewed by both a code/security reviewer and a black-box product reviewer on the **same exact commit SHA**. A rejected or stale SHA is repaired and reviewed again; it is not merged. Browser/Electron/mobile launches, screenshots, and video remain permission-gated.

Phase order:

1. MVP `PA-M01` through `PA-M16`.
2. Alpha `PA-A01` through `PA-A08`.
3. Beta in dependency order: `PA-B01`, `PA-B03`, `PA-B02`, `PA-B04`, `PA-B05`, `PA-B06`.
4. Audit all 30 milestones and graduate documentation before declaring the integration complete.

## Completed and merged

The MVP and the Alpha contract foundation are merged to `main` at `c96593463ff4a46f4026f158f09867483d3e7793`.

| Milestone | Scope                                                              | Status / merge    |
| --------- | ------------------------------------------------------------------ | ----------------- |
| PA-M01    | Versioned Prime RPC schemas and fixture corpus                     | Done — `c9e54704` |
| PA-M02    | Strict-LF bounded transport parser/writer                          | Done — `329eeba7` |
| PA-M03    | Correlated RPC client and asynchronous event multiplexer           | Done — `28efd932` |
| PA-M04    | Provider contracts, typed settings, structured model identity      | Done — `8567c8fe` |
| PA-M05    | Read-only version/auth/model/capability probes                     | Done — `e52ec401` |
| PA-M06    | T3-scoped resources and exact ownership registry                   | Done — `aace57a5` |
| PA-M07    | Driver registration and live session bootstrap                     | Done — `2049a8d0` |
| PA-M08    | Prompt, attachment, model, and thinking path                       | Done — `45b0c241` |
| PA-M09    | Canonical runtime event mapping                                    | Done — `9e209d68` |
| PA-M10    | Interactions, interrupt, stop, crash, scoped teardown              | Done — `98c0ae02` |
| PA-M11    | Prime text-generation operations                                   | Done — `981937a9` |
| PA-M12    | Provider-neutral orchestration/checkpoint/multi-client integration | Done — `adfb9661` |
| PA-M13    | Web/desktop settings and health UI                                 | Done — `a308e67f` |
| PA-M14    | Web/desktop picker, composer, timeline, recovery UI                | Done — `68b28f51` |
| PA-M15    | Mobile selection/control/interaction/host-status parity            | Done — `112d977a` |
| PA-M16    | Isolated real-binary gate and MVP documentation graduation         | Done — `074f18a9` |
| PA-A01    | Capability negotiation and provider-neutral Alpha contracts        | Done — `c9659346` |
| PA-A02    | Steering and queued follow-up with visible cancellation            | Done — `962c80b7` |
| PA-A02.1  | PA-A02 review-debt cleanup                                         | Done — `2d8772c1` |
| PA-A03    | Context usage, compaction, retry, bounded status UI                | Done — `f8218111` |
| PA-A04    | Prime commands, skills, prompt templates                           | Done — `44c23c2c` |
| PA-A05    | Rich extension UI and transient status integration                 | Done — `251b823c` |
| PA-A06    | Subagents, observation, Agents-surface controls                    | Done — `2e6c1d3e` |

Completed total: **23 of 31 milestones** (PA-A02.1 added to the original 30).

Note on "merged to main": the run's milestone merges advance the run `main`
lineage descending from public `origin/main` commit `9e201941a`. By maintainer
decision (2026-08-16): the run stays on this lineage, mirrored at
`origin/dev/prime-agent-perfect-integration-20260813/run-main` after each
milestone merge, and reaches `origin/main` as a single pull request when the
integration completes. Milestone branches are owned by the local T3 coordinator
session; the garden-host coordinator must not push to run branches.

The accepted PA-M06 legacy pathname cleanup debt remains recorded in `security-fidings.md`; proof-before-action rules still apply and the debt must not spread.

## PA-A02 (merged)

**PA-A02 — Steering and queued follow-up with visible cancellation** was dual-approved on exact SHA `9897baf7a` (code/security and black-box product, after three review rounds plus scoped confirmations) and merged to `main` at `962c80b7` on 2026-08-16.

Implemented:

- Exact Prime 0.7.2 `steer`, `follow_up`, and authoritative `session_action_update` schemas.
- Capability-gated provider dispatch without synthetic action IDs or fake individual cancellation.
- Explicit web/mobile **Steer now** and **Queue next** choices for active Prime turns, with plain-text-only constraints and independently truthful capability controls.
- Non-Prime running composers remain on their existing behavior.
- Authoritative snapshot replacement persisted only for the matching active Prime turn; ready, completed, aborted, stopped, errored, and exited lifecycles clear action state and late/stale snapshots fail closed.
- Two-client projection convergence and runtime capability persistence.
- Bounded, 60-second, process-local, one-shot runtime-text handoff. Queued/steering text reaches the provider but is excluded from durable orchestration intent payloads, activities, error details, and telemetry/log sinks; restart/expiry fails closed. The authoritative operational `action_state_json` projection deliberately retains live queue text for cross-client synchronization; it is neither observability nor durable intent.
- Migration 041 for nullable session action/capability JSON columns, including migration-through-40/41 partial-schema and idempotency coverage.
- Runnable artifact `packages/contracts/fixtures/pa-a02-prime-runtime-transcript.mjs`.

Current validation evidence includes passing Prime protocol/normalizer/adapter tests, migration tests, runtime ingestion tests, web/mobile queue tests, contracts tests, mobile/contracts/client-runtime typechecks, and handoff one-shot/duplicate/capacity/expiry tests. One unrelated pre-existing `ProviderCommandReactor` concurrent-turn timing assertion (`serializes concurrent distinct turn starts and rejects the loser`) fails deterministically both in isolation and in the full file; it was reproduced identically at base `c9659346` in a detached worktree, confirming it predates PA-A02. Web typecheck reports exactly the three pre-existing diagnostics (attachment union, branded Prime driver index, readonly test mutation); the fourth diagnostic PA-A02 had introduced (`crypto.randomUUID` in `ChatView.tsx`) is fixed. Server typecheck completes (earlier exit-137 kills were not reproducible) and exits 1 against an already-red package baseline; every diagnostic attributable to PA-A02 code has been fixed — activity-kind union widening, `ProviderRuntimeOperation` typing with fail-closed `FollowUpId` validation, `exactOptionalPropertyTypes` on the projection repository, the handoff service key, an `instanceof`-on-Schema check, and stale test mocks for the new `takeRuntimeActionText`/`executeRuntimeOperation` interface members (including `CheckpointReactor.test.ts`, caught in review round 3). Remaining server diagnostics are pre-existing baseline unrelated to PA-A02 changes.

Review round 1 on SHA `02fdb511` (2026-08-16): product APPROVE; code/security REJECT with two blockers, repaired in `e52a7e0f`. Round 2 on `e52a7e0f`: product APPROVE (both fixes confirmed); code/security REJECT — the fixes were verified correct, but the round surfaced PA-A02-attributable typecheck diagnostics and the inaccurate typecheck baseline in this document, both since repaired on this branch. Round 1 blockers, for the record:

1. The `pendingTurnStart` session replacement in `ProviderCommandReactor` dropped `runtimeCapabilities` on every turn after the first for a live reused session, silently removing the steer/queue panel. The capabilities are now carried forward through that session-set, with a two-turn regression test.
2. The web composer traded the stop/interrupt control for Send while a Prime turn was running. The stop control now stays rendered during running turns, and the runtime-action panel carries its own explicit send button.

Round 3 on `22a87da3` (which also absorbed the external coordinator commit `7d9bf0f3` adding snapshot identity binding and canonical-log redaction, reviewed as new code): dual APPROVE, with three accuracy corrections landed as `9897baf7a` and confirmed by both reviewers on that exact SHA before merge.

Visual evidence remains truthfully not captured across all rounds because UI-launch permission was never granted; the runtime-action panel has never been observed rendered. Closing that gap is carried into PA-A02.1.

Accepted non-blocker debt carried into **PA-A02.1** (see `docs/prime-agent-remaining-execution-plan.md`): falsifiable artifact convergence assertion; genuine two-client convergence evidence; capability-derived cancellation copy; inline send-decision reason on web; mobile disabled-button styling; rendering `PrimeActionState.active`; snapshot coalescing; crash-restart stale action-state display; a regression test for the invalid-ID fail-closed path; documenting the interrupt handler's optimistic action-state clear as an explicit invariant exception; a guard or warning comment on the writer-less orchestration log stream; and visual evidence capture.

## PA-A02.1 (merged)

**PA-A02.1 — PA-A02 review-debt cleanup** was dual-approved on exact SHA `c270b138` (single round: Luna-verified watch pass, independent code/security and black-box product APPROVE) and merged to `main` at `2d8772c1` on 2026-08-16. Non-blockers accepted at approval: a bounded, self-healing startup-sweep race that can transiently blank a freshly reconnected queue until the next authoritative snapshot; the read-model two-client assertion is determinism evidence (the artifact carries the falsifiable convergence proof); and the `followUpCancel: true` cancellation copy would promise per-item cancel controls that no client renders — unreachable today (`PrimeAdapter` pins it false) but must be closed before any runtime advertises the capability.

Every accepted non-blocker from the PA-A02 rounds is closed:

1. Cancellation copy is derived from the negotiated `followUpCancel` capability
   (`primeCancellationCopy`) on web and mobile instead of hard-coded text.
2. The web composer renders `primeSendDecision.reason` inline while typing,
   matching the mobile composer.
3. Disabled mobile runtime-action buttons carry disabled styling and
   `accessibilityState`.
4. `renderPrimeQueue` renders `PrimeActionState.active` ahead of the lanes on
   both clients (an unlabeled active entry stays invisible — nothing truthful to
   show).
5. `ProviderCommandReactor.test.ts` covers the invalid-runtime-action-ID
   fail-closed path: the "identifier is invalid" failure activity appears, the
   provider is never called, and the action text never reaches the projection.
6. `packages/contracts/fixtures/pa-a02-prime-runtime-transcript.mjs` now derives
   each client's projection independently from one shared broadcast and proves
   on every run that a divergent client reducer fails the convergence check;
   `ProviderRuntimeIngestion.test.ts` adds a two-client convergence assertion
   through the read model.
7. Byte-identical consecutive `session_action_update` snapshots are coalesced on
   the write path, so repeats produce no durable event and no projection write.
8. On reactor start, sessions holding a queue snapshot whose provider process is
   no longer live have their action state cleared; healthy live sessions are
   left untouched.
9. The interrupt handler's optimistic action-state clear is documented at its
   call site as an explicit, bounded exception to the authoritative-snapshot
   invariant.
10. The `"orchestration"` log stream now redacts `actionState` steering,
    follow-up, and active-label text at the writer boundary, so attaching a
    writer later cannot start persisting queued native text.
11. Visual evidence is still **not captured**: UI-launch permission was not
    granted for this milestone either, and the runtime-action panel has never
    been observed rendered. Exact steps once permission is granted — web:
    `vp run dev` in a worktree, open the printed `pairingUrl:`, start a Prime
    Agent thread, send a turn, and screenshot the composer panel marked
    `data-prime-runtime-actions` while the turn runs (before/after with
    `followUpCancel` off and on); mobile: `test-t3-mobile` against the same
    server, open the running thread, and screenshot the composer runtime-action
    block in the same two capability states.

## PA-A03 (merged)

**PA-A03 — Context usage, compaction, retry, and bounded status UI** was dual-approved on exact SHA `f00d7e1a` (three workflow rounds — round 1 rejected for unreachable compaction/usage paths and missing client projection, round 2 for a fabricated-activity republish and a stranded post-terminal status, both repaired — final round dual APPROVE with zero blockers, Luna-verified watch passes) and merged to `main` at `f8218111` on 2026-08-16.

Implemented:

- Exact Prime 0.7.2 `get_session_stats` and `compact` commands, plus bounded `compaction_update`
  and `retry_update` status events at the RPC boundary (`onExcessProperty: error`, so an
  unrecognized shape is incompatible rather than silently reinterpreted).
- Provider-neutral `session.context.updated` snapshot with compaction status/trigger/reason,
  retry attempt, and optional usage. Null post-compaction usage is valid and never guessed.
- `PrimeContextTracker` publishes only on real change: byte-identical snapshots are dropped and
  streamed usage churn never publishes a context snapshot, so the status UI is a short list of
  discrete states with nothing to animate.
- `compaction.request` maps to native `compact`; `usage.snapshot.retry` re-reads
  `get_session_stats`. Compaction cancellation is **not** claimed: the independent
  `compactionCancel` capability stays false rather than mapping cancel onto the turn-wide `abort`.
- Activity projection labels compaction as compaction and carries no checkpoint/revert
  vocabulary; mobile composer copy states explicitly that compacting is not a checkpoint and does
  not revert work.
- Runnable artifact `packages/contracts/fixtures/pa-a03-prime-context-transcript.mjs`, which
  verifies its mapping tables against the shipped source, proves coalescing, proves its own
  convergence check is falsifiable, and walks the whole client-to-adapter chain so the two
  operations cannot silently become dead paths again.

Round-2 review repairs (both reviews rejected the first round):

- **Manual compaction and usage refresh are reachable end to end.** New client commands
  `thread.compaction.request` and `thread.usage.refresh` flow through the decider
  (`thread.compaction-requested` / `thread.usage-refresh-requested`) into the provider command
  reactor, which builds the `compaction.request` / `usage.snapshot.retry` operations. Both
  require a live running turn and are gated on the _negotiated_ capability read at dispatch time,
  never on a stored flag; a runtime that does not advertise the capability produces a
  user-visible failure activity and no native call. Client-supplied identifiers are validated
  against the branded runtime-extension shape, so no identifier is ever invented.
- **Context state is projected as current status.** `session.context.updated` now folds into
  `OrchestrationSession.contextState` (new nullable `context_state_json` column, migration 042).
  Snapshots replace, so attached clients converge; byte-identical snapshots write nothing; and
  terminal turn/session/runtime-error transitions clear the snapshot so a stale "Compacting" can
  never survive.
- **Both clients render it.** Web mounts `PrimeContextStatus` above the composer with the
  context/compaction/retry lines and the Compact context / Refresh usage controls; mobile renders
  the same lines and controls in the composer runtime block. Controls are disabled with a stated
  reason rather than hidden, and the not-a-checkpoint copy is shared source on both surfaces.
- **Retry status no longer outlives its attempt**, and a partial `compaction_update` merges over
  the last known usage instead of dropping a `maxTokens` the runtime never retracted.
- **The runtime-capability publication gate** now covers every flag the session contract can
  carry, so a runtime advertising only context management is no longer stripped.
- Focused-verification test paths now match the frozen contract exactly:
  `apps/web/src/components/chat/prime-context.test.tsx` and
  `apps/mobile/src/features/threads/prime-context.test.tsx`.

Round-3 review repairs (both reviews rejected round 2):

- **A retry no longer restates a compaction that already ended.** A `retry_update` (or an
  on-demand usage refresh) republishes the snapshot with the last known compaction status, which
  the activity projection was reading as a fresh compaction event — appending a durable
  "Context compacted" once per retry, unbounded. The published snapshot now carries
  `compactionTransitioned`, set only when the compaction status actually changes, and a durable
  compaction activity requires it. Retry and usage snapshots still show the last compaction
  result in the status panel; they just no longer claim it happened again.
- **An in-flight "Compacting" cannot outlive its turn.** A late `session.context.updated` arriving
  after the turn terminal used to persist forever with nothing in the session able to clear it,
  permanently disabling the Compact context control. `turn.started` now clears an in-flight
  compaction and its retry while preserving usage and any finished compaction result. Compaction
  is session level in Prime, so between-turn automatic compaction is deliberately still accepted
  and visible; the turn boundary is what drops a status that outlived its turn. Known tradeoff:
  a compaction genuinely spanning a turn start reads as idle until its next phase change.
- **Controls state the real precondition.** The server accepts context actions only during a live
  running turn, so both clients now gate on turn liveness before capability status and say
  "Context actions are available while a turn is running." instead of leaving an enabled button
  that fails, or reporting the misleading "Compaction is already running." on an idle thread.
- **The review artifact stopped overstating itself.** Its reducer now mirrors the shipped
  retry-retention rule, and it checks the shipped transition-marker and activity-gate sources.
- The two client `primeContext.ts` copies are asserted byte-identical by the mobile suite, so the
  comment claiming they cannot drift is now enforced.

Visual evidence is truthfully **not captured**: UI-launch permission was not granted. Exact steps
once granted — web: `vp run dev` in a worktree, open the printed `pairingUrl:`, start a Prime
Agent thread, run a turn, press **Compact context** in the status row above the composer, and
screenshot the context/compaction status rows; mobile: `test-t3-mobile` against the same server and screenshot the composer
runtime block with `compaction` on and off.

## PA-A04 (merged)

**PA-A04 — Prime commands, skills, prompt templates** was dual-approved on exact SHA `e0a43dd4` (three workflow rounds: rounds 1 and 2 rejected by the black-box product review — first for a review artifact that re-implemented the sanitizer instead of executing shipped code, then a follow-up artifact defect — while code/security approved throughout; final round dual APPROVE with zero blockers, Luna-verified watch passes) and merged to `main` at `44c23c2c` on 2026-08-16.

Delivered: Prime command/skill/prompt-template discovery normalized into a per-session `commandCatalog` (migration 043), surfaced as a "Prime commands" group in the web command palette and a composer command sheet on mobile; TUI-only and unsafe entries excluded; no host paths on the wire; runnable artifact `packages/contracts/fixtures/pa-a04-prime-commands-transcript.mjs` proves adapter→event→projection→client reachability.

Accepted non-blockers to carry forward: stale-command error copy promises a refresh no client can trigger (no `command.discover` producer after session start); `commandDiscovery: true` over-advertises `command.invoke`/`skill.*` operations the adapter truthfully refuses; a latent bind-vs-ingestion ordering race could drop a session's catalog with no re-discovery path; visual evidence still pending UI-launch permission.

## PA-A05 (merged)

**PA-A05 — Rich extension UI and transient status integration** was dual-approved on exact SHA `c2f9537a` (two workflow rounds: round 1 rejected by code/security because cancelled/timed-out dialogs were rendered as "User input submitted" — the truthful-resolution fields never reached the projection or clients — repaired; final round dual APPROVE with zero blockers, Luna-verified watch passes) and merged to `main` at `251b823c` on 2026-08-16.

Delivered: bounded per-session extension notice board (migration 044, 8-entry cap, byte-identical dedupe), blocking Prime dialogs with truthful pending/resolved/cancelled states and native timeouts, non-blocking notices routed off the transcript, web `PrimeExtensionStatus` and mobile composer status block; dead sessions show nothing; runnable artifact `packages/contracts/fixtures/pa-a05-prime-extension-ui-transcript.mjs`.

Accepted non-blockers to carry forward: answer-vs-timeout race can double-send an `extension_ui_response` for one correlation id; notice-board updates are deduplicated but not rate-limited; the client liveness gate (`running`/`ready`) is narrower than the server's (anything but `stopped`), hiding boards published between turns; visual evidence still pending UI-launch permission.

## PA-A06 (merged)

**PA-A06 — Subagents, observation, Agents-surface controls** was dual-approved on exact SHA `a5d1c0fc` (two workflow rounds: round 1 rejected by the black-box product review because the promised "versions without observation show disabled explanation" was unreachable — both clients hid the section entirely when `tasks` was absent while the shipped doc claimed otherwise — repaired; final round dual APPROVE with zero blockers, Luna-verified watch passes) and merged to `main` at `2e6c1d3e` on 2026-08-16.

Delivered: runtime-owned subagent roster (migration 045, 16-row bound, clamped strings), reversible observe/unobserve with double-enforced roster-as-authorization, subagent output kept out of the transcript, web Agents-panel section and mobile composer block with truthful capability-absent explanations, no per-agent cancel mapped onto turn-wide abort; runnable artifact `packages/contracts/fixtures/pa-a06-prime-agents-transcript.mjs`.

Accepted non-blocker to carry forward: the roster title fallback can exceed the 120-char contract cap for 121–128-char task ids with no title, causing roster updates for that thread to roll back until the agent disappears (one-line clamp fix); visual evidence still pending UI-launch permission.

## PA-A07 (implemented, awaiting review)

**PA-A07 — T3-owned goals and heartbeats with daemon-promotion disclosure** is implemented on `dev/prime-agent-perfect-integration-20260813/pa-a07` and has not been reviewed or merged.

Delivered: provider-neutral goal and owned-heartbeat board (`session.goals.updated`, migration 046, 8-row bound, one-minute-to-one-day intervals, byte-identical dedupe); create/pause/resume/delete for heartbeats this environment created, with ownership double-enforced (reactor before the host, adapter against its own live board) so an unrelated daemon schedule is never listed or targeted; resident-daemon promotion disclosed and confirmed before creation on web and mobile, with the exact owner shown afterwards and the reverse limited to stopping that one T3-owned session; goal state read-only because 0.7.2 exposes no goal-change RPC; owned heartbeat ids persisted as ownership handles and spent one at a time behind per-id proof during cleanup; runnable artifact `packages/contracts/fixtures/pa-a07-prime-goals-heartbeats-transcript.mjs`.

Review round 2 repairs: every thread ownership write now builds its record through one shared `primeThreadOwnershipRecord` helper, so the write that happens when the Prime child exits on its own keeps the owned heartbeat ids instead of erasing the only handle cleanup could later prove; a `heartbeat_get` re-read now prunes owned ids the runtime no longer reports, the same way the `heartbeat_update` event path already did; and the web/mobile draft check states the 120-character title cap inline rather than letting the wire schema reject it.

Review round 3 repairs: the ownership record is per thread and outlives any one session, so a new session for the same thread now reads the recorded heartbeat ids back before it rewrites the record — previously the start-of-session write replaced them with `[]`, leaving a still-resident T3-created schedule with no handle anywhere: no board row, no pause/resume/stop target, and nothing for cleanup to prove. After rehydrating, the session re-reads the runtime's schedule once so the surviving heartbeat reappears and stale ids are pruned. Two adjacent holes closed with it: a created id the board could not state exactly is no longer adopted as a permanent unusable handle, and creation is capped against the owned-handle set rather than only the renderable board, so the ownership write can no longer fail after a heartbeat really exists. Regression coverage is `apps/server/src/provider/Layers/PrimeAdapter.heartbeat-ownership.test.ts` (all three verified to fail with the fixes reverted) plus a fail-closed read-back test in `PrimeOwnership.test.ts`.

Known gaps to raise at review: visual evidence is still pending UI-launch permission; the native heartbeat command and event names are the declaration baseline this repository has been building against and could not be re-verified against an installed `prime-agent` on this host; ownership handles are recorded only where the platform can prove a process incarnation (Linux `/proc`), matching the existing PA-M06 ownership boundary.

## Pending milestones

| Milestone | Planned scope                                                    | State                           |
| --------- | ---------------------------------------------------------------- | ------------------------------- |
| PA-A07    | T3-owned goals and heartbeats with daemon-promotion disclosure   | Implemented, awaiting review    |
| PA-A08    | Session naming/forking and Alpha integration/docs                | Pending                         |
| PA-B01    | Versioned resume cursor and scoped durable storage policy        | Pending                         |
| PA-B03    | Server-side single-writer arbitration and conflict receipts      | Pending after B01; precedes B02 |
| PA-B02    | Exact adoption/resume state machine and compatibility validation | Pending after B01/B03           |
| PA-B04    | Web/desktop/mobile resume and recovery-choice UI                 | Pending                         |
| PA-B05    | Durable cleanup, retention, migrations, rollback safety          | Pending                         |
| PA-B06    | Full Beta recovery matrix, remote gate, documentation graduation | Pending                         |

## Immediate next steps

1. Capture the still-pending PA-A02/PA-A02.1 visual evidence when UI-launch permission is granted (exact steps recorded above).
2. Implement and review `PA-A03`–`PA-A08` sequentially.
3. Implement Beta in the dependency order above.
4. Audit all milestones, security constraints, artifacts, operations/user documentation, and remote behavior before completing the goal.
