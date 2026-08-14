# PA-M06 ownership review artifact

`prime-ownership-artifact.mjs` is a deterministic standalone Node ESM bundle built from the checked-in production ownership/resource-layout code and source verifier.

SHA-256: `d7f9776af5d16d499efe74f527dc9b81f280293aa05dade187c66edc1fff08d5`.

Regenerate and execute it from a fresh checkout:

```sh
apps/server/src/provider/prime/generate-prime-ownership-artifact.sh
```

Independently prove deterministic regeneration without replacing the committed artifact:

```sh
apps/server/src/provider/prime/generate-prime-ownership-artifact.sh --check
```

The verifier reports 61 source-derived assertions, including a deterministic post-quarantine deletion-window replacement scenario plus dedicated ownership-write and progress-write parent-swap scenarios. They prove no outside entry is created, opened temporary/claimed records are retained for recovery, later cleanup callbacks stop after the namespace changes, and warnings are surfaced. It also covers proof-callback namespace swaps, exact selected ownership/session/config/thread/daemon removal, sibling/other-instance/other-home/sentinel preservation, partial-cleanup retry without duplicate successful callbacks, safe retained-claim recovery, corrupt warnings, and continuation after thrown identity proof.

Focused tests additionally cover per-path locking, create/update no-clobber publishing, target replacement immediately before publish, resource/ancestor replacement races, retained resource-claim recovery, independently durable effect markers, symlink parents/targets/recovery roots, daemon/thread records, and mismatch handling. No live state, global scan, pattern kill, or browser is used.

## Destructive cleanup boundary

The exported production cleanup registry never uses Node pathname `rename` or `unlink` as logical deletion. UUID destinations are not a no-clobber proof, and check-then-rename cannot close a hostile destination collision or parent swap. The registry proves the exact ownership record and resource identity, supplies stable operation IDs, and delegates removal to an optional `removeOwnedResource` platform callback. The portable default emits an action warning and retains both active resources and the active ownership record.

A platform callback must validate the supplied device/inode identity and use an anchored native no-replace primitive (for example an `openat2`/`RENAME_NOREPLACE` design or platform equivalent). Returning `retained`, throwing, or omitting the callback fails closed. No retained data is reported as deleted. The legacy pathname transaction remains exported only as an explicitly unsafe test-artifact helper so the frozen historical race corpus remains reproducible; production consumers must use `cleanupPrimeOwnership`. Because the default creates no quarantine entries, cumulative quarantine inventory is zero and cannot grow.
