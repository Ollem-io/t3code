# PA-M06 ownership review artifact

`prime-ownership-artifact.mjs` is a deterministic standalone Node ESM bundle built
from the checked-in production `PrimeOwnership.ts`, `PrimeResourceLayout.ts`, and
`verify-prime-ownership.ts`. It imports only Node built-ins. SHA-256:
`96cb35981ff65560556361b1d383c92464a6282f81d29fe16d5cfe9cb51aedbb`.

Generate from a fresh checkout and verify that the committed copy is identical:

```sh
rm -rf /tmp/pa-m06-bundle
vp pack apps/server/src/provider/prime/verify-prime-ownership.ts --out-dir /tmp/pa-m06-bundle --clean
cmp /tmp/pa-m06-bundle/verify-prime-ownership.mjs apps/server/src/provider/prime/prime-ownership-artifact.mjs
sha256sum apps/server/src/provider/prime/prime-ownership-artifact.mjs
node apps/server/src/provider/prime/verify-prime-ownership.mjs
```

The executable verifier uses disposable homes and production code. It covers two
homes, two instances, two concurrent thread records, exact process/RPC/daemon
callbacks and resource removal, sibling/home/sentinel isolation, and corrupt record
warning/recovery. The focused unit suite additionally covers traversal-shaped IDs,
symlink parents, identity/path mismatch, future records, thrown proofs, start-token
mismatch, session mismatch, recovery continuation, and partial-cleanup retry without
a second process stop. No global process scan or pattern kill is used.
