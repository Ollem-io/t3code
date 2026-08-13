# Prime Agent task dependencies and release gates

> Run: `prime-agent-perfect-integration-20260813`
> Planning base: approved product and usage documentation at `6a5f0d74cd5640a9bbcbdbc26dae5ed4b329a8c1`
> Reconciled with `docs/implementation-plan.md`, whose 30 stable top-level task IDs are `PA-M01`–`PA-M16`, `PA-A01`–`PA-A08`, and `PA-B01`–`PA-B06`.

## Dependency policy

- Execute sequentially in the topological order below by default, even when the graph permits parallel work. Parallelism is scheduling information, not the default plan.
- An edge is an artifact dependency: a predecessor must land its focused proof and review artifact before a successor relies on it.
- Numeric task IDs are stable references, not execution-order numbers. In particular, MVP executes `PA-M04 → PA-M06 → PA-M05`, and Beta executes `PA-B01 → PA-B03 → PA-B02`.
- Prime RPC framing, correlation, capability interpretation, resource ownership, and native event mapping remain inside the Prime driver/adapter. Orchestration and clients receive typed provider-neutral state only.
- Dedicated `prime-agent --mode rpc` is the only runtime boundary. ACP is not a fallback.
- Every process, session, config, daemon, cursor, and cleanup fixture must be scoped to a disposable T3 home. Tests may stop only a captured child PID or an exact Prime identity proven by an atomic T3 ownership record.
- No task may modify live T3 userdata, Prime authentication/session stores, broad daemon state, or resources belonging to another T3 home. Proof failure means leave the resource intact and emit a redacted orphan warning.
- Browser/simulator verification and the authenticated current-host real-binary lane require explicit permission. The isolated temporary-home lane must always be safe to run.

## MVP dependency graph

| Task | Direct predecessors | Reason for each edge |
| --- | --- | --- |
| `PA-M01` | — | Root protocol schemas, redacted 0.7.2 fixtures, and scripts for the deterministic fake RPC executable. |
| `PA-M02` | — | Root byte-level LF framing proof, independent of protocol and process lifecycle. |
| `PA-M04` | — | Root T3 contracts/settings/model identity, including default-instance bootstrap and old/new compatibility. |
| `PA-M03` | `PA-M01`, `PA-M02` | Correlation requires decoded envelopes and a bounded framing layer; the process-level fake exercises both. |
| `PA-M06` | `PA-M04` | Resource paths and ownership keys require final environment, instance, and thread identities from settings/contracts. |
| `PA-M05` | `PA-M01`, `PA-M03`, `PA-M04`, `PA-M06` | A probe needs schemas/client behavior, configured binary/instance identity, and owned temporary resource layout before it may spawn. |
| `PA-M07` | `PA-M03`, `PA-M04`, `PA-M05`, `PA-M06` | Driver bootstrap composes the RPC client, typed instance settings, truthful snapshot/probe, and exact ownership. |
| `PA-M08` | `PA-M04`, `PA-M05`, `PA-M07` | Prompt/model/thinking validation needs structured identity, discovered capabilities, and a live command path. |
| `PA-M09` | `PA-M01`, `PA-M03`, `PA-M07`, `PA-M08` | Canonical event folding needs native schemas, asynchronous delivery, live session state, and an accepted turn. |
| `PA-M10` | `PA-M06`, `PA-M07`, `PA-M08`, `PA-M09` | Interaction, interrupt, crash, recovery, and teardown must close the same owned session/turn state established earlier. |
| `PA-M11` | `PA-M04`, `PA-M05`, `PA-M06`, `PA-M07`, `PA-M09`, `PA-M10` | Text generation needs selection, availability, owned short-lived sessions, event/terminal semantics, and scoped teardown rather than a second untracked process path. |
| `PA-M12` | `PA-M08`, `PA-M09`, `PA-M10`, `PA-M11` | Orchestration, checkpoint, authorization, and cross-client race proof require complete server operations and truthful terminal states. |
| `PA-M13` | `PA-M04`, `PA-M05`, `PA-M07` | Settings UI consumes the final schema, driver metadata, and status taxonomy. |
| `PA-M14` | `PA-M08`, `PA-M09`, `PA-M10`, `PA-M12`, `PA-M13` | Web/desktop workflow consumes validated inputs, projected events/controls, authorization/race behavior, and instance administration. |
| `PA-M15` | `PA-M08`, `PA-M09`, `PA-M10`, `PA-M12` | Mobile consumes configured instances and the same projected model, interaction, control, authorization, and host-status state; it has no local admin path. |
| `PA-M16` | `PA-M01`–`PA-M15` | Final MVP gate combines fake-peer determinism, isolated and permission-gated real-binary lanes, every client, ownership/recovery, rollout/rollback, and documentation graduation. |

