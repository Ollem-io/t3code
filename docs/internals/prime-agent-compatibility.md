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

## PA-A04 commands, skills, and prompt templates

Prime 0.7.2 exposes a no-argument `get_commands`. T3 discovers once per session, caches the result
for that session, and publishes it as the provider-neutral `session.commands.updated` snapshot.

- **Discovery only.** `commandDiscovery: true` means the runtime can be _asked what it offers_. It
  is not an invocation channel: Prime 0.7.2 has no invoke RPC, so an eligible entry is sent as an
  ordinary prompt (`/name …`) and `command.invoke` stays refused rather than mapped onto a command
  that does not exist.
- **Ineligible entries do not exist.** TUI-only entries and anything that mutates authentication,
  the daemon, or the T3-owned session lifecycle are dropped at the adapter boundary, so no surface
  can offer one. An unrecognized response body yields an empty catalog and the feature stays hidden.
- **No host path on the wire.** `location` is reduced to a bare file name. Absolute, home-relative,
  parent-traversing, and Windows drive paths are dropped outright rather than trimmed: the label is
  worth less than the certainty that a remote client learns nothing about host layout. A path
  embedded in a host-authored `description` gets the same treatment: it collapses to its bare file
  name so the sentence still reads without disclosing where the file lives.
- **Bounded and cached.** At most 128 entries, deduplicated by name with the first definition
  winning; discovery re-runs only on an explicit `command.discover`, and a byte-identical catalog
  produces neither a durable event nor a projection write. The cache dies with its session.
- **Refreshed on open, never polled.** Opening the command palette on web, or the command list in
  the mobile composer, requests one bounded refresh (`thread.commands.refresh`), which invalidates
  the session cache and re-reads the host. Nothing polls, and a runtime that does not advertise
  discovery refuses the request.
- **Snapshots replace.** A command deleted on the host disappears on every attached client, and an
  entry that vanished between render and click fails with a stated reason instead of a prompt the
  runtime would reject: both surfaces resolve the click against the newest catalog, not the list
  they rendered from.
- **Insertion, never replacement.** Picking an entry appends its prompt to the draft already in the
  composer; the user's typed text is never discarded, and sending stays the user's decision.

`packages/contracts/fixtures/pa-a04-prime-commands-transcript.mjs` builds a disposable
extension/prompt/skill tree and runs it through the shipped `normalizePrimeCommands` and the shipped
client resolver — it imports them rather than re-implementing them, so a regression in either fails
the transcript. `PrimeCommandsTranscript.test.ts` keeps that wiring honest in CI.

## PA-A05 rich extension UI and transient status

Prime 0.7.2 sends nine `extension_ui_request` methods. Four are blocking dialogs; the rest are
fire-and-forget presentation. T3 treats the two groups as different things.

- **Dialogs are answered exactly.** `select`, `confirm`, `input`, and `editor` keep the MVP mapping
  onto canonical `request.opened` / `user-input.requested`, and the native response carries the
  exact value or `cancelled: true` — never an invented one.
- **Cancellation closes the dialog.** A cancelled, superseded, or timed-out request now emits a
  resolution as well as the warning. A warning alone left the dialog pending forever on every
  attached client. The resolution says `cancelled` with a reason, so a cancelled dialog is never
  described as answered.
- **Timeouts resolve truthfully.** A native `timeout` is read as milliseconds and clamped to
  1s–10min: an absurd value cannot produce a dialog nobody can answer or one that never closes. On
  expiry T3 answers the runtime `cancelled: true` and states the elapsed time.
- **Pending dialogs cancel on stop.** Session stop, adapter stop, and a child that dies all cancel
  every pending dialog before the terminal events, without pretending to answer a dead channel.
- **A method this build cannot decode never hangs.** The strict transport fails the session closed
  rather than parking a request T3 could not validate; no response is invented for it.
- **Status is not transcript.** `notify`, `setStatus`, `setWidget`, `setTitle`, and
  `set_editor_text` become one bounded `session.notices.updated` snapshot — at most eight entries,
  256-character text, four 160-character widget lines. Entries are keyed, so a repeat replaces;
  notifications are keyed by severity so a chatty info stream cannot bury an error; an operation
  that clears its own content removes the entry. Byte-identical boards produce neither a durable
  event nor a projection write.
- **Nothing is answered that was not asked.** Fire-and-forget operations are displayed and never
  responded to.
- **`set_editor_text` is a suggestion.** T3 shows the proposed composer text rather than silently
  overwriting what every attached client is typing.
- **Transient means transient.** The board is cleared when the session exits, and clients render it
  only for a live session — a crashed session never keeps showing a dead extension's status.
  Dismissal is per viewer and per exact message, so a replacement is not swallowed by an earlier
  dismissal and one client cannot blank another's view.

`packages/contracts/fixtures/pa-a05-prime-extension-ui-transcript.mjs` runs a fixture extension
through the shipped mapper (`PrimeExtensionUi.ts`), the shipped canonical contract, and the shipped
client projection — it imports them rather than re-implementing them.
`PrimeExtensionUiTranscript.test.ts` keeps that wiring honest in CI.
