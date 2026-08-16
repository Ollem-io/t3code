import {
  findSessionWriterReceiptViolation,
  primeResumeScopeKey,
  sessionWriterConflictReceiptFromUnknown,
  type PrimeResumeCursorScope,
  type SessionWriterConflictReceipt,
} from "@t3tools/contracts";

import { migrationManifest } from "../../persistence/Migrations.ts";
import {
  makeInMemoryPrimeSessionLeaseStore,
  makePrimeSessionLeaseService,
  makePrimeSessionWriteGate,
  PRIME_SESSION_LEASE_TTL_MS,
  PrimeSessionLeaseConflictError,
  primeLeaseScopeDigest,
  primeSessionWriterToken,
  redactPrimeLeaseDiagnostics,
  type PrimeSessionLeaseStore,
} from "./PrimeSessionLease.ts";

/**
 * PA-B03 review artifact. Every assertion runs the checked-in production
 * arbitration code. The interleaving of every race is chosen by this script —
 * there is no sleep, no timer and no polling — so the trace below is
 * reproducible byte for byte apart from the wall-clock stamps, which the
 * fixtures pin.
 *
 * "Two processes" is modelled as two independently constructed lease services
 * that share only the durable row, which is exactly what two T3 processes
 * share through SQLite. The SQL-backed equivalent of this trace runs in
 * apps/server/integration/primeAgentResumeRace.integration.test.ts.
 */

let checks = 0;
function check(value: unknown, message: string): asserts value {
  checks++;
  if (!value) throw new Error(message);
}

const report: Array<string> = [];
const line = (text: string) => report.push(text);

const scopeFor = (overrides: Record<string, string> = {}): PrimeResumeCursorScope =>
  ({
    environmentId: "env-a",
    providerInstanceId: "prime-agent",
    projectId: "project-a",
    threadId: "thread-a",
    homeFingerprint: "home-one",
    ...overrides,
  }) as PrimeResumeCursorScope;

const scope = scopeFor();
const clientA = { clientToken: "client-a", processToken: "process-1" };
const clientB = { clientToken: "client-b", processToken: "process-2" };

let time = 1_000;
const now = () => time;

// One durable row, two independent services: the shared state is exactly the
// stored lease, never process memory.
const durable = makeInMemoryPrimeSessionLeaseStore();

/** Lets the trace hold every write until both processes have read. */
const barrier = (inner: PrimeSessionLeaseStore) => {
  const waiting: Array<() => void> = [];
  let hold = false;
  return {
    store: {
      read: inner.read,
      compareAndSet: async (input: Parameters<PrimeSessionLeaseStore["compareAndSet"]>[0]) => {
        if (hold) await new Promise<void>((resolve) => waiting.push(resolve));
        return inner.compareAndSet(input);
      },
    } satisfies PrimeSessionLeaseStore,
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      for (const gate of waiting.splice(0)) gate();
    },
    pending: () => waiting.length,
  };
};

const gate = barrier(durable);
const authorized =
  (allowed: ReadonlyArray<string>) => (request: { writer: { clientToken: string } }) =>
    allowed.includes(request.writer.clientToken);

const processOne = makePrimeSessionLeaseService({
  store: gate.store,
  now,
  authorize: authorized([clientA.clientToken, clientB.clientToken]),
});
const processTwo = makePrimeSessionLeaseService({
  store: gate.store,
  now,
  authorize: authorized([clientA.clientToken, clientB.clientToken]),
});

const receiptsSeen: Array<SessionWriterConflictReceipt> = [];
const record = (outcome: { status: string; receipt?: SessionWriterConflictReceipt }) => {
  if (outcome.receipt) receiptsSeen.push(outcome.receipt);
  return outcome;
};

// 1. Two processes activate from the same observed state; exactly one wins.
gate.hold();
const raced = Promise.all([
  processOne.acquire({ scope, writer: clientA, operation: "activate" }),
  processTwo.acquire({ scope, writer: clientB, operation: "activate" }),
]);
await new Promise((resolve) => setImmediate(resolve));
check(gate.pending() === 2, "both processes must reach the write barrier before either commits");
gate.release();
const outcomes = (await raced).map(record) as Array<Awaited<ReturnType<typeof processOne.acquire>>>;
const granted = outcomes.filter((outcome) => outcome.status === "granted");
const refused = outcomes.filter((outcome) => outcome.status === "conflict");
check(granted.length === 1, "exactly one process may become the authoritative writer");
check(refused.length === 1, "the other must receive a typed conflict");
const loser = refused[0];
check(
  loser?.status === "conflict" && loser.receipt.reason === "heldByAnotherWriter",
  "the loser must be told the scope is held, and nothing else",
);
check(
  loser?.status === "conflict" && loser.receipt.retryable,
  "losing an activation race must be retryable",
);
const winner = granted[0]!;
if (winner.status !== "granted") throw new Error("unreachable");
line(
  `activation race: 2 processes, 1 granted (generation ${winner.handle.generation}, fence ${winner.handle.fence}), 1 retryable conflict`,
);

