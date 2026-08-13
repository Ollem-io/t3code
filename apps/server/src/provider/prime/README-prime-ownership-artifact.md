# PA-M06 ownership review artifact

`prime-ownership-artifact.mjs` is a deterministic standalone Node ESM bundle built
from checked-in production ownership/resource-layout code and the source verifier.
SHA-256: `99193643c18c5bd1ffeaee1c6bd8036ba833a720221fb800c30455e6d8c2b352`.

Regenerate and execute it from a fresh checkout:

```sh
apps/server/src/provider/prime/generate-prime-ownership-artifact.sh
```

To independently prove deterministic regeneration without replacing the committed
artifact:

```sh
rm -rf apps/server/src/provider/prime/.ownership-bundle-tmp
/root/.vite-plus/bin/vp pack apps/server/src/provider/prime/verify-prime-ownership.ts \
  --out-dir apps/server/src/provider/prime/.ownership-bundle-tmp \
  --no-clean --no-sourcemap --platform node --format esm --target node24 \
  --no-report --logLevel silent
cmp apps/server/src/provider/prime/.ownership-bundle-tmp/verify-prime-ownership.mjs \
  apps/server/src/provider/prime/prime-ownership-artifact.mjs
sha256sum apps/server/src/provider/prime/prime-ownership-artifact.mjs
node apps/server/src/provider/prime/verify-prime-ownership.mjs
rm -rf apps/server/src/provider/prime/.ownership-bundle-tmp
```

The verifier reports 33 source-derived assertions covering selected ownership,
session/config/thread and daemon resource removal, exact callbacks, selected-record
removal, sibling/other-instance/other-home/sentinel preservation, partial-cleanup
retry without duplicate successful callbacks, positive recovery, corrupt warnings,
and practical continuation after a thrown identity proof. Focused tests cover
per-path locking, replacement races, independently durable effect markers, retained
claims, symlink parents/targets/recovery roots, daemon/thread records, and mismatch
handling. No live state, global scan, pattern kill, or browser is used.
