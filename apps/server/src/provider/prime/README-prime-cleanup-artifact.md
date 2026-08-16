# PA-B05 durable cleanup, retention and rollback review artifact

`prime-cleanup-artifact.mjs` is a deterministic standalone Node ESM bundle built from the
checked-in cleanup planner/executor, the Prime ownership proof boundary, the resume-cursor codec
and the PA-B03 arbitration lease. Nothing in it is mocked or re-implemented.

SHA-256: `3133b460e3b812369215db1f74a09df8376edf3853443a391226fd4bd5037dc0`.

Run the committed artifact directly:

```sh
node apps/server/src/provider/prime/prime-cleanup-artifact.mjs
```

Regenerate and execute it from a fresh checkout:

```sh
apps/server/src/provider/prime/generate-prime-cleanup-artifact.sh
```

Prove deterministic regeneration without replacing the committed artifact:

```sh
apps/server/src/provider/prime/generate-prime-cleanup-artifact.sh --check
```

The verifier reports 88 source-derived assertions over a disposable **two-home** tree. Each home
holds two owned Prime threads plus two sentinels — a Prime-shaped file this T3 never created and a
file outside the Prime namespace — and both homes are removed at the end.

1. **Retention.** Every lifecycle event is printed with the cleanup it is allowed to mean. Stop,
   archive, instance-disable, rollout and rollback map to _no cleanup_ and plan zero targets; only
   explicit delete, provider removal, reconfiguration and migration may plan a deletion.
2. **Dry run.** The manifest is bounded (two targets), every path is inside the home it was derived
   from, and the printed tokens are opaque digests, not paths. Planning removes nothing.
3. **Arbitration.** With a real PA-B03 lease held, the confirmed run _defers_ and does not even open
   a journal. A confirmation carrying a different scope digest is refused.
4. **Crash barrier.** The journal is made to fail at write 1, 2 and 3 in turn. A crash before
   anything was journaled is not resumable and deleted nothing; a crash after leaves a durable row
   that `resumePrimeCleanup` finishes, and the captured process is signalled at most once across the
   whole boundary. In every case the sibling thread and the unowned sentinel survive.
5. **Destructive run.** After the writer's lease lapses, the confirmed run completes: the target
   thread and its cursor are gone, and the sibling thread, the second T3 home and both sentinels are
   byte-for-byte untouched. Re-running is a no-op, and the deleted thread reads back as
   `{"status":"unavailable","reason":"missing"}` — never as a silently fresh session.
6. **Rollback.** Every rollout transition is `prime-agent`-scoped with `deletesDurableData=false`. A
   cursor written by a newer build decodes as `unsupportedVersion` (not corrupt) and is preserved
   verbatim in its version-keyed sidecar after this build writes over it.
7. **Redaction.** Two partial failures are printed and checked. The first is the platform removal
   callback missing, so the boundary fails closed on a static warning string. The second is the
   realistic leak: the callback throws a Node `EACCES` fs error whose message carries the absolute
   path it failed on and the base64-encoded ids inside it. Both are reported as
   `incomplete`/`resumable` with a code from the closed detail vocabulary
   (`ownershipCleanupFailedClosed` for the throw, never the text), and both printed reports are
   checked to contain no host path, no `/` at all, no error text, and no thread, project or
   environment id or scope key.

## Boundary

Destruction itself is delegated to `cleanupPrimeOwnership`, the existing proof-before-action
boundary: only resources whose ownership record, layout path and inode identity T3 can prove are
ever removed, and the platform callback may always answer `retained`. This milestone adds the
gating, journaling and reporting around it — it does not widen what may be deleted, does not scan,
and never administers a Prime daemon.

No live state, database, browser or simulator is used.

Visual evidence: **not applicable and not captured.** PA-B05 ships no user-visible surface in this
change, and UI-launch permission was not granted in this environment — no browser, Electron or
simulator was launched.
