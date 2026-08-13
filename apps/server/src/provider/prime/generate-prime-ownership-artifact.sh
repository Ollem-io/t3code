#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
out=apps/server/src/provider/prime/.ownership-bundle-tmp
artifact=apps/server/src/provider/prime/prime-ownership-artifact.mjs
rm -rf "$out"
trap 'rm -rf "$out"' EXIT
/root/.vite-plus/bin/vp pack apps/server/src/provider/prime/verify-prime-ownership.ts \
  --out-dir "$out" \
  --no-clean --no-sourcemap --platform node --format esm --target node24 \
  --no-report --logLevel silent
cp "$out/verify-prime-ownership.mjs" "$artifact"
sha256sum "$artifact"
node apps/server/src/provider/prime/verify-prime-ownership.mjs
