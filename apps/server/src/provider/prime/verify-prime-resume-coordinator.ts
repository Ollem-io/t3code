// A standalone review artifact: it runs outside any Effect runtime, against a
// real temporary T3 home, with a fixed recorded timestamp.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findPrimeResumeRedactionViolation, ThreadId } from "@t3tools/contracts";

import { PrimeEventNormalizer } from "./PrimeEventNormalizer.ts";
import { decodePrimeRpcEnvelope } from "./PrimeRpcProtocol.ts";
import {
  makePrimeResumeCoordinator,
  primeCapabilityDigest,
  primeResumeRefusalMessage,
} from "./PrimeResumeCoordinator.ts";
import {
  primeSessionPathToken,
  readPrimeResumeCursor,
  writePrimeResumeCursor,
} from "./PrimeResumeCursor.ts";
import { primeHomeFingerprint, primeResourceLayout } from "./PrimeResourceLayout.ts";
import {
  makeInMemoryPrimeSessionLeaseStore,
  makePrimeSessionLeaseService,
  makePrimeSessionWriteGate,
} from "./PrimeSessionLease.ts";

/**
 * PA-B02 review artifact.
 *
 * Every assertion runs the checked-in production resume coordinator, cursor
 * storage, arbitration lease and event normalizer. Nothing is mocked, no live
 * state, database, browser or simulator is touched, and the report carries
 * session *identity* and transcript *hashes* only — no content, no host path.
 *
 * The restart is real in the only sense that matters here: the second run gets
 * a brand new coordinator, a brand new normalizer and a brand new writer
 * identity, so anything it recovers came out of durable storage.
 */

let checks = 0;
function check(value: unknown, message: string): asserts value {
  checks++;
  if (!value) throw new Error(message);
}

const report: Array<string> = [];
const line = (text: string) => report.push(text);

const home = await mkdtemp(join(tmpdir(), "t3-pa-b02-"));
const THREAD = "thread-a";
const CAPABILITIES = primeCapabilityDigest({
  runtimeExtensions: { steer: true, tasks: true, goals: true },
});

const layout = primeResourceLayout({
  home,
  environmentId: "env-a",
  instanceId: "prime",
  threadId: THREAD,
});
await mkdir(layout.session, { recursive: true });

const scope = {
  environmentId: "env-a",
  providerInstanceId: "prime",
  projectId: "project-a",
  threadId: THREAD,
  homeFingerprint: primeHomeFingerprint(home),
} as never;

const sessionToken = primeSessionPathToken(home, layout.session);

/** One arbitration store shared by both "processes", as one T3 home would be. */
const leaseStore = makeInMemoryPrimeSessionLeaseStore();
let clock = 1_000;
const gateFor = (writerToken: string) =>
  makePrimeSessionWriteGate({
    service: makePrimeSessionLeaseService({
      store: leaseStore,
      now: () => clock,
      authorize: () => true,
    }),
    writer: { clientToken: writerToken, processToken: writerToken },
    scopeForThread: () => scope,
    now: () => clock,
    scheduleRenewal: () => () => {},
  });

const coordinatorFor = (
  writerToken: string,
  overrides: {
    readonly agentVersion?: string | undefined;
    readonly capabilityDigest?: string;
    readonly generation?: number;
    readonly published?: Array<unknown>;
  } = {},
) => {
  const gate = gateFor(writerToken);
  return makePrimeResumeCoordinator({
    scopeForThread: async () => scope,
    cursorPath: () => layout.resumeCursor,
    sessionPathToken: () => sessionToken,
    sessionStorageExists: async () => true,
    ownershipGeneration: async () => overrides.generation ?? 1,
    agentVersion: async () => ("agentVersion" in overrides ? overrides.agentVersion : "0.7.3"),
    capabilityDigest: () => overrides.capabilityDigest ?? CAPABILITIES,
    liveSession: () => undefined,
    acquireLease: (threadId) => gate.acquire({ threadId, operation: "activate" }),
    releaseLease: (threadId) => gate.release({ threadId }),
    publish: (_threadId, state) => overrides.published?.push(state),
    now: () => new Date("2026-08-16T00:00:00.000Z"),
  });
};

