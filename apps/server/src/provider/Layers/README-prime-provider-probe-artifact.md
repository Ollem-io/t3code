# PA-M05 provider readiness review artifact

`prime-provider-probe-artifact.mjs` is a deterministic standalone Node ESM bundle built from the production readiness probe. By default it requires the Prime executable through `PRIME_AGENT_BIN`; set `PRIME_AGENT_ENABLED=0` to exercise the disabled classification without an executable. It prints exactly one coarse JSON readiness result and runs enabled version/RPC checks in a disposable isolated namespace without modifying the caller environment.

Regenerate it with `generate-prime-provider-probe-artifact.sh`; verify source-derived deterministic regeneration with `generate-prime-provider-probe-artifact.sh --check`. Run `verify-prime-provider-probe-artifact.sh` for the 36-run source-free matrix. The verifier generates temporary fake executables with baked marker paths and proves invocation arguments, isolated HOME/USERPROFILE/XDG/TMP paths, secret stripping, M06 resource layout, delayed child shutdown, and root/session cleanup. It also covers ready, incompatible, setup-required, runtime-error, malformed protocol, advisory, zero-model, and disabled results while requiring empty stderr.

SHA-256: `b145a73eb9d86e274c5487b4b13152dafb91e4b2775b9924a549802761cb736c`.
