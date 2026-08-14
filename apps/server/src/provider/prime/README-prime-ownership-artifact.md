# PA-M06 ownership review artifact

`prime-ownership-artifact.mjs` is a deterministic standalone Node ESM bundle built from the checked-in production ownership/resource-layout code and source verifier.

SHA-256: `08072e44b4deee3dc6326b20466cd7e89a24d04ccaf5e2674d3007571cefb269`.

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

## Quarantine cleanup semantics

Cleanup now treats removal from the active namespace as the destructive boundary. Every owned record, resource, temporary publish file, superseded record, and lock is revalidated and atomically renamed to a fresh unpredictable sibling `quarantine-*` tombstone. Node's pathname APIs cannot safely unlink an inode in a hostile namespace, so the default deliberately retains the proven inode rather than risking deletion of a replacement. `resource-removed` and `record-removed` mean the active path is absent/quarantined; a warning action identifies each retained tombstone. Locks no longer block after their active name is quarantined. Recovery enumerates and warns about retained claims/quarantines without restoring or deleting them. Exact leftovers are bounded per operation, though interrupted operations can accumulate unique tombstones for later platform-anchored maintenance.
