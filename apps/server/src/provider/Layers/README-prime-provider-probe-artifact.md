# PA-M05 provider readiness review artifact

`prime-provider-probe-artifact.mjs` is a deterministic standalone Node ESM bundle built from the production readiness probe. It accepts the Prime executable only through `PRIME_AGENT_BIN`, prints a coarse JSON readiness result, and runs version/RPC checks in a disposable isolated namespace without modifying the caller environment.

Regenerate it with `generate-prime-provider-probe-artifact.sh`; verify source-derived deterministic regeneration with `generate-prime-provider-probe-artifact.sh --check`.

SHA-256: `c9ff9f343e0ce4e2d7d158c753239562ee8ec4fe2b38038628cabe957d8c2cf0`.
