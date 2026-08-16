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

Removing (or replacing) a provider instance in settings tears down its running entry
and writes a _removal notice_ to the server log — `provider instance removed; durable
data untouched`, annotated with the instance id, the driver, whether it was `removed`
or `replaced`, and `deletesDurableData=false`. The notice is not a cleanup: durable
resources stay exactly where they are until an operator confirms a scoped deletion.

## What is wired today

Be precise about which parts of this page are automatic and which are not:

- **Automatic.** The removal notice above, and startup recovery: when a Prime instance
  starts, it lists unfinished cleanup journal rows, keeps only the rows whose scope key
  decodes to _this_ environment, _this_ instance and _this_ T3 home, and resumes each
  one. A row belonging to another instance or another home is never touched.
- **Not yet a user-facing surface.** There is no button, command-palette entry or CLI
  subcommand that starts a _new_ deletion. Planning, confirming and executing a scoped
  cleanup is a server-side API (`planPrimeCleanup` / `executePrimeCleanup`) with no
  operator entry point. `PA-B06` certified the behavior that exists; it deliberately
  added no new capability, so there is still no confirmation UI and no product action
  deletes durable Prime data at all — which is the safe direction to be incomplete in.
  A future milestone owns the operator surface.

## Dry run first

Every deletion produces a plan before it does anything. The plan is derived from this
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
boundary. On startup each Prime instance resumes the unfinished rows it owns, as
described above; a completed run leaves no row.

A run that cannot ever succeed is parked, not retried. If the resume cursor at the
derived path was recorded by a different scope, the row is written `refused` and startup
recovery never lists it again — otherwise every boot would re-read the same foreign
cursor and re-refuse it forever.

A journal row whose version this build cannot interpret reads as _no resumable cleanup_
and is left in place for the build that wrote it. An unreadable plan never authorizes a
deletion.

## Partial failure

If the platform removal boundary retains a resource, the run reports `incomplete` and
`resumable` with a reason drawn from a fixed vocabulary — `ownershipIdentityUnproven`,
`ownershipRecordChanged`, `ownershipCleanupUnavailable`, `ownershipCleanupFailedClosed`,
`ownershipRetained`, `cursorScopeMismatch`, `cursorScopeUnproven`. The vocabulary is
closed on purpose: the underlying failure text can carry an absolute path and the ids
encoded into it, so it is classified and then discarded rather than truncated. The
report therefore carries scope **digests** and these codes only — no host path,
thread/project/environment id, transcript or setting — so it is safe to log, send to a
remote client, or paste into an issue. Investigate manually and re-run;
do not hand-delete.

## Rollout and rollback

Staged rollout enables or disables `prime-agent` only; there is no global provider
switch and no automatic scan. Rollback deletes nothing: cursors, ownership records,
journals and any unknown newer fields are preserved verbatim, and a cursor written by a
newer build reads as _unavailable_, not corrupt, with its payload kept in a
version-keyed sidecar. The cleanup journal table is additive, so an older build simply
ignores it.

Order for a downgrade: disable the instance, let proven owned work drain, confirm the
`prime_cleanup_journal` table has no row whose `status` is `running` or `incomplete`
(`completed` and `refused` are terminal), then deploy the older build.
