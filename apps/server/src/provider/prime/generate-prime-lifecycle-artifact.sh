#!/bin/sh
set -eu
D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FIX="$D/../../../integration/fixtures/prime-rpc/pa-m10-redacted-lifecycle.jsonl"
ACTUAL=$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$FIX")
[ "$ACTUAL" = "9937b6b9f6713309d0b286212f7aedf4ea1236d5fc52c806da19d5ba8f9e2b4b" ] || { echo "fixture hash mismatch" >&2; exit 1; }
cp "$D/prime-lifecycle-artifact.ts" "$D/prime-lifecycle-artifact.mjs"
chmod +x "$D/prime-lifecycle-artifact.mjs"
