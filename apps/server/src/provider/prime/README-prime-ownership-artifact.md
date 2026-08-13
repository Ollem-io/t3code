# PA-M06 ownership review artifact

`prime-ownership-artifact.mjs` is a deterministic standalone Node ESM bundle built
from the checked-in production `PrimeOwnership.ts`, `PrimeResourceLayout.ts`, and
`verify-prime-ownership.ts`. It imports only Node built-ins. SHA-256:
`04b01dbcfb789abbf551c7e0efb3e92f66ead458857f4d5b610418a62e3030d7`.

Generate from a fresh checkout and verify that the committed copy is identical:

```sh
rm -rf apps/server/src/provider/prime/.ownership-bundle-tmp
/root/.vite-plus/bin/vp pack apps/server/src/provider/prime/verify-prime-ownership.ts \
  --out-dir apps/server/src/provider/prime/.ownership-bundle-tmp \
  --no-clean --no-sourcemap --platform node --format esm --target node24 \
  --no-report --logLevel silent
cmp apps/server/src/provider/prime/.ownership-bundle-tmp/verify-prime-ownership.mjs \
  apps/server/src/provider/prime/prime-ownership-artifact.mjs
sha256sum apps/server/src/provider/prime/prime-ownership-artifact.mjs
rm -rf apps/server/src/provider/prime/.ownership-bundle-tmp
node apps/server/src/provider/prime/verify-prime-ownership.mjs
```

The executable verifier uses disposable homes and production code. It covers two
homes, two instances, two concurrent thread records, exact process/RPC/daemon
callbacks and resource removal, sibling/home/sentinel isolation, and corrupt record
warning/recovery. The focused unit suite additionally covers traversal-shaped IDs,
symlink parents, identity/path mismatch, future records, thrown proofs, start-token
mismatch, session mismatch, recovery continuation, and partial-cleanup retry without
a second process stop. No global process scan or pattern kill is used.
