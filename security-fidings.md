# Security findings

## Prime ownership legacy pathname cleanup

**Status:** Accepted for the PA-M06 merge as a documented follow-up.

**Affected candidate:** `89820d8d5c0ace88e5b522d4d0a740fec1d719aa`

### Summary

`apps/server/src/provider/prime/PrimeOwnership.ts` still exports the legacy helpers
`unsafePathnameCleanupPrimeOwnershipForTests` and
`unsafePathnameRecoverPrimeOwnershipForTests`. They use pathname-based rename and
cleanup transactions that cannot fully close hostile concurrent filesystem races
without anchored, no-replace platform primitives.

The focused verifier and generated ownership artifact currently alias these unsafe
helpers as `cleanupPrimeOwnership` and `recoverPrimeOwnership`. Therefore, the
artifact exercises the legacy pathname implementation rather than proving the
exported production delegated-cleanup path.

### Current production boundary

The exported production `cleanupPrimeOwnership` fails closed when no
`removeOwnedResource` callback is provided. It does not call the legacy unsafe
helpers. Destructive cleanup is delegated through `removeOwnedResource`, which is
required by contract to use an anchored platform implementation and receives the
exact path, resource kind, stable operation ID, and captured device/inode identity.

The unsafe helpers remain an exposure because they are exported from a production
module and could be imported accidentally. The current artifact can also create
false confidence about production-path coverage.

### Security impact

If the legacy helpers are used against a namespace writable by a concurrent hostile
actor, pathname check/use races may allow a replacement path to be renamed,
quarantined, written, or otherwise acted upon instead of the previously proven
inode. Affected transaction categories include locks, temporary publication,
superseded records, ownership/resource claims, recovery traversal, and cleanup.

No broad process-name scan, daemon-wide shutdown, live Prime state mutation, or
live T3 userdata access is involved in this finding.

### Required follow-up

1. Move the legacy pathname implementation into a test-only module and remove its
   exports from production code.
2. Make primary tests and the source-derived artifact import the exact production
   `cleanupPrimeOwnership` and `recoverPrimeOwnership` functions without aliases.
3. Replace the string cleanup result with a structured receipt bound to the stable
   operation ID and exact captured identity, then re-prove the postcondition before
   reporting removal.
4. Test default fail-closed behavior, delegated cleanup, retained/throwing callbacks,
   parent swaps, idempotent retry, and record-by-record recovery continuation.
5. Implement the destructive boundary with anchored platform primitives such as a
   native storage adapter providing no-replace, directory-handle-relative actions;
   do not reintroduce check-then-rename or check-then-delete pathname logic.
6. Regenerate the standalone artifact from the production verifier and update its
   documented hash.

### Acceptance note

This finding is intentionally accepted for the PA-M06 merge by explicit maintainer
direction. It must be tracked as a separate security issue and resolved before any
production provider code imports or enables the legacy unsafe helpers.