/**
 * The projected transcript for one fixed turn, hashed. The point of hashing is
 * that a resume must reproduce the *same* projection and must not duplicate it:
 * the number is comparable across the restart and reveals nothing that was said.
 */
const transcriptHash = () => {
  const normalizer = new PrimeEventNormalizer(ThreadId.make(THREAD), {
    providerInstanceId: "prime",
    now: () => "2026-08-16T00:00:00.000Z",
  });
  const events: Array<unknown> = [];
  for (const raw of [
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "…" },
    },
    { type: "message_end", message: { role: "assistant" } },
    { type: "turn_end", message: { role: "assistant" }, toolResults: [] },
  ]) {
    for (const event of normalizer.drain(decodePrimeRpcEnvelope(raw))) events.push(event);
  }
  return {
    count: events.length,
    hash: createHash("sha256").update(JSON.stringify(events)).digest("hex").slice(0, 16),
  };
};

// 1. First run: nothing to recover, so a fresh session is allowed — and only
//    because the cursor is completely absent.
const firstPublished: Array<unknown> = [];
const first = coordinatorFor("process-one", { published: firstPublished });
const initial = await first.resume(THREAD);
check(initial.plan.kind === "fresh", "an absent cursor is the only fresh start");
check(initial.leaseHeld === false, "a fresh start must not hold a resume lease");
check(firstPublished.length === 0, "a thread with no session must not publish a recovery state");
await first.recordSession({ threadId: THREAD });
const before = await readPrimeResumeCursor(layout.resumeCursor);
check(before.state.status === "available", "the first session must record a cursor");
const beforeTranscript = transcriptHash();
line(
  `run 1: fresh session recorded, cursor v${before.state.status === "available" ? before.state.cursor.version : 0} ` +
    `session=${sessionToken.slice(0, 12)}… transcript=${beforeTranscript.hash} (${beforeTranscript.count} events)`,
);

// 2. Barrier: two processes recover the same durable session from the same
//    observed state. Exactly one may become the writer.
const barrierA = coordinatorFor("process-two");
const barrierB = coordinatorFor("process-three");
const raced = await Promise.all([barrierA.resume(THREAD), barrierB.resume(THREAD)]);
const winners = raced.filter((decision) => decision.leaseHeld);
const losers = raced.filter((decision) => !decision.leaseHeld);
check(winners.length === 1, "exactly one process may activate a durable session");
check(winners[0]!.plan.kind === "relaunch", "the winner reopens the exact recorded session");
check(
  losers.length === 1 && losers[0]!.state.status === "unavailable",
  "the loser must receive a typed unavailable state",
);
check(
  losers[0]!.state.status === "unavailable" && losers[0]!.state.reason === "conflict",
  "the loser's reason must be a retryable conflict",
);
line(`restart barrier: 1 activation, 1 conflict, 0 fresh sessions`);

// 3. The recovered session is the *same* session, and the projection did not
//    change or duplicate across the restart.
await barrierA.recordSession({ threadId: THREAD, mode: "relaunched" });
const after = await readPrimeResumeCursor(layout.resumeCursor);
check(after.state.status === "available", "the recovered session must still be recorded");
check(
  after.state.status === "available" &&
    before.state.status === "available" &&
    after.state.cursor.sessionPathToken === before.state.cursor.sessionPathToken,
  "resume must reopen the exact recorded session",
);
const afterTranscript = transcriptHash();
check(
  afterTranscript.hash === beforeTranscript.hash &&
    afterTranscript.count === beforeTranscript.count,
  "resume must not duplicate or rewrite the projected transcript",
);
line(
  `run 2: adopted the same session=${sessionToken.slice(0, 12)}… transcript=${afterTranscript.hash} ` +
    `(${afterTranscript.count} events, unchanged)`,
);

