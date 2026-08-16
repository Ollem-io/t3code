#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cp pa-m12-headless-scenario.ts pa-m12-headless-scenario.mjs
chmod +x pa-m12-headless-scenario.mjs
sha256sum pa-m12-headless-scenario.mjs
