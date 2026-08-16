# PA-B02 adoption/resume review artifact

`prime-resume-coordinator-artifact.mjs` is a deterministic standalone Node ESM bundle built from
the checked-in production resume coordinator, resume-cursor storage, single-writer lease and event
normalizer. Nothing in it is mocked or re-implemented.

SHA-256: `51cb03e3a0c3146725b503bb5d90150c8e901186c6db50215cf932f98fd714b3`.

Run the committed artifact directly:

```sh
node apps/server/src/provider/prime/prime-resume-coordinator-artifact.mjs
```

Regenerate and execute it from a fresh checkout:

```sh
apps/server/src/provider/prime/generate-prime-resume-coordinator-artifact.sh
```

Prove deterministic regeneration without replacing the committed artifact:

```sh
apps/server/src/provider/prime/generate-prime-resume-coordinator-artifact.sh --check
```

The verifier reports 38 source-derived assertions covering:

- **restart** — run 1 records a cursor for a fresh session; run 2 is a brand new coordinator with a
  brand new writer identity and recovers the _same_ session out of durable storage;
- **barrier** — two processes recover from the same observed state at once: exactly one activates,
  the other receives a typed retryable `conflict`, and neither starts a new session;
- **identity and transcript hashes** — the opaque session token and the projected-transcript hash
  are printed before and after the restart and are identical, proving the exact session was
  reopened and the transcript was neither duplicated nor rewritten;
- **idempotence** — repeating recovery reproduces the same decision and does not drop the lease;
- **refusals** — `incompatibleVersion`, `capabilityMismatch`, `ownershipMismatch`, corrupt bytes,
  an unknown future cursor version, and a cursor recorded by another environment each become a
  readable `unavailable` state; none starts a session and none rewrites the stored cursor;
- **redaction** — the report carries no identifier and no host path, and the stored cursor passes
  the structural redaction proof (no transcript, settings, telemetry or host path).

No live state, database, browser or simulator is used; the T3 home is a fresh temporary directory,
and the session-path token and identity digest are opaque hashes.

## Boundary

The lease is PA-B03's and is only ever _acquired_ here — this milestone never widens it. Nothing
falls back to a new session or to ACP: the only outcome that starts fresh is a thread with no cursor
at all. Client recovery UI is PA-B04 and is deliberately absent.

Visual evidence: **not applicable and not captured.** PA-B02 ships no user-visible surface, and
UI-launch permission was not granted in this environment — no browser, Electron or simulator was
launched.
