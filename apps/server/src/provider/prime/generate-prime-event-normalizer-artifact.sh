#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
fixture="../../../integration/fixtures/prime-rpc/pa-m09-redacted-events.jsonl"
test "$(sha256sum "$fixture" | cut -d' ' -f1)" = "5936bdde3548917f8fa9b092e36f4fe54549531e57ed661bac53fe955afcd6a6"
cp prime-event-normalizer-artifact.ts prime-event-normalizer-artifact.mjs
chmod +x prime-event-normalizer-artifact.mjs
sha256sum prime-event-normalizer-artifact.mjs
