# PA-M06 ownership review artifact

`prime-ownership-artifact.mjs` is a deterministic standalone Node ESM bundle built from the checked-in production ownership/resource-layout code and source verifier.

SHA-256: `6d3ad1a4ed38736bed831356aea36fbdf378de51504c27121ad70d29fd77274e`.

Regenerate and execute it from a fresh checkout:

```sh
apps/server/src/provider/prime/generate-prime-ownership-artifact.sh
```

Independently prove deterministic regeneration without replacing the committed artifact:

```sh
apps/server/src/provider/prime/generate-prime-ownership-artifact.sh --check
```

The verifier reports 61 source-derived assertions, including dedicated ownership-write and progress-write parent-swap scenarios. They prove no outside entry is created, opened temporary/claimed records are retained for recovery, later cleanup callbacks stop after the namespace changes, and warnings are surfaced. It also covers proof-callback namespace swaps, exact selected ownership/session/config/thread/daemon removal, sibling/other-instance/other-home/sentinel preservation, partial-cleanup retry without duplicate successful callbacks, safe retained-claim recovery, corrupt warnings, and continuation after thrown identity proof.

Focused tests additionally cover per-path locking, create/update no-clobber publishing, target replacement immediately before publish, resource/ancestor replacement races, retained resource-claim recovery, independently durable effect markers, symlink parents/targets/recovery roots, daemon/thread records, and mismatch handling. No live state, global scan, pattern kill, or browser is used.
