#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
sed -e 's/home: string/home/' -e 's/source: NodeJS.ProcessEnv/source/' prime-adapter-bootstrap-artifact.ts > prime-adapter-bootstrap-artifact.mjs
chmod +x prime-adapter-bootstrap-artifact.mjs
sha256sum prime-adapter-bootstrap-artifact.mjs
