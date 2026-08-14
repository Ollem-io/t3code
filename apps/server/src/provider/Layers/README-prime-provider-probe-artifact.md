# PA-M05 provider readiness review artifact

`prime-provider-probe-artifact.mjs` is a deterministic standalone Node ESM bundle built from the production readiness probe. It accepts the Prime executable only through `PRIME_AGENT_BIN`, prints a coarse JSON readiness result, and runs version/RPC checks in a disposable isolated namespace without modifying the caller environment.

Regenerate it with `generate-prime-provider-probe-artifact.sh`; verify source-derived deterministic regeneration with `generate-prime-provider-probe-artifact.sh --check`. Run `verify-prime-provider-probe-artifact.sh` for the 30-run source-free fake-binary readiness matrix.

SHA-256: `ce9e48313dd62ccb98e7a2b62be302d4bfa8fec7df6e4567253d833b31273b56`.