// 2. The loser cannot send, and neither can anyone holding a foreign handle.
const loserSend = record(
  await processTwo.acquire({ scope, writer: clientB, operation: "send" }),
) as Awaited<ReturnType<typeof processOne.acquire>>;
check(
  loserSend.status === "conflict" && loserSend.receipt.reason === "heldByAnotherWriter",
  "a second writer must not be able to send",
);
const stolen = record(
  await processTwo.authorizeWrite(winner.handle, { scope, writer: clientB, operation: "send" }),
) as Awaited<ReturnType<typeof processOne.acquire>>;
check(
  stolen.status === "conflict" && stolen.receipt.reason === "notHolder",
  "a handle is proof of identity, not a bearer token",
);
const replayed = record(
  await processOne.authorizeWrite(winner.handle, {
    scope: scopeFor({ threadId: "thread-b" }),
    writer: clientA,
    operation: "send",
  }),
) as Awaited<ReturnType<typeof processOne.acquire>>;
check(
  replayed.status === "conflict" && replayed.receipt.reason === "notHolder",
  "a handle may not be replayed against another scope",
);
line("send arbitration: second writer, stolen handle and cross-scope replay all refused");

// 3. The authoritative writer sends; the write slot is taken atomically.
time += PRIME_SESSION_LEASE_TTL_MS - 1;
const authoritative = await processOne.authorizeWrite(winner.handle, {
  scope,
  writer: clientA,
  operation: "send",
});
check(authoritative.status === "granted", "the authoritative writer must be able to send");
if (authoritative.status !== "granted") throw new Error("unreachable");
check(
  authoritative.handle.generation === winner.handle.generation,
  "taking the write slot must not change the generation",
);
check(
  authoritative.handle.expiresAtMs === now() + PRIME_SESSION_LEASE_TTL_MS,
  "taking the write slot must push the expiry out so an in-flight write cannot lapse",
);
line(
  `authoritative send: generation ${authoritative.handle.generation} held, expiry extended by ${PRIME_SESSION_LEASE_TTL_MS}ms`,
);

// 4. Crash: the holder disappears, the lease lapses, the other process
//    recovers deterministically and the stale holder is fenced forever.
time += PRIME_SESSION_LEASE_TTL_MS + 1;
const lapsed = await processTwo.inspect(scope);
check(lapsed.status === "expired", "a crashed holder must leave an expired, recoverable lease");
const recovered = record(
  await processTwo.acquire({ scope, writer: clientB, operation: "activate" }),
) as Awaited<ReturnType<typeof processOne.acquire>>;
check(recovered.status === "granted", "the surviving process must be able to recover the scope");
if (recovered.status !== "granted") throw new Error("unreachable");
check(
  recovered.handle.fence > authoritative.handle.fence,
  "the fence must strictly increase across a takeover",
);
const fencedOutcomes = [
  record(
    await processOne.authorizeWrite(authoritative.handle, {
      scope,
      writer: clientA,
      operation: "send",
    }),
  ),
  record(
    await processOne.renew(authoritative.handle, { scope, writer: clientA, operation: "renew" }),
  ),
  record(
    await processOne.release(authoritative.handle, {
      scope,
      writer: clientA,
      operation: "release",
    }),
  ),
];
for (const outcome of fencedOutcomes) {
  check(
    "receipt" in outcome && outcome.receipt?.reason === "fenced",
    "a superseded holder may not commit, renew or release",
  );
}
// Repeating recovery changes nothing: the trace is idempotent.
const repeated = await processOne.authorizeWrite(authoritative.handle, {
  scope,
  writer: clientA,
  operation: "send",
});
check(
  repeated.status === "conflict" && repeated.receipt.reason === "fenced",
  "repeated recovery must stay deterministic",
);
line(
  `crash recovery: lease lapsed, fence ${authoritative.handle.fence} -> ${recovered.handle.fence}, 3 stale completions rejected, repeat identical`,
);