### MVP ordering notes

- `PA-M04 → PA-M06 → PA-M05` is mandatory. A probe is a spawn, so it cannot precede the resource layout and proof-before-action ownership rules.
- `PA-M01` and `PA-M02` can be reviewed independently; `PA-M03` joins them through both in-memory duplex tests and the deterministic executable peer.
- `PA-M13` and `PA-M15` can proceed after their predecessors while `PA-M12`/`PA-M14` are finishing, but sequential execution remains the default.
- `PA-M12` is the server authorization/race gate. UI tasks may not claim multi-client control until its barrier-controlled two-client fixture passes.
- `PA-M16` is a hard integration/graduation gate, not a test task to run opportunistically against a partial phase.

## Alpha dependency graph

Every Alpha task is gated by a passed `PA-M16`; edges to MVP artifacts below also document the concrete semantics being extended.

| Task | Direct predecessors | Reason for each edge |
| --- | --- | --- |
| `PA-A01` | `PA-M16` | Establish generic Alpha commands/capabilities only after the MVP boundary is stable. |
| `PA-A02` | `PA-A01`, `PA-M10` | Steering/follow-up needs typed Alpha operations plus proven live-turn, cancellation, and terminal behavior. |
| `PA-A03` | `PA-A01`, `PA-M09`, `PA-M10` | Usage/compaction/retry extends canonical usage/events and controllable terminal/reverse states. |
| `PA-A04` | `PA-A01`, `PA-M05` | Command discovery extends bounded capability/snapshot probing and generic command contracts. |
| `PA-A05` | `PA-A01`, `PA-M10` | Rich extension UI extends the proven pending-interaction lifecycle and its cancellation/timeout behavior. |
| `PA-A06` | `PA-A01`, `PA-M06`, `PA-M09`, `PA-M10` | Observation/stop needs stable task events, exact ownership, authorization, and terminal control. |
| `PA-A07` | `PA-A01`, `PA-A06`, `PA-M06`, `PA-M10` | Goals/heartbeats may create resident work, so they require visible agent ownership and pause/resume/stop semantics first. |
| `PA-A08` | `PA-A02`, `PA-A03`, `PA-A04`, `PA-A05`, `PA-A06`, `PA-A07` | Naming/fork ancestry integrates every Alpha capability and is the complete Alpha test/docs gate. |

`PA-A02`–`PA-A06` may be developed independently after their listed predecessors. `PA-A07` waits for `PA-A06`. Merge/review remains sequential by default, and `PA-A08` graduates only behavior actually proved.

## Beta dependency graph

All Beta tasks depend transitively on the passed `PA-A08` Alpha gate.

| Task | Direct predecessors | Reason for each edge |
| --- | --- | --- |
| `PA-B01` | `PA-A08` | Define cursor, storage, migration fixtures, and lease persistence only after pre-resume session identity is stable. |
| `PA-B03` | `PA-B01` | The single-writer lease/receipt contract needs the durable identity and persistence boundary before any cursor is activated. |
| `PA-B02` | `PA-B01`, `PA-B03` | Adoption/resume must validate the cursor and acquire/fence the authoritative writer before activating or accepting work. |
| `PA-B04` | `PA-B02`, `PA-B03` | Clients need final resume states, recovery actions, and typed conflict receipts. |
| `PA-B05` | `PA-B01`, `PA-B02`, `PA-B03` | Cleanup/retention must understand cursor versions, adoption, and leases so it cannot delete active or foreign resources. |
| `PA-B06` | `PA-B02`, `PA-B03`, `PA-B04`, `PA-B05` | The final restart/upgrade/multi-environment/multi-client gate requires complete resume, arbitration, UI, cleanup, and rollback behavior. |

