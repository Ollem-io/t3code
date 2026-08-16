#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
vp=./node_modules/.bin/vp
[ -x "$vp" ] || vp="$(command -v vp)"
artifact=apps/server/src/provider/prime/prime-resume-artifact.mjs
out="$(mktemp -d "${TMPDIR:-/tmp}/t3-prime-resume-bundle.XXXXXX")"
candidate="$(mktemp "${TMPDIR:-/tmp}/t3-prime-resume-artifact.XXXXXX.mjs")"
trap 'rm -rf "$out"; rm -f "$candidate"' EXIT

"$vp" pack apps/server/src/provider/prime/verify-prime-resume.ts \
  --out-dir "$out" \
  --no-clean --no-sourcemap --platform node --format esm --target node24 \
  --no-report --logLevel silent
cp "$out/verify-prime-resume.mjs" "$candidate"
"$vp" fmt "$candidate"

case "${1:-}" in
  "") cp "$candidate" "$artifact" ;;
  --check) cmp "$candidate" "$artifact" ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

shasum -a 256 "$artifact" 2>/dev/null || sha256sum "$artifact"
node "$artifact"
