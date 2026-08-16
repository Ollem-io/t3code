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

Completed total: **19 of 31 milestones** (PA-A02.1 added to the original 30).

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

## PA-A03 (implemented, in review)

**PA-A03 — Context usage, compaction, retry, and bounded status UI** is implemented on
`dev/prime-agent-perfect-integration-20260813/pa-a03`.

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

Visual evidence is truthfully **not captured**: UI-launch permission was not granted. Exact steps
once granted — web: `vp run dev` in a worktree, open the printed `pairingUrl:`, start a Prime
Agent thread, run a turn, press **Compact context** in the status row above the composer, and
screenshot the context/compaction status rows; mobile: `test-t3-mobile` against the same server and screenshot the composer
runtime block with `compaction` on and off.

## Pending milestones

| Milestone | Planned scope                                                    | State                           |
| --------- | ---------------------------------------------------------------- | ------------------------------- |
| PA-A04    | Prime commands, skills, prompt templates                         | Next                            |
| PA-A05    | Rich extension UI and transient status integration               | Pending                         |
| PA-A06    | Subagents, observation, Agents-surface controls                  | Pending                         |
| PA-A07    | T3-owned goals and heartbeats with daemon-promotion disclosure   | Pending                         |
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
