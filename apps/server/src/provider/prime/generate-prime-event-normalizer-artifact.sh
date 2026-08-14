#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cp prime-event-normalizer-artifact.ts prime-event-normalizer-artifact.mjs
chmod +x prime-event-normalizer-artifact.mjs
sha256sum prime-event-normalizer-artifact.mjs
