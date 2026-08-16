# PA-B03 single-writer arbitration review artifact

`prime-lease-artifact.mjs` is a deterministic standalone Node ESM bundle built from the checked-in production conflict-receipt contract, lease service, adapter write gate and redaction code plus the migration registry.

SHA-256: `8c6293cb88e7937a83202dd8d1f4b5df915982a92eb2b41befa7ca7e0ed4ddc7`.

Run the committed artifact directly:

```sh
node apps/server/src/provider/prime/prime-lease-artifact.mjs
```

Regenerate and execute it from a fresh checkout:

```sh
apps/server/src/provider/prime/generate-prime-lease-artifact.sh
```

Prove deterministic regeneration without replacing the committed artifact:

```sh
apps/server/src/provider/prime/generate-prime-lease-artifact.sh --check
```

The verifier reports 159 source-derived assertions and a race trace covering:

- **two-client/two-process activation race** — two independently constructed lease services share only the durable row and are held at a write barrier until both have observed the same free scope; exactly one is granted and the other receives a retryable `heldByAnotherWriter` receipt;
- **send arbitration** — the losing client, a client presenting the winner's handle, and the winner replaying its handle against a different scope are all refused, so a handle is proof of identity rather than a bearer token;
- **atomic write slot** — taking the send slot is itself a compare-and-set that keeps the generation and extends the expiry, so an in-flight write cannot lapse between the check and the provider call;
- **crash recovery and fencing** — a lapsed lease is reported `expired`, the surviving process recovers at a strictly higher fence, and the stale holder's later send, renew and release are all rejected as `fenced`, identically on repetition;
- **authorization before arbitration** — an unauthorized caller is refused with zero lease reads, and a held scope and a never-used scope refuse it identically, so the refusal cannot be used to probe for owners;
- **redaction** — every receipt in the trace passes the structural redaction proof, decodes under the wire schema a client uses, names the scope only by a 12-hex digest, and carries no client token, holder token, process token, scope key, thread, project, environment or home;
- **adapter gate** — the gate the Prime adapter is wired to refuses activation with the same redacted typed receipt and an error message that names no owner, retakes a lease of its own that merely lapsed, and never retakes one another writer has claimed;
- **schema** — the lease columns stay in PA-B01's migration slot 48; PA-B03 adds no migration.

Timing is injected, every interleaving is chosen explicitly, and there is no sleep, timer or poll anywhere in the artifact. The report contains no prompt, transcript, model output, setting, identifier or host path. No live state, database, browser or simulator is used.

The SQL-backed form of the same trace — two independent SQLite connections over one database file, plus the Prime adapter refusing to launch a second session and refusing a fenced prompt — runs in `apps/server/integration/primeAgentResumeRace.integration.test.ts`.

## Boundary

This milestone is arbitration only. Nothing here activates, adopts or resumes a durable session: the lease is the gate PA-B02's activation path must pass through first. Client recovery-choice UI is PA-B04 and retention/deletion policy is PA-B05.