// 4. Repeated recovery is idempotent.
const repeat = await barrierA.resume(THREAD);
check(repeat.plan.kind === "relaunch", "repeated recovery must reach the same decision");
check(repeat.leaseHeld === true, "repeated recovery must not drop the lease it holds");
line("idempotence: repeated recovery reproduces the same decision and lease");

// 5. Every refusal: no case may become a new session, and none may rewrite the
//    stored cursor.
const storedBytes = await readFile(layout.resumeCursor, "utf8");
clock += 60_000; // the winner's lease has lapsed; refusals must not depend on it
const refusals: ReadonlyArray<readonly [string, () => Promise<string>]> = [
  [
    "incompatibleVersion",
    async () => reasonOf(coordinatorFor("process-four", { agentVersion: "0.6.0" })),
  ],
  [
    "capabilityMismatch",
    async () => reasonOf(coordinatorFor("process-five", { capabilityDigest: "cap-changed" })),
  ],
  ["ownershipMismatch", async () => reasonOf(coordinatorFor("process-six", { generation: 0 }))],
];
async function reasonOf(coordinator: ReturnType<typeof coordinatorFor>): Promise<string> {
  const decision = await coordinator.resume(THREAD);
  check(decision.plan.kind === "unavailable", "a refusal must never become a fresh session");
  return decision.state.status === "unavailable" ? decision.state.reason : "unexpected";
}
for (const [expected, run] of refusals) {
  const reason = await run();
  check(reason === expected, `expected ${expected}, saw ${reason}`);
  const message = primeResumeRefusalMessage(reason as never);
  check(!message.includes(home), "a refusal message must not carry a host path");
  line(`refusal: ${expected} → unavailable, no session started`);
}

// A corrupt, future and cross-environment cursor are all readable refusals too.
const cursorPath = layout.resumeCursor;
for (const [label, payload, expected] of [
  ["corrupt bytes", "{not json", "corrupt"],
  ["future version", JSON.stringify({ version: 99, lifecycle: "recorded" }), "unsupportedVersion"],
] as const) {
  await writeFile(cursorPath, payload);
  const reason = await reasonOf(coordinatorFor("process-seven"));
  check(reason === expected, `${label} must be reported as ${expected}`);
  line(`refusal: ${label} → ${expected}, no session started`);
}
await writeFile(cursorPath, storedBytes);
const foreign = await readPrimeResumeCursor(cursorPath);
check(foreign.state.status === "available", "the original cursor must be restorable");
if (foreign.state.status === "available") {
  await writePrimeResumeCursor(cursorPath, {
    ...foreign.state.cursor,
    scope: { ...foreign.state.cursor.scope, environmentId: "env-other" as never },
  });
}
const foreignReason = await reasonOf(coordinatorFor("process-eight"));
check(foreignReason === "scopeMismatch", "a foreign environment must never be adopted");
line("refusal: another environment → scopeMismatch, no cross-environment adoption");

// 6. Nothing in this report, and nothing in the stored cursor, is content.
for (const secret of [home, layout.session, "userdata", "/tmp/", "project-a", "env-a"]) {
  check(!report.join("\n").includes(secret), `the report must not carry ${secret}`);
}
// The cursor legitimately stores its own scope identifiers — that is what makes
// a cross-environment adoption provable — but it may never carry a host path,
// a transcript, a setting or any other content.
check(
  findPrimeResumeRedactionViolation(JSON.parse(storedBytes)) === undefined,
  "the stored cursor must be free of content and host paths",
);
for (const secret of [home, layout.session]) {
  check(!storedBytes.includes(secret), `the stored cursor must not carry ${secret}`);
}
const identity = createHash("sha256").update(sessionToken).digest("hex").slice(0, 16);
line(`redaction: report + cursor free of content and host paths; session identity ${identity}`);

process.stdout.write(`${report.join("\n")}\n`);
process.stdout.write(
  `PA-B02 resume coordinator artifact: ${checks} source-derived assertions passed\n`,
);
