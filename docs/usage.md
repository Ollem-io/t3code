# Use Prime Agent in T3 Code

> **MVP and Alpha shipped. Beta remains proposed.** This guide records the delivered MVP and Alpha contract and the proposed Beta phase. Capability/version gating still applies: every Alpha control below appears only when the installed Prime Agent advertises the capability it needs, and explains itself when it does not. Beta text is not a current-product promise.

## What runs where

**MVP**

A T3 **environment** is the machine running the T3 server, its projects, provider CLIs, credentials, and agent processes. A web page, desktop renderer, phone, or tablet is only a **client** of that environment.

Prime Agent must therefore be installed and authenticated on the **environment host**:

- If you run `npx t3@latest` on your laptop, that laptop is the host.
- If the desktop app is hosting its own server, the desktop machine is the host.
- If the desktop app launches an environment over SSH, the SSH machine is the host.
- If a phone connects over LAN, a tailnet, relay, or tunnel, the phone is not the host. Installing or signing in to Prime Agent on the phone does not configure the remote environment.

T3 launches Prime Agent in the selected project's workspace. Prompts and supported attachments travel from the client to T3; Prime Agent, model credentials, tools, project files, and subprocesses remain on the host. Each configured Prime Agent provider instance belongs to one T3 environment. Configure it again on another environment even if both appear in the same client.

**Example 1 — local desktop:** Maya runs the T3 desktop app on her Mac and opens a local project. She installs and authenticates Prime Agent on that Mac. The desktop renderer asks its bundled T3 server to run Prime Agent; it does not launch a separate renderer-owned agent.

**Example 2 — remote phone:** Dev pairs an iPhone with a T3 server on a Linux workstation. Dev installs and authenticates Prime Agent on the Linux workstation. Selecting Prime Agent on the phone runs against Linux files and Linux credentials.

## Phase summary

| Phase     | User-visible contract                                                                                                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP**   | Install and authenticate on the host; add and health-check an instance; discover a model and thinking level; run, stream, interrupt, continue, and stop a normal thread; use supported attachments and tools; see actionable failures across web, desktop, and mobile. No durable Prime resume guarantee. |
| **Alpha** | Prime-native live steering and queued follow-up, compaction, commands/skills, richer extension interactions, subagent observation, goals, and heartbeats, with visible state and reverse controls. Resident-daemon promotion is allowed only where a required T3-owned feature needs it.                  |
| **Beta**  | Durable Prime session loading and exact-resume recovery, explicit fallback choices, and single-writer conflict handling across devices.                                                                                                                                                                   |

# MVP

## 1. Prerequisites and host setup

### Install Prime Agent on the environment host

