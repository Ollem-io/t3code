# PA-B06 Beta certification review artifact

`prime-beta-artifact.mjs` is a deterministic standalone Node ESM bundle built from the checked-in
compatibility classifier, resume coordinator, cursor codec, ownership writer, cleanup planner,
arbitration lease and the shared client resume reducer. Nothing in it is mocked or re-implemented.

SHA-256: `4454a9c7bc294500eab6c54735a2ac8d9cfa3bbb2fbb1b427743d2476d2ea161`.

Run the committed artifact directly:

```sh
node apps/server/src/provider/prime/prime-beta-artifact.mjs
```

Regenerate and execute it from a fresh checkout:

```sh
apps/server/src/provider/prime/generate-prime-beta-artifact.sh
```

Prove deterministic regeneration without replacing the committed artifact:

```sh
apps/server/src/provider/prime/generate-prime-beta-artifact.sh --check
```

The verifier reports 78 source-derived assertions over a disposable **two-home** tree, and prints
the Beta certification bundle in eight sections. Both homes are removed at the end.

1. **Version matrix.** The supported floor, the known-incompatible set, and the band every probed
   version lands in: `0.6.0`/`0.7.1` incompatible, `0.7.2` compatible, `0.7.3`/`9.9.9` advisory —
   an unknown newer release is allowed to run and allowed to resume.
2. **Scenario results.** Eight recovery scenarios driven through the real coordinator against real
   cursor files: no cursor, a live session proof, a durable relaunch, a genuinely deleted session
   directory, another home's cursor, a changed ownership generation, an incompatible installed
   version, and a lease already held by another writer. **Exactly one** of them — the thread that
   never had a Prime session — is allowed to plan `fresh`; every refusal is asserted not to.
3. **Spawn/ownership manifest.** Real ownership records are written for one thread per home, then
   every lifecycle event is planned. Stop, archive, instance-disable, rollout and rollback plan zero
   targets; only explicit delete, provider removal, reconfiguration and migration plan any. The
   manifest prints opaque `pct-` digests, never paths.
4. **Cursor-state hashes.** Hashes are derived from the scope actually decoded off disk. The two
   homes differ, neither cursor file contains its own home or Prime root path, and every target the
   first home planned is proven to live inside that home and never inside the second — whose
   session, ownership record and cursor are all still present at the end.
5. **Rollback.** A cursor written with a newer version decodes as
   `unsupportedVersion`/`unavailable` (not corrupt), its bytes are byte-identical after the read,
   and every rollout transition — enable, disable, rollback — reports `deletesDurableData=false`.
6. **Performance counts.** Scenario count, the cursor reads and writes this artifact performed, and
   the largest cursor on disk, asserted under `PRIME_RESUME_MAX_BYTES`.
7. **Client surface.** Each scenario's published state is pushed through the reducer web, desktop
   and mobile all share. Every refusal blocks the composer and offers at least one way out; no
   refusal copy contains a path.
8. **Evidence disclosure.** Printed, not implied: whether `PRIME_AGENT_BIN` was set, and that no
   browser, Electron process or simulator was launched.

## Real-binary lane

The lane is opt-in and installs nothing. With `PRIME_AGENT_BIN` set to an installed binary,
`primeAgentBeta.integration.test.ts` runs its seed-and-resume scenario against it:

```sh
PRIME_AGENT_BIN=$(command -v prime-agent) vp test run apps/server/integration/primeAgentBeta.integration.test.ts
```

With the variable unset the lane is **skipped**, not passed — a lane that did not run must not look
like one that did.
Prime Agent is not installed in the environment this milestone was implemented in, so the
real-binary lane has **not** been executed here.

## Boundary

No live state, database, browser or simulator is used, and nothing outside the two temp homes this
artifact creates is read or written.

Visual evidence: **not captured.** UI-launch permission was not granted in this environment, so no
browser, Electron app or simulator was launched. The web and mobile recovery surfaces are covered
by `apps/web/src/components/chat/prime-resume.test.tsx` and
`apps/mobile/src/features/threads/prime-resume.test.tsx`; an integrated visual pass remains
outstanding and is tracked with the standing visual-evidence debt.
