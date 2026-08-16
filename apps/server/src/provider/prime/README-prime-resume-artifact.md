# PA-B01 resume cursor review artifact

`prime-resume-artifact.mjs` is a deterministic standalone Node ESM bundle built from the checked-in production resume-cursor contract, codec, storage and redaction code plus the migration registry.

SHA-256: `3ae2a34d502a08237f2b48b1d96df48bd768ff6e737383cdc132fa29d0e8b5c4`.

Run the committed artifact directly:

```sh
node apps/server/src/provider/prime/prime-resume-artifact.mjs
```

Regenerate and execute it from a fresh checkout:

```sh
apps/server/src/provider/prime/generate-prime-resume-artifact.sh
```

Prove deterministic regeneration without replacing the committed artifact:

```sh
apps/server/src/provider/prime/generate-prime-resume-artifact.sh --check
```

The verifier reports 48 source-derived assertions and a matrix report covering:

- **encode/decode** — byte-stable deterministic encoding and an exact round trip;
- **version matrix** — v1 (older supported), v2 (current), v99 (unknown future), partial row, corrupt bytes, oversized row and an invalidated cursor, each becoming a readable state instead of a crash;
- **cross-environment** — a cursor whose environment, provider instance, project or thread differs is reported `scopeMismatch`, never adopted;
- **two T3 homes** — the same logical thread in two homes yields different scope keys, and a cross-home read is `unavailable`;
- **storage policy** — the cursor lives inside `<home>/userdata/prime/v1/...`, is owner-only (`0600`), is replaced atomically, whatever it replaced is copied to a rolling `.bak`, and a version this build cannot read is additionally copied to a write-once `preserved-v<version>` sidecar that survives repeated downgraded writes and invalidation;
- **redaction** — storage refuses a cursor carrying transcript, settings, telemetry or a host path, and diagnostics are reduced to a scope digest plus a closed set of status/reason codes containing no identifier and no path;
- **migration** — slot 48 `PrimeResumeCursors` is registered exactly once.

The report itself contains no prompt, transcript, model output, setting, identifier or host path. No live state, database, browser or simulator is used; the two homes are fresh temporary directories.

## Boundary

This milestone is storage policy only. Nothing here adopts, activates or resumes a session: `lifecycle: "recorded"` means a cursor exists, not that a session is live. Activation is PA-B02 and only under the PA-B03 single-writer lease, whose nullable columns are created (never populated) by migration 48 so the arbitration schema is present before any activation path exists.