// 5. An unauthorized caller is refused before any lease state is read.
let reads = 0;
const watched: PrimeSessionLeaseStore = {
  read: async (key) => {
    reads++;
    return gate.store.read(key);
  },
  compareAndSet: gate.store.compareAndSet,
};
const unauthorizedProcess = makePrimeSessionLeaseService({
  store: watched,
  now,
  authorize: () => false,
});
const heldRefusal = record(
  await unauthorizedProcess.acquire({ scope, writer: clientA, operation: "activate" }),
) as Awaited<ReturnType<typeof processOne.acquire>>;
const freeRefusal = record(
  await unauthorizedProcess.acquire({
    scope: scopeFor({ threadId: "thread-never-used" }),
    writer: clientA,
    operation: "activate",
  }),
) as Awaited<ReturnType<typeof processOne.acquire>>;
check(reads === 0, "an unauthorized caller must never reach lease state");
check(
  heldRefusal.status === "conflict" && heldRefusal.receipt.reason === "unauthorized",
  "an unauthorized caller must be refused",
);
check(
  heldRefusal.status === "conflict" && !heldRefusal.receipt.retryable,
  "an unauthorized refusal is not something to retry",
);
check(
  heldRefusal.status === "conflict" &&
    freeRefusal.status === "conflict" &&
    heldRefusal.receipt.reason === freeRefusal.receipt.reason &&
    heldRefusal.receipt.retryable === freeRefusal.receipt.retryable,
  "a held scope and a free scope must refuse an unauthorized caller identically",
);
line("authorization: 0 lease reads, held and free scopes refuse identically");

// 6. Every receipt produced above is redacted and decodable by a client.
const secrets = [
  clientA.clientToken,
  clientB.clientToken,
  clientA.processToken,
  primeSessionWriterToken(clientA),
  primeSessionWriterToken(clientB),
  primeResumeScopeKey(scope),
  "thread-a",
  "project-a",
  "env-a",
  "home-one",
];
check(receiptsSeen.length >= 8, "the trace must exercise a representative set of receipts");
for (const receipt of receiptsSeen) {
  check(
    findSessionWriterReceiptViolation(receipt) === undefined,
    "a receipt may not carry owner identity, content or a host path",
  );
  check(
    sessionWriterConflictReceiptFromUnknown(receipt) !== undefined,
    "every receipt must survive the wire schema a client decodes with",
  );
  check(
    /^[0-9a-f]{12}$/.test(receipt.scopeDigest),
    "a receipt must name the scope only by its digest",
  );
  const serialized = JSON.stringify(receipt);
  for (const secret of secrets) {
    check(!serialized.includes(secret), "a receipt leaked a protected identifier");
  }
}
const diagnostics = JSON.stringify(
  redactPrimeLeaseDiagnostics({ scope, status: "held", generation: recovered.handle.generation }),
);
for (const secret of secrets) {
  check(!diagnostics.includes(secret), "lease diagnostics must not carry identifiers");
}
line(
  `redaction: ${receiptsSeen.length} receipts, ${new Set(receiptsSeen.map((r) => r.reason)).size} distinct reasons, 0 identifiers, 0 host paths`,
);

// 7. The adapter gate refuses activation and send the same way.
const gateA = makePrimeSessionWriteGate({
  service: processOne,
  writer: clientA,
  scopeForThread: (threadId) => scopeFor({ threadId }),
  now,
});
let gateRefusal: unknown;
try {
  await gateA.acquire({ threadId: "thread-a", operation: "activate" });
} catch (error) {
  gateRefusal = error;
}
check(
  gateRefusal instanceof PrimeSessionLeaseConflictError,
  "the adapter gate must refuse activation for a scope another writer holds",
);
check(
  gateRefusal instanceof PrimeSessionLeaseConflictError &&
    findSessionWriterReceiptViolation(gateRefusal.receipt) === undefined,
  "the gate's receipt must be redacted too",
);
check(
  gateRefusal instanceof Error && !gateRefusal.message.includes(primeSessionWriterToken(clientB)),
  "the gate's message must not name the owner",
);
line("adapter gate: activation refused with a redacted typed receipt");

// 8. The arbitration schema is the one PA-B01 registered; B03 adds no slot.
const slot = migrationManifest.filter(([, name]) => name === "PrimeResumeCursors");
check(slot.length === 1, "the lease columns must live in exactly one migration");
check(slot[0]![0] === 48, "the lease columns belong to slot 48");
line(`schema: lease columns owned by migration slot ${slot[0]![0]} ${slot[0]![1]}, no new slot`);

process.stdout.write(`${report.join("\n")}\n`);
process.stdout.write(`PA-B03 arbitration artifact: ${checks} source-derived assertions passed\n`);
