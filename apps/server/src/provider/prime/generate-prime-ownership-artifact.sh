#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
artifact=apps/server/src/provider/prime/prime-ownership-artifact.mjs
out="$(mktemp -d "${TMPDIR:-/tmp}/t3-prime-ownership-bundle.XXXXXX")"
candidate="$(mktemp "${TMPDIR:-/tmp}/t3-prime-ownership-artifact.XXXXXX.mjs")"
trap 'rm -rf "$out"; rm -f "$candidate"' EXIT

/root/.vite-plus/bin/vp pack apps/server/src/provider/prime/verify-prime-ownership.ts \
  --out-dir "$out" \
  --no-clean --no-sourcemap --platform node --format esm --target node24 \
  --no-report --logLevel silent
cp "$out/verify-prime-ownership.mjs" "$candidate"
/root/.vite-plus/bin/vp fmt "$candidate"

case "${1:-}" in
  "") cp "$candidate" "$artifact" ;;
  --check) cmp "$candidate" "$artifact" ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

sha256sum "$artifact"
node apps/server/src/provider/prime/verify-prime-ownership.mjs
