#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cp prime-turn-input-artifact.ts prime-turn-input-artifact.mjs
chmod +x prime-turn-input-artifact.mjs
sha256sum prime-turn-input-artifact.mjs
