# Prime Agent MVP rollout, drain, and rollback

## Staged rollout

1. Enable one named `prime-agent` instance on an environment with a supported binary.
2. Refresh status. The check is an isolated, read-only version/RPC handshake; **setup required** is expected without isolated credentials.
3. Start a normal thread and verify streaming, tool/interactions, interrupt and stop on each applicable client (web, desktop, mobile use/inspection).
4. Expand by environment/instance only after redacted evidence is retained. Do not enable a global provider switch.

## Emergency disable and drain

Set **Enabled** off for the affected Prime instance. This is Prime-only: do not stop the T3 server or other providers. Let existing owned turns drain where safe; use thread stop for an immediate user-requested stop. T3 only signals a captured PID after matching its recorded start token. It never pattern-kills or administers broad Prime daemons.

## Diagnostics and orphan safety

Collect the compatibility band, hash-only transcript, resource/PID manifest and ownership warning. Do not paste prompt text, tokens, credentials, raw stderr, raw paths, or account information. If exact ownership or PID identity cannot be proven, retain the resource and show an actionable orphan warning; investigate manually rather than deleting it.

## Resident sessions and owned heartbeats

A T3-created Prime heartbeat can keep its session resident so the schedule can
run while the thread is closed. That is the only thing in T3 that deliberately
keeps a Prime session alive past a turn, so it has its own cleanup rules:

- **T3 stops only heartbeats it created.** Each owned heartbeat id is recorded
  in the ownership record when it is created. Cleanup proves each id and stops
  it individually, before releasing the daemon session that keeps it resident.
  A schedule created in the
  Prime TUI or by another tool is never listed, never targeted, and never
  stopped — there is no stop-all path to invoke.
- **Ownership survives a restart.** The record is per thread, not per session.
  A new session for the same thread reads the recorded ids back before it
  rewrites the record, then re-reads the runtime's schedule once so the
  surviving heartbeat reappears on the board and stays pausable and stoppable.
  Ids the runtime no longer reports are dropped at that point, so the record
  never keeps a handle cleanup could not prove.
- **Unprovable means untouched.** If an id cannot be proven, that heartbeat and
  everything after it in the cleanup sequence is left alone and the ownership
  record is retained for a later pass. Investigate manually; do not hand-delete.
- **Stop the session, not the daemon.** The reverse control for a resident
  session stops that exact T3-owned session. Never stop a shared Prime daemon to
  clear T3 state.
- **Draining.** Deleting a thread's owned heartbeats removes the reason T3 keeps
  that session resident; the session itself still ends through the ordinary
  thread stop or the instance **Enabled** switch.

## Rollback/downgrade

Disable Prime, drain/stop its proven owned work, and deploy the previous T3 version. Preserve Prime settings, ownership records, sessions and unknown/newer fields verbatim for a later compatible re-enable; do not rewrite them to an older schema. A downgrade cannot promise resume of unproved opaque provider state. Re-enable only after a fresh isolated check.