`PA-B04` and non-destructive parts of `PA-B05` may proceed after `PA-B02`/`PA-B03`. Destructive cleanup, provider-removal, deletion, crash-resume, and rollout/rollback race proof must finish before `PA-B06`.

## Cycle analysis and reconciliation findings

The graph is acyclic. Its roots are `PA-M01`, `PA-M02`, and `PA-M04`; its phase terminals are `PA-M16`, `PA-A08`, and `PA-B06`.

Two latent cycles are explicitly prevented:

1. **Probe/bootstrap cycle.** If `PA-M05` reused the full `PA-M07` driver while the driver consumed the `PA-M05` snapshot, the design would cycle. `PA-M05` instead uses the lower-level `PA-M03` client and `PA-M06` resource helper; `PA-M07` composes the result.
2. **Resume/arbitration cycle.** A resumed session cannot safely become active and later acquire arbitration. `PA-B03` therefore establishes the generic lease/fence first, and `PA-B02` consumes it during activation. The numeric IDs remain unchanged.

Planning reconciliation also found and folded these missing requirements into existing tasks without adding IDs:

- `PA-M04`: deterministic default-instance bootstrap/settings migration and old/new client/server compatibility.
- `PA-M01`/`PA-M03`: a deterministic process-level fake RPC executable, not only in-memory or recorded fixtures.
- `PA-M06`/`PA-M10`: atomic ownership records, startup stale-resource recovery/reaper, proof-before-action, two-home isolation, and orphan warnings.
- `PA-M12`: a barrier-controlled cross-client authorization/race fixture before UI claims.
- `PA-M16`: separate always-safe isolated and explicit-permission authenticated real-binary lanes; Prime-only rollout, emergency disable, drain, rollback/downgrade preservation, redacted diagnostics, and orphan recovery runbook.
- `PA-B01`: a complete migration fixture matrix.
- `PA-B03` before `PA-B02`: arbitration before activation/adoption.
- `PA-B05`: cleanup/resume/provider-removal/deletion crash races plus staged `prime-agent` rollout and rollback.

## Valid topological order

1. `PA-M01`
2. `PA-M02`
3. `PA-M04`
4. `PA-M03`
5. `PA-M06`
6. `PA-M05`
7. `PA-M07`
8. `PA-M08`
9. `PA-M09`
10. `PA-M10`
11. `PA-M11`
12. `PA-M12`
13. `PA-M13`
14. `PA-M14`
15. `PA-M15`
16. `PA-M16` — MVP gate
17. `PA-A01`
18. `PA-A02`
19. `PA-A03`
20. `PA-A04`
21. `PA-A05`
22. `PA-A06`
23. `PA-A07`
24. `PA-A08` — Alpha gate
25. `PA-B01`
26. `PA-B03`
27. `PA-B02`
28. `PA-B04`
29. `PA-B05`
30. `PA-B06` — Beta gate

## Phase gates

### MVP gate — `PA-M16`

Must prove on one integrated commit:

- dedicated RPC schemas, strict LF framing, request/event correlation, bounded buffers/logs, and additive compatibility;
- typed settings, default bootstrap/migration, structured native model identity, and attachment/thinking validation;
- complete readiness taxonomy, stale-model behavior, and no auth-store inspection;
- atomic exact ownership, startup stale recovery, two-home isolation, scoped disable/reconfigure/remove/stop/shutdown, and no broad kill;
- prompt, streaming text/reasoning, tools with bounded transfer, representable interactions, interrupt, later prompt, crash, and stop;
- provider-routed text generation plus normal checkpoint/diff/revert disclaimer behavior;
- authorization and duplicate-client races produce one authoritative process/turn;
- web/desktop/mobile paths, including mobile host-only wording;
- an always-safe temporary-home real-binary lane plus a separately authorized current-host authenticated lane;
- Prime-only rollout, emergency disable/drain, rollback/downgrade preservation, redacted diagnostics, orphan warnings, and cleanup runbook;
- focused server/contracts/web/mobile verification and permission-gated visual evidence.

### Alpha gate — `PA-A08`

