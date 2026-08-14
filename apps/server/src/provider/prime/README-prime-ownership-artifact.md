# PA-M06 ownership review artifact

`prime-ownership-artifact.mjs` is a deterministic standalone Node ESM bundle built
from checked-in production ownership/resource-layout code and the source verifier.
SHA-256: `df3facaf6d60481343a2176be60dcc0b023756dfdae1948fad376d8fb115d453`.

Regenerate and execute it from a fresh checkout:

```sh
apps/server/src/provider/prime/generate-prime-ownership-artifact.sh
```

To independently prove deterministic regeneration without replacing the committed
artifact:

```sh
apps/server/src/provider/prime/generate-prime-ownership-artifact.sh --check
```

The verifier reports 51 source-derived assertions covering selected ownership,
session/config/thread and daemon resource removal, exact callbacks, selected-record
removal, sibling/other-instance/other-home/sentinel preservation, partial-cleanup
retry without duplicate successful callbacks, safe retained-claim recovery, corrupt warnings,
and practical continuation after a thrown identity proof. Focused tests cover
per-path locking, hook-controlled resource/ancestor replacement races, retained resource-claim recovery, outside-sentinel preservation, independently durable effect markers, retained
claims, symlink parents/targets/recovery roots, daemon/thread records, and mismatch
handling. No live state, global scan, pattern kill, or browser is used.
