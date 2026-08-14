#!/bin/sh
set -eu
D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
F="$D/../../integration/fixtures/prime-rpc/pa-m11-redacted-text-generation.jsonl"
A=$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$F")
[ "$A" = "8b0b0a0aabc9a5d17df6656b8b55887238a574a9db269307d91e682887e3ad47" ] || exit 1
cp "$D/prime-text-generation-artifact.ts" "$D/prime-text-generation-artifact.mjs"
chmod +x "$D/prime-text-generation-artifact.mjs"
