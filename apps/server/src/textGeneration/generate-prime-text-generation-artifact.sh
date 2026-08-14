#!/bin/sh
set -eu
D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
F="$D/../../integration/fixtures/prime-rpc/pa-m11-redacted-text-generation.jsonl"
A=$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$F")
[ "$A" = "3e04facf0c6cecf5dc39d04720fb19ee1ef117947aa52e1cfe5ded40d536be2d" ] || exit 1
cp "$D/prime-text-generation-artifact.ts" "$D/prime-text-generation-artifact.mjs"
chmod +x "$D/prime-text-generation-artifact.mjs"