Must prove every shipped Alpha action is capability-gated, provider-neutral across the wire, synchronized across clients, bounded, authorized, and paired with its reverse action. Older compatible Prime versions retain full MVP behavior with disabled explanations. Resident daemon features target only exact T3-owned identities.

### Beta gate — `PA-B06`

Must prove cursor migration/rollback, arbitration-before-activation, exact resume, restart/upgrade/downgrade, two-client/two-process races, two T3 homes, retry/fork/fresh recovery, and cleanup/provider-removal/deletion crash recovery. Stop/archive remain non-destructive; no failure silently starts fresh or deletes an unproved resource.

## Black-box review limitations and compensating proof

| Artifact/task | What isolated black-box review cannot prove | Required compensating proof |
| --- | --- | --- |
| `PA-M01` schemas | Recorded fixtures alone do not prove installed behavior or live ordering. | Compare with 0.7.2 docs/types; use the executable fake peer and both M16 lanes. |
| `PA-M02` framing | Pure byte tests do not prove subprocess pipe/backpressure/exit behavior. | `PA-M03` process-level fake executable with real stdin/stdout/stderr and exit cases. |
| `PA-M04` contracts/migration | Schema tests do not prove mixed-version clients preserve settings and identity. | Old/new encode/decode/bootstrap fixtures, then web/mobile integration. |
| `PA-M05` probe | A read-only isolated probe cannot prove a paid/authenticated model turn. | M16 isolated lane for safety/status; explicit-permission authenticated lane for the minimal turn. |
| `PA-M06` ownership | In-memory doubles do not prove OS crash/orphan behavior. | Filesystem-backed startup recovery/reaper matrix across two T3 homes and unrelated sentinels. |
| `PA-M09` event mapper | Golden output can conceal invalid live ordering or excessive transfer. | Scripted process peer, byte/event budgets, then minimal permitted real turn. |
| `PA-M11` text generation | A fake result proves routing, not model availability/auth/cost behavior. | Explicit-permission smoke plus complete fake failure/cleanup proof; release never depends on auth mutation. |
| `PA-M12` multi-client | Projector units cannot prove simultaneous commands spawn only one process/turn. | Barrier-controlled two-client fixture using authorization, receipts, and worker drains. |
| `PA-M13`–`PA-M15` UI | Component tests cannot prove real layout, focus, accessibility, or remote interaction. | One integrated web/desktop and mobile pass with screenshots/video after explicit permission. |
| `PA-A06`/`PA-A07` daemon features | Mocks cannot prove unrelated resident sessions survive. | Disposable T3-scoped daemon roots, exact-ID negative tests, and unrelated sentinels. |
| `PA-B01` migrations | Happy-path migration cannot prove crash, rollback, or future-version preservation. | Version/corruption/interruption/two-home migration matrix and downgrade decode rehearsal. |
| `PA-B02`/`PA-B03` resume | Single-process tests cannot prove activation and fencing races. | Barrier-controlled multi-process/server-restart harness; no sleeps or polling. |
| `PA-B05` cleanup | A simple synthetic tree cannot prove crash-resume and every destructive race. | Dry-run manifest, crash injection at each journal point, cleanup-vs-adoption/removal/deletion races, and rollback rehearsal. |

## Safety rules for all review artifacts

1. Create disposable T3 home, `HOME`, Prime config/session/daemon, workspace, and persistence roots.
2. Never copy or point tests at live authentication or T3 userdata. The authenticated lane may read current-host credentials only after explicit permission and may not alter them.
3. Capture child PID plus start/ownership identity at spawn; stop only that proven resource. Never use process-name matching, global daemon shutdown, or filesystem-wide discovery.
4. Use atomic ownership and cleanup records. On missing, corrupt, stale, or conflicting proof, retain the resource and report a redacted orphan warning.
5. Use two-home and unrelated-sentinel negative fixtures for ownership, recovery, daemon, resume, and cleanup behavior.
6. Wait on typed receipts, worker drains, barriers, or process exit—not sleeps or polling.
7. Keep artifacts free of credentials, prompt/transcript content, raw RPC payloads, account identity, and host paths. Prefer counts, coarse states, hashes, and redacted manifests.
8. Run focused tests and targeted typechecks only. Do not substitute repo-wide checks.
