# Prime Agent retention, cleanup, crash recovery, and rollback

Companion to `prime-agent-rollout.md` (staged rollout, drain, orphan safety) and
`prime-resume-storage.md` (cursor storage). This page covers the only paths that may
destroy a durable Prime resource.

## What never deletes

Stop, archive, turning an instance **Enabled** off, staged rollout and rollback are
lifecycle actions, not deletions. Thread history, the durable Prime session and the
resume cursor all survive every one of them, and the reverse action is always
available. Nothing in T3 turns one of those into a deletion.

Only four events may plan a deletion, and each still requires explicit confirmation:

| Event                     | Cleanup reason    |
| ------------------------- | ----------------- |
| Explicit thread delete    | `explicitDelete`  |
| Provider instance removed | `providerRemoval` |
| Instance reconfigured     | `reconfigure`     |
| Storage migration         | `migration`       |

Removing a provider instance from settings tears down its running entry and emits a
_removal notice_. The notice is not a cleanup: durable resources stay exactly where
they are until an operator confirms a scoped deletion.

## Dry run first

Cleanup always produces a plan before it does anything. The plan is derived from this
T3 home's own resource layout for one proven scope — environment, instance, project and
thread — so another T3 home, another environment and any Prime resource T3 did not
create are structurally out of range. It lists a bounded manifest of targets by opaque
token, and it refuses or defers rather than guessing:

- **Refuses** a non-destructive lifecycle event, a missing confirmation, or a
  confirmation that names a different scope.
- **Defers** while a valid single-writer lease is held or an adoption is in flight. The
  lease is re-read immediately before the first irreversible step, so a plan that went
  stale loses the race instead of deleting.
- **Retains** anything whose ownership cannot be proven — including a resume cursor at
  the expected path that was recorded by another scope, which stops the whole run.

## Crash recovery

Each run writes a versioned journal row (`prime_cleanup_journal`, journal version 1)
_before_ it removes anything, and updates it after each step. A crash therefore always
leaves a durable statement of what was already proven done, and re-running resumes and
skips exactly those steps — a captured process is signalled at most once across a crash
boundary. On startup, unfinished rows can be listed and resumed per scope; a completed
run leaves no row.

A journal row whose version this build cannot interpret reads as _no resumable cleanup_
and is left in place for the build that wrote it. An unreadable plan never authorizes a
deletion.

## Partial failure

If the platform removal boundary retains a resource, the run reports `incomplete` and
`resumable` with a short, actionable reason. The report carries scope **digests** only —
no host path, thread/project/environment id, transcript or setting — so it is safe to
log, send to a remote client, or paste into an issue. Investigate manually and re-run;
do not hand-delete.

## Rollout and rollback

Staged rollout enables or disables `prime-agent` only; there is no global provider
switch and no automatic scan. Rollback deletes nothing: cursors, ownership records,
journals and any unknown newer fields are preserved verbatim, and a cursor written by a
newer build reads as _unavailable_, not corrupt, with its payload kept in a
version-keyed sidecar. The cleanup journal table is additive, so an older build simply
ignores it.

Order for a downgrade: disable the instance, let proven owned work drain, verify no
journal row is left unfinished, then deploy the older build.
