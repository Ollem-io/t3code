# PA-M06 ownership review artifact

`prime-ownership-artifact.mjs` is a deterministic standalone Node ESM bundle built
from checked-in production ownership/resource-layout code and the source verifier.
SHA-256: `0189c5eb714777e33efc650483c7e803a936000b2d04ec56e5aa716b6c8bd396`.

Regenerate and execute it from a fresh checkout:

```sh
apps/server/src/provider/prime/generate-prime-ownership-artifact.sh
```

To independently prove deterministic regeneration without replacing the committed
artifact:

```sh
apps/server/src/provider/prime/generate-prime-ownership-artifact.sh --check
```

The verifier reports 33 source-derived assertions covering selected ownership,
session/config/thread and daemon resource removal, exact callbacks, selected-record
removal, sibling/other-instance/other-home/sentinel preservation, partial-cleanup
retry without duplicate successful callbacks, positive recovery, corrupt warnings,
and practical continuation after a thrown identity proof. Focused tests cover
per-path locking, replacement races, independently durable effect markers, retained
claims, symlink parents/targets/recovery roots, daemon/thread records, and mismatch
handling. No live state, global scan, pattern kill, or browser is used.