Prime Agent is not bundled into T3. On the environment host, install the stable Prime Agent release using its upstream installer:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
prime-agent --version
```

The `prime-agent` binary must be on the `PATH` visible to the T3 server and must be version **0.7.2 or newer**. Known-incompatible releases are blocked. An unknown newer release is allowed with a compatibility warning only after its RPC handshake and all required capability probes pass. If a version manager or nonstandard installation keeps the binary off that `PATH`, copy the absolute binary path reported by the host shell and enter it in the provider instance's **Binary path** setting.

Do not install Prime Agent merely on a remote browser, phone, or desktop client that is connected to another host.

**Example 1 — normal PATH:** `prime-agent --version` prints a version on the same Linux shell that starts `npx t3 serve`. Leave **Binary path** as `prime-agent`.

**Example 2 — version-manager path:** an SSH-launched T3 server cannot find a binary that an interactive shell can. On the SSH host, determine the absolute executable path and save that path on the Prime Agent instance. Refresh status; do not put a shell alias or an environment-variable assignment in **Binary path**.

### Authenticate Prime Agent on the host

T3 uses Prime Agent's ambient authentication. It does not add a Prime-specific API-key box and does not copy credentials to clients. Authenticate using Prime Agent itself on the environment host. For a subscription login, start it and use its login command:

```bash
prime-agent
/login
```

Then select the upstream provider and complete its flow. For an API-key provider, configure the key as documented by Prime Agent—for example, in the host environment or Prime Agent's own auth/configuration. If an unusual deployment needs instance-specific environment values, add them to the T3 provider instance's existing **Environment variables** section and mark secrets **Sensitive**.

A T3 health check uses a bounded, read-only RPC state/model usability probe. It may report that setup is required, but must not open a login prompt, log another session out, display a secret, alter Prime Agent's auth store, or leave a broad resident daemon behind. Account-detail display is not guaranteed; the MVP promises a usable/not-ready result and actionable guidance based on the bounded RPC handshake, state, and model-capability checks.

**Example 1 — subscription:** Priya SSHs into the server host, runs `prime-agent`, completes `/login` for an OpenAI subscription, exits Prime Agent, and presses **Refresh status** in T3. The instance becomes **Ready** if a compatible model is available.

**Example 2 — API key:** Lee configures a Prime-supported model provider using its documented host-side API-key method. If the T3 server service does not inherit that environment, Lee adds the required variable to this Prime Agent instance and marks it **Sensitive**. T3 stores it with existing provider-secret handling and does not return its value to the client after saving.

## 2. Add, configure, and enable an instance

**MVP**

In a web client or the desktop app connected with permission to manage the environment:

1. Open **Settings** → **Providers**.
2. Choose **Add provider instance**.
3. Select **Prime Agent**. Its built-in driver kind is `prime-agent`.
4. Give the instance a recognizable display name, such as `Prime Work`.
5. Keep **Binary path** as `prime-agent`, or enter an absolute host path.
6. Configure only the typed launch settings T3 exposes, plus optional environment variables. MVP has no unrestricted/free-form launch-arguments field. T3-owned RPC, working-directory, and session settings cannot be overridden.
7. Save the instance with **Enabled** on.
8. Select **Refresh status** and wait for a visible result.

The instance card shows at least: enabled state, installed version, compatibility state, last check time, auth/usability state, and an actionable message. Prime Agent can have multiple named instances when different binary paths, configurations, or ambient environments are needed.

Changing configuration or turning **Enabled** off stops only live T3-owned Prime work for that instance. Bound threads remain visible but show that their provider is unavailable until the instance is re-enabled or the user deliberately starts/moves work through a compatible supported flow. T3 never silently moves them to another model or provider.

**Mobile administration:** in MVP, mobile can use and inspect an already-configured instance, including its host-only setup errors, and can interrupt or stop its work. Adding and editing Prime Agent provider instances remains an environment-administration flow on web and desktop. Mobile must not offer a misleading phone-local login or binary-path flow.

**Example 1 — single instance:** Add `Prime Agent` with binary `prime-agent`; status shows `Ready`, an installed version, and discovered models. It then appears in the new-thread model picker.

**Example 2 — separate installation:** Add `Prime Beta Test` with `/opt/prime-beta/bin/prime-agent`. If its version is outside the tested band, only that instance shows an advisory or block; `Prime Agent` and non-Prime providers remain usable.

### Enable, disable, reconfigure, and remove

- **Enable:** makes a healthy instance selectable for new work.
- **Disable:** removes it from new-work selection and performs scoped cleanup of T3-owned sessions for that instance.
- **Reconfigure:** validates the new values, tears down only affected T3-owned work, then rechecks the instance.
- **Remove:** removes the instance configuration after warning about bound threads. Removal does not delete arbitrary Prime Agent sessions or credentials.

**Example 1 — reverse action:** Sam disables `Prime Work` during maintenance. Its bound thread reads **Provider disabled**. Sam enables it and refreshes status; in MVP, a later prompt may start a fresh Prime conversation rather than resume the old one.

**Example 2 — cleanup isolation:** Sam removes `Prime Test` while a separate `prime-agent` terminal session is running. T3 cleans up only the child/session identities it created; the terminal session continues.

## 3. Status, version, authentication, and model refresh

**MVP**

A Prime Agent instance can visibly report:

- **Disabled** — configured but not available for new work.
- **Checking** — a bounded host probe is running.
- **Ready** — compatible enough, usable authentication was found, and core discovery succeeded.
- **Setup required** — Prime Agent is present but no usable authentication/model setup was found.
- **Missing binary** — the configured executable cannot be started.
- **Incompatible** — the installation is below 0.7.2, is known incompatible, or fails a required handshake/capability probe.
- **Compatibility advisory** — an unknown newer version passed the required probes and is permitted to run with a warning.
- **Runtime error** — the last bounded check or live session failed.

The card shows the last check time so a user can distinguish current status from cached state. **Refresh status** rechecks the host installation, version, auth/usability, and model catalog without blocking the rest of T3.

Models come from that Prime Agent installation, not primarily from a catalog frozen into T3. Each selection preserves a structured identity containing the upstream provider and model ID, while the picker presents a readable combined slug such as `anthropic/claude-sonnet`. Equal model IDs from different upstream providers therefore cannot collide. The picker also shows capability-backed choices such as image support and thinking levels. A failed refresh may leave the last-known list visible as **Stale** when it is safe to do so. It must not pretend that stale data is current.

If a previously selected model disappears, it remains identified as unavailable and the user must deliberately choose another. If a thinking level is unsupported, it is omitted or rejected with a clear message, never silently claimed. Model switching after a thread has started is offered only when T3 can confirm that Prime Agent supports it for that session; otherwise the UI asks for a new thread/session.

**Example 1 — overlapping names:** both `anthropic/claude-sonnet` and a custom provider's `claude-sonnet` are returned. The picker labels their upstream providers so choosing one cannot route to the other by slug collision.

**Example 2 — refresh outage:** the model probe times out. Existing cached entries remain marked **Stale** and a retry action is shown. If `openai/gpt-x` was removed, T3 marks it unavailable and does not substitute another OpenAI or Anthropic model.

## 4. Create a Prime-backed thread

**MVP**

1. Choose or add the project on the environment that owns the Prime Agent installation.
2. Start a new thread/task.
3. Open the provider/model picker and choose the named Prime Agent instance.
4. Choose an upstream provider/model from that instance's discovered list.
5. Choose one of the model's advertised **Thinking** levels, if present.
6. Choose the normal T3 workspace mode and permission controls that apply to the project.
7. Enter the first prompt, optionally add supported attachments, and send.

The resulting thread binds to the specific Prime Agent **instance**, not just the generic Prime Agent driver. T3 launches one owned Prime RPC process/session for that live thread in its effective host workspace and stores its Prime session data in a T3-scoped Prime session directory. Concurrent T3 threads remain isolated. That scoped directory supports safe ownership and isolation in MVP; it does **not** create a durable resume promise before Beta.

**Example 1 — analysis task:** In project `billing-api`, choose `Prime Work` → `anthropic/claude-sonnet` → **High** thinking, enter `Find why refunds can be duplicated and propose a fix`, then send.

**Example 2 — image task:** In project `mobile-ui`, choose a Prime model whose capability row includes images, attach `broken-header.png`, enter `Match this header to the design and explain the changed files`, then send.

## 5. Prompts, attachments, tools, and streamed output

**MVP**

### Normal turns and streaming

After send, the normal T3 timeline shows assistant text as it streams, reasoning where T3 permits it, tool start/progress/completion, interaction requests that T3 can represent, errors, and an unambiguous turn completion. Tool updates should update existing activity rather than repeatedly copying an ever-growing transcript.

The agent uses the project files and Prime capabilities available on the host. T3 does not reimplement Prime's tools. Tool arguments, results, and filesystem effects are presented through T3's normal activity, file diff, and checkpoint surfaces.

**Example 1 — tool-heavy change:** Ask `Run the focused parser tests, fix the failure, and summarize the diff.` The timeline streams an assistant response and tool activity; the Review/diff surface shows workspace changes.

**Example 2 — read-only answer:** Ask `Explain how provider status reaches the mobile client; do not edit files.` The response streams normally. With no edits, the checkpoint/diff may be empty; a separate tool example would be redundant because Example 1 already covers the distinct tool-output path.

### Attachments

MVP accepts T3 text attachments and, when the selected model advertises image support, T3 image attachments. Existing T3 attachment size, count, and other input limits apply. Every other attachment type—including generic binary archives, audio, and video—is rejected **before** the turn with the offending attachment identified and a recovery action such as removing it or choosing a capable model. T3 never silently drops an attachment.

**Example 1 — text:** Attach `error.log` and ask `Trace this failure to the relevant code.` If text files are within the published limits, both prompt and attachment are submitted.

**Example 2 — unsupported image model:** Attach `layout.png` while a text-only model is selected. Send is blocked with `This model does not accept images`; choose an image-capable model or remove the image.

### Representable user input

MVP represents typed confirmation, single-select, multi-select, text input, and editor-text requests when they can be mapped safely to T3. T3 shows its normal approval/input card, operable remotely by an authorized client. If an interaction or custom UI cannot be represented safely, T3 cancels it and reports the unsupported interaction visibly; it cannot wait forever on invisible terminal UI.

**Example 1 — confirmation:** a tool asks for confirmation before a represented action. T3 shows **Approve** and **Reject**; either choice clears the pending state.

**Example 2 — unsupported custom overlay:** an extension requests terminal-only animated UI. T3 reports that this Prime interaction is unsupported and cancels/fails it rather than showing a permanent spinner.

## 6. Interrupt, prompt again, and stop

**MVP**

### Interrupt a running turn

Use the normal **Interrupt** control while a turn is running. T3 sends Prime's abort operation and moves the turn to a truthful terminal state such as interrupted, even if the child exits abnormally. Late output cannot make the UI look running forever. If Prime leaves the live session usable, the composer accepts a subsequent prompt.

**Example 1 — wrong direction:** Interrupt while the agent is refactoring the wrong module. After **Interrupted** appears, send `Only change the serializer; leave the transport alone.`

**Example 2 — long command:** Interrupt a long test/tool run. The activity ends as interrupted or failed with its actual outcome; it is not labeled completed.

### Subsequent prompts

After a completed or recoverably interrupted turn, send another prompt from the same thread. While that owned live process remains healthy, Prime receives it in the current live conversation. MVP does not promise that this conversation survives process loss, provider disablement, or T3 restart.

**Example 1 — refinement:** after a patch completes, send `Add a regression test for the null-token case.` Prime can use the current live conversation context.

**Example 2 — after interrupt:** after interrupting, send `Continue from the current files, but first show git diff.` The workspace remains authoritative even if some conversation work was aborted.

### Stop the provider session

Use the thread/session **Stop** action to end the live Prime session without deleting the thread. T3 closes its owned RPC input, waits a bounded period, then terminates only the exact captured child if needed. The thread history, workspace changes, T3 checkpoint, and diff remain visible. Sending again may create a fresh Prime conversation in MVP; the UI must not call that a resume.

Archiving or deleting a T3 thread follows T3's normal confirmation and workspace rules. It does not authorize broad Prime daemon cleanup or deletion of unrelated Prime histories.

**Example 1 — finished work:** Stop after reviewing the response. Reopen the thread later to read it; a new prompt may start a new Prime conversation against the current files.

**Example 2 — stuck child:** the process ignores graceful close. T3 force-stops only the PID/session handle it captured and reports the abnormal stop. Another Prime terminal or another T3 thread keeps running.

## 7. Checkpoints and the MVP continuity limit

**MVP — important limitation**

T3 checkpoints capture and restore the **workspace** through T3's existing source-control lifecycle. They are not Prime conversation snapshots.

- Restoring a checkpoint can rewind files.
- It does **not** rewind what the live Prime conversation has already seen or said.
- MVP and Alpha do **not** guarantee durable loading of that Prime conversation after a server restart, child crash, disable/re-enable, upgrade, or stop.
- T3's projected transcript remains readable, but replaying it is not the same as restoring Prime's internal session.

After a checkpoint restore, T3 warns that the workspace was restored but the Prime conversation did **not** rewind, and recommends starting a new or forked conversation before continuing. Until Beta, process loss may also require a fresh Prime conversation; T3 must disclose that loss rather than imply an exact resume.

**Example 1 — restore divergence:** Prime edits three files and discusses them. You restore the pre-turn checkpoint. The files revert, but the live agent may still remember having edited them. Tell it `The workspace was restored; re-read current files before continuing`, or start fresh.

**Example 2 — server restart:** a thread has a visible T3 transcript, then the server restarts. MVP may be unable to reload the exact Prime session. T3 shows that continuity is unavailable rather than silently labeling a fresh process **Resumed**.

## 8. Web, desktop, mobile, and remote connections

**MVP**

All clients use the same T3 server-side provider session:

- **Locally hosted web:** the browser connects to the local T3 server; Prime runs on that server host.
- **Hosted web (`app.t3.codes`):** after pairing with a reachable environment, Prime still runs on the paired host. HTTPS/mixed-content rules affect connectivity, not provider placement.
- **Desktop:** for a locally hosted environment, the desktop server owns Prime. For an SSH or other remote environment, the remote host owns Prime.
- **Mobile:** select a configured instance/model, create and view threads, answer supported interactions, interrupt, and stop. Setup messages say **Run this on the environment host**.
- **LAN/tailnet, relay, and tunnel:** they transport T3 commands and normalized events. They do not move the binary, auth store, filesystem, or Prime session onto the client.

Two devices viewing one thread see the same projected state. A second connection does not spawn a second Prime process. Existing T3 authorization and conflict rules determine who may send, answer, interrupt, or stop.

**Example 1 — handoff between devices:** start a turn in the desktop app, leave it open, then watch it stream on mobile over a tailnet. Interrupt from mobile. Desktop and mobile converge on **Interrupted**; only one host process was running.

**Example 2 — tunnel reconnect:** a browser temporarily loses its tunnel while the host and Prime process continue. On reconnect it receives the projected thread state. MVP does not promise that a host/server failure during the gap can resume Prime's internal conversation.

## 9. MVP errors and recovery

**MVP**

| What you see                                 | Meaning                                                                                                          | Recovery                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Missing binary**                           | Host cannot execute configured path.                                                                             | Install on the host or correct **Binary path**, then refresh.                                 |
| **Setup required**                           | Installation is present but no usable auth/model setup was detected.                                             | Authenticate/configure on the host, then refresh.                                             |
| **Incompatible**                             | Required RPC semantics are known to be unavailable.                                                              | Follow shown upgrade/downgrade guidance; do not force-start a session.                        |
| **Compatibility advisory**                   | An unknown newer version passed the required handshake and capability probes but is outside the tested baseline. | It may start with the warning visible; update/refresh if operation later proves incompatible. |
| **Model refresh failed / Stale**             | Discovery timed out or failed.                                                                                   | Retry; use a current confirmed model. No silent fallback.                                     |
| **Selected model unavailable**               | A saved choice disappeared or cannot be selected.                                                                | Deliberately choose another discovered model or wait for it to return.                        |
| **Unsupported thinking level**               | Choice is not advertised for the model.                                                                          | Select an offered level.                                                                      |
| **Unsupported attachment**                   | Type/size/count/model capability does not match.                                                                 | Remove it or choose a capable model before resending.                                         |
| **Start timed out / process exited**         | Handshake failed or Prime stopped.                                                                               | Read bounded diagnostics, retry or stop; other providers remain available.                    |
| **Malformed/incompatible protocol response** | Prime output could not safely be understood.                                                                     | Stop/retry after version check; report diagnostics without prompt or secrets.                 |
| **Interaction unsupported**                  | Prime requested UI T3 cannot represent.                                                                          | Cancel/fail the request; retry without that extension/action.                                 |
| **Cleanup warning**                          | T3 cannot prove a resource is its own.                                                                           | Leave it running and show guidance; never kill speculatively.                                 |
| **Conversation continuity unavailable**      | Exact Prime state cannot be loaded in MVP.                                                                       | Continue as fresh with explicit context or create a new thread.                               |

Every accepted turn must leave the UI in a terminal state exactly once. A provider failure is isolated to its instance/thread; T3 and other providers continue to work.

**Example 1 — missing binary:** T3 on a remote Linux host shows `/usr/local/bin/prime-agent not found`. Installing Prime Agent on the laptop browser does nothing. Correct the Linux host path, press **Refresh status**, then retry.

**Example 2 — crash after edits:** Prime exits after changing files but before a final message. T3 marks the turn failed, retains normal diff/checkpoint visibility, and offers retry/stop. It does not claim that retry resumes the lost Prime conversation.

# Alpha

> Everything below has shipped. A control is enabled only when the installed Prime version advertises the required capability, and T3 always provides an entry point, visible current/pending state, remote behavior, and a reverse action. On an installation that lacks a capability, that one control stays disabled with an explanation while everything else — including the whole MVP — keeps working.

## 10. Steer now or follow up later

While a turn runs, a second instruction may offer:

- **Steer current turn** — send the instruction into the active run.
- **Queue follow-up** — visibly hold it until the active run completes.

Queued items synchronize across clients. They can be inspected and removed/cancelled where Prime permits. If delivery becomes uncertain after a disconnect, T3 shows that uncertainty instead of duplicating the prompt.

**Example 1 — steer:** while Prime edits authentication, send `Do not change the public API` and choose **Steer current turn**. The instruction appears as delivered to the active run.

**Example 2 — follow-up:** while tests run, send `Afterward, update the changelog` and choose **Queue follow-up**. It appears in a pending queue with **Remove**; removing it prevents delivery if not already sent.

## 11. Context and compaction

T3 may show Prime-reported context usage and compaction state, and offer **Compact now**. Compaction is a Prime conversation operation, not a T3 checkpoint. It shows running, completed, failed, and retry states. Auto-compaction/retry indicators update at bounded frequency.

A reverse action cannot literally expand a compacted context. Manual compaction therefore requires clear disclosure that it is not reversible; retry after failure and fork/start fresh before compacting are the available recovery paths. The implementation may select confirmation wording and placement without changing this contract.

**Example 1 — manual:** context is nearly full. Select **Compact now**, confirm the irreversible conversation operation if required, and wait for **Compacted** before sending more work.

**Example 2 — failure:** compaction fails after a network error. The thread shows **Compaction failed** with **Retry**; it does not mark a T3 checkpoint restored or discard the visible transcript.

## 12. Commands, skills, and prompt templates

Eligible Prime commands, discovered skills, and prompt templates may appear in T3's composer command menu with a **Prime Agent** origin label. TUI-only commands and raw daemon administration are excluded. Availability follows the selected instance/version and can refresh after resources change.

Commands that toggle state need a visible current value and inverse action. One-shot prompt expansion has no persistent reverse state; before send it can be edited/removed like normal composer text, and after send it is ordinary thread input.

**Example 1 — skill:** type `/` and choose `Prime Agent · skill:review`. T3 expands or invokes it according to its advertised semantics and shows the origin before send.

**Example 2 — toggle command:** invoke an eligible Prime tool-mode command. The UI shows the active mode and an **Off/reset** action. A terminal-only `/settings` screen is not exposed as a broken remote overlay.

## 13. Extension UI

Typed single-select, multi-select, confirmation, text-input, and editor-text requests map to remotely operable T3 cards or sheets when safely representable. Notifications and status updates use bounded transient UI rather than flooding the transcript. Closing, rejecting, or cancelling clears the request when Prime supports it. Unsupported custom rendering remains unavailable.

**Example 1 — select:** an extension asks which package to test. T3 renders a selection card; choose `server` and submit from mobile.

**Example 2 — cancel:** an extension opens a text input for a release note. Select **Cancel**; all clients see the request close and Prime receives cancellation rather than waiting invisibly.

## 14. Subagents and observation

Prime root/subagent activity may appear in T3's **Agents** surface using stable Prime session identities. Users can inspect state and bounded output without copying every event into the main transcript. Stop/message/observe actions target only sessions the user is authorized to access and that T3 owns or has explicitly adopted.

Reverse actions are **Stop observation** for a view and **Stop subagent** for owned active work. Alpha does not adopt non-T3-created Prime sessions unless a later, separately approved usage contract adds that behavior.

**Example 1 — inspect:** the root delegates two repository searches. **Agents** shows both running; open one to inspect its recent activity, then close observation without stopping it.

**Example 2 — stop:** a T3-owned subagent loops on a failing task. Choose **Stop subagent**, confirm the exact target, and see it become stopped while the root and sibling continue.

## 15. Goals and heartbeats

Prime's current goal and the heartbeats you create in T3 appear together in the **Agents** surface. Only heartbeats created here are listed: schedules made elsewhere in Prime Agent are never shown and never changed by T3.

Creating a heartbeat keeps the Prime session resident so the schedule can run while the thread is closed. T3 states that before you confirm, and afterwards names the exact owner of the resident session.

Available actions:

- goal: read-only. Prime reports progress; this version of Prime Agent has no goal-change command, and T3 says so instead of offering a button that would do something else.
- heartbeat: **Pause**, **Resume**, and **Delete**, always available on the row.
- resident activity: stop the exact T3-owned session — never a global Prime shutdown.

**Example 1 — goal:** Prime reports `Finish provider adapter review` with its progress. The line stays visible in the Agents surface while the goal runs; there is no goal control to press, and none is shown.

**Example 2 — heartbeat:** schedule a heartbeat to check CI every 20 minutes. Confirm the residency notice, then the row shows the interval, the next run, and the owner. **Pause** stops runs, **Resume** restarts them, and **Delete** removes that one schedule. Delete the last one and T3 stops claiming the session is resident on your behalf.

## 16. Prime session naming and forking

Name the Prime session behind a thread, and fork it into a new thread when you want to try something without losing where you are. Both appear in the Agents surface on web and desktop, and in the composer block on mobile, whenever the installed Prime Agent supports them. An older Prime says so in that spot instead of leaving it blank.

**Renaming** asks Prime for exactly the name you typed. A name that would have to be shortened or cleaned up is refused with the reason, rather than quietly becoming a different name. The T3 thread title follows the session, so one piece of work never carries two names. Renaming again is the reverse; there is nothing to undo.

**Forking** starts a new Prime session from a point you choose — one of the recent messages, or the whole session — and creates a new T3 thread for it. The list of fork points is the most recent ones; longer conversations say so rather than listing everything. Forking is disclosed before it happens, and cancelling that confirmation does nothing at all: no session, no thread.

The new thread records where it came from: the thread it was forked from, the label of the point it was forked at, and that thread's latest checkpoint at that moment. A forked thread shows that line at the top on web and desktop, and above the composer on mobile, with **Open source thread** next to it to take you back. That ancestry is a T3 record and sits outside the Prime Agent controls, so it stays readable and navigable even with Prime Agent uninstalled and every session long gone. The original thread is untouched.

**This is not durable resume.** A fork starts a _new_ session now. It does not reopen a past session, and nothing about it survives a server restart as a resumable conversation; durable resume is Beta.

**Example 1 — rename:** rename the session to `Migration work`. The session name and the thread title both read `Migration work`; rename it again whenever you like.

**Example 2 — fork:** pick `Adapter drafted` as the fork point, confirm the notice, and a new thread appears carrying that ancestry. Your original thread keeps running exactly as it was.

# Beta

## 17. Durable resume after restart or process loss

**Beta** persists a minimal opaque Prime resume cursor for T3-created sessions. Before accepting a new prompt after restart/loss, T3 validates the environment, provider instance, workspace, session identity, ownership, and compatibility, then either adopts the exact still-live owned session or asks Prime to load it.

The thread shows one of: **Reconnecting**, **Resumed**, **Resume unavailable**, **Incompatible session**, **Missing session**, or **Fork required**. A failed exact resume never silently creates a fresh conversation under the old session identity.

**Example 1 — server restart:** finish a turn, restart the T3 server, reopen the thread, and see **Resumed** before the composer sends the next prompt. Prime continues the exact durable provider session.

**Example 2 — missing session:** the cursor remains but its owned Prime session file is missing. T3 shows **Missing session** and offers explicit recovery rather than sending into a new hidden conversation.

## 18. Recovery choices

When exact resume is unsafe or impossible, offer supported choices:

- **Retry resume** after fixing installation, connectivity, or compatibility.
- **Fork** into a new Prime/T3 thread where Prime can safely fork from the durable source.
- **Start fresh** with a clearly new provider session while preserving the original T3 transcript/checkpoints as readable history.

Cancel/close leaves the thread readable and sends nothing. Exact wording and any safely generated textual context-handoff presentation are implementation details; they must not obscure whether the result is retry, fork, or fresh conversation.

**Example 1 — incompatible upgrade:** an updated Prime version cannot load the cursor. Downgrade/upgrade as guided, refresh the instance, and choose **Retry resume**.

**Example 2 — unsafe workspace mismatch:** the project now points elsewhere. Choose **Start fresh** to create a clearly labeled new Prime session in the current workspace; the old transcript remains read-only history.

## 19. Multi-device resume and turn conflicts

The server is the single writer for one durable Prime session. Two clients cannot race two workers onto it. One resume/turn becomes authoritative; the loser receives a typed conflict and current state rather than spawning a duplicate process.

**Example 1 — simultaneous send:** phone and desktop send at nearly the same time. One turn is accepted; the other client sees `Another turn is already authoritative` and can keep/edit its unsent prompt or queue it if supported.

**Example 2 — simultaneous recovery:** two browsers open a stopped durable thread. The server performs one resume. Both observe the same **Resumed** session; only one Prime worker is created.

## 20. Durable cleanup and retention

Beta durable Prime sessions live beneath **T3 home**, scoped by T3 environment and Prime Agent provider instance. Archiving a thread retains its durable Prime session. Permanent deletion requires confirmation, targets only the selected T3-owned session files/resources, and reports success or failure. Removing an environment offers an explicit choice to retain or delete its durable Prime sessions; deletion requires confirmation and remains scoped to that environment's T3-owned resources. A future-version cursor read by an older T3 build remains preserved as unavailable instead of being discarded.

Retention duration, backup integration, migration mechanics, and final confirmation wording may be selected during implementation, but cannot weaken the retain/archive/delete behavior above.

**Example 1 — archive:** archive a durable thread. Its Prime session remains beneath the environment/instance scope in T3 home and is available when the thread is restored or unarchived.

**Example 2 — permanent delete:** choose **Delete Prime session permanently**, review the owned-resource scope, and confirm. T3 deletes only the selected T3-owned durable resource, not all Prime sessions on the host.

# Updates, compatibility, cleanup, and privacy

## 21. Update Prime Agent and handle incompatibility

**MVP and later**

Check the instance card for installed version, compatibility advisory, and last refresh. Update on the environment host using Prime Agent's supported update command:

```bash
prime-agent update
prime-agent --version
```

Then return to **Settings** → **Providers** and select **Refresh status**. Finish or stop active work first because reconfiguring/updating the binary can end T3-owned live sessions. The minimum supported baseline is Prime Agent **0.7.2**.

Versions below the minimum and releases known to be incompatible are blocked from starting sessions with upgrade/downgrade guidance. Unknown newer versions are permitted with a visible warning only after their RPC handshake and every required capability probe pass. Unknown additive events may produce a bounded warning while core operation continues; changed required semantics fail only the affected operation. T3 never silently falls back to ACP.

**Example 1 — supported update:** stop active sessions, run `prime-agent update` on the host, refresh status, and see **Ready** with the new version and refreshed models.

**Example 2 — incompatible version:** refresh reports `Prime Agent version X is incompatible`. Existing T3 history remains readable and other providers work; follow the displayed version guidance before starting Prime work.

## 22. Cleanup expectations

T3 owns only the Prime subprocess/session resources it created or explicitly adopted. Stop a thread session, disable/remove the instance, or shut down the T3 environment using normal controls. T3 performs bounded, idempotent cleanup of those exact handles.

Do not use Prime-wide `shutdown`, pattern-based process killing, or deletion of the global Prime directory merely to clean up T3. If ownership cannot be proven, T3 leaves the resource alone and shows a cleanup warning. T3 does not log the user out of Prime when an instance is removed.

**Example 1 — environment shutdown:** shutting down T3 closes its owned Prime sessions. A Prime Agent session started independently in another terminal is untouched.

**Example 2 — remove configuration:** remove `Prime Work`; its T3 provider configuration disappears, but Prime credentials and unrelated saved sessions remain on the host.

## 23. Privacy, logs, and diagnostics

Prime prompts, assistant output, tool arguments/results, file contents and paths, raw session transcripts, goal text, heartbeat prompts, and agent messages are excluded from product analytics. Credentials and sensitive instance variables are redacted from settings responses, diagnostics, logs, analytics, and errors.

Operational metadata may include provider/instance identifiers, T3 thread/turn correlation IDs, operation, duration, outcome/error class, process exit code, protocol event type, queue depth, coalesced/dropped update counts, installed version, and compatibility band. User-authored instance display names should not become analytics dimensions.

Normal logs contain canonical metadata, not raw Prime RPC payloads. If opt-in native protocol diagnostics are offered, they are bounded, stored under T3-controlled diagnostics, disclosed before collection, and aggressively redacted. A diagnostics bundle must show what it will include and exclude secrets/content by default.

Remote clients receive only the canonical state needed to render the product. T3 does not send a host credential, raw environment value, or absolute path merely to show provider status. A remote client's access remains bounded by T3 authorization; it does not gain a browser for arbitrary Prime daemon sessions.

**Example 1 — support bundle:** before exporting diagnostics, T3 previews categories such as versions, operation outcomes, and exit codes. Prompt text, tokens, file contents, and sensitive variables are absent by default.

**Example 2 — remote error:** mobile sees `Prime Agent setup required on Workstation` and a coarse error class. It does not receive the host's API key, auth file, or full credential-bearing environment.

# Development and integration verification

The current host Prime Agent installation is explicitly available for development and integration verification of this proposed integration. Tests must still isolate T3/Prime session directories, configuration, and daemon resources whenever the operation could mutate them. Verification may exercise the installed binary and its bounded read-only state/model probes, but must never destructively modify live authentication, unrelated Prime sessions, or live daemon state. Production-oriented tests use isolated session/config/daemon resources rather than treating the maintainer's live installation as disposable test state.

# End-to-end checklists

## MVP first use

1. On the environment host, install Prime Agent and confirm `prime-agent --version`.
2. Authenticate/configure an upstream model provider using Prime Agent on that host.
3. In T3, open **Settings** → **Providers** → **Add provider instance** → **Prime Agent**.
4. Set display name and binary path; add sensitive environment values only if necessary.
5. Enable and **Refresh status** until the instance reports **Ready**.
6. Open a project on that environment and create a new thread.
7. Select the Prime instance, upstream provider/model, and advertised thinking level.
8. Add a prompt and supported attachments; send.
9. Watch streamed text/tool activity; answer supported inputs or interrupt as needed.
10. Send follow-up prompts while the live session remains healthy.
11. Review workspace diff/checkpoint separately from Prime conversation state.
12. Stop the live provider session when finished. Do not assume it can durably resume in MVP.

## MVP failed-start recovery

1. Read the instance/thread state; do not repeatedly send while status is unknown.
2. Fix the named host issue: binary path, auth, version, model, thinking level, or attachment.
3. Select **Refresh status** for installation/auth/model changes.
4. Deliberately reselect a model if the old one is unavailable.
5. Retry the turn only after T3 shows a terminal failure and the composer is ready.
6. If process continuity was lost, continue with explicit context or start a new thread; do not treat it as an exact resume.
7. If cleanup ownership is uncertain, leave the process/session alone and follow scoped guidance.

# Remaining implementation details

The product behavior above is approved, but remains proposed and unshipped until implementation lands. Implementation planning may still choose details that do not alter the approved usage contract, including:

- exact labels, status copy, warning placement, confirmation wording, and visual layout;
- bounded timeouts, cache freshness intervals, diagnostics limits, and retry presentation;
- the precise typed launch-setting schema, provided it does not expose unrestricted launch arguments;
- retention duration, backup integration, and migration mechanics beneath the approved Beta T3-home/environment/instance scope;
- internal capability-probe and wire representations, provided they preserve the approved compatibility, model-identity, interaction, isolation, and ownership behavior.

Any proposed change to supported phases, client responsibilities, resource ownership, attachment/interaction kinds, compatibility gates, continuity claims, or retention semantics is a product-contract change and requires renewed usage approval.
