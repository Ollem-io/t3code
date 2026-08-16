# Prime resume cursor storage and migration (draft)

_Draft — PA-B01. Storage policy only: nothing described here adopts, activates or resumes a session._

## What is stored

A Prime **resume cursor** is the minimum durable identity needed to later find one exact Prime session again. It binds:

- the environment, provider instance, project and thread it belongs to;
- an opaque fingerprint of the T3 home it was written in;
- an opaque session path token (a digest, never a filesystem path);
- the ownership generation it was written under;
- the agent version and compatibility band, and an opaque capability digest;
- a lifecycle marker (`recorded`, `unavailable`, `invalidated`).

It never stores a prompt, a transcript, model output, a setting, telemetry, or a host path. Storage refuses a cursor that carries any of those, and diagnostics are reduced to a scope digest plus a closed set of reason codes.

## Where it lives

- **Filesystem:** `<T3 home>/userdata/prime/v1/environments/<id>/instances/<id>/threads/<id>/resume-cursor.json`, mode `0600` inside `0700` directories, replaced atomically. The previous contents are copied to `resume-cursor.json.bak` before any replacement.
- **Database:** table `prime_resume_cursors` (migration 48), keyed by a length-prefixed scope key and indexed by `(home_fingerprint, environment, instance, project, thread)`, by thread, and by `(environment, instance, lifecycle)`. Lookups are indexed; nothing scans the table.

Two T3 homes never share a row or a file: the home fingerprint is part of the identity.

## Reading an unfamiliar cursor

Reads are total. A missing, corrupt, partial, oversized, foreign or future-version cursor is reported as an _unavailable_ state with a reason code (`missing`, `corrupt`, `unsupportedVersion`, `scopeMismatch`, `invalidated`) rather than raising, and never as "start a fresh session".

## Migration and rollback

- Migration 48 is additive: it creates the table and its indexes with `IF NOT EXISTS` and touches no existing row, so pre-Prime and MVP/Alpha databases are unchanged and remain readable.
- An interrupted run is safe to retry, and a repeated run is a no-op.
- Rollback means running an older build, whose migration loader simply stops earlier. The table and its rows survive untouched, including cursor versions that build cannot decode. Nothing deletes an unknown cursor version — on the filesystem it is backed up before replacement, and in the database it is preserved verbatim.
- The nullable `lease_*` columns are created here but never written. They belong to the PA-B03 single-writer lease, which must exist before PA-B02 may activate a cursor.

## Operator checks

```sh
# Prove the encode/decode, redaction and migration matrix from source:
node apps/server/src/provider/prime/prime-resume-artifact.mjs
```

Retention and destructive cleanup of cursors are out of scope here and are defined by PA-B05.
