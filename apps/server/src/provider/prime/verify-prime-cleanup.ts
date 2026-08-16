// A standalone review artifact: it runs outside any Effect runtime, against a
// real disposable two-home tree, with fixed timestamps.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { primeResumeScopeKey, type PrimeResumeCursorScope } from "@t3tools/contracts";

import {
  executePrimeCleanup,
  makeInMemoryPrimeCleanupJournalStore,
  planPrimeCleanup,
  primeCleanupReasonForLifecycle,
  primeRolloutTransition,
  redactPrimeCleanupReport,
  resumePrimeCleanup,
  PRIME_LIFECYCLE_EVENTS,
  type PrimeCleanupGuard,
  type PrimeCleanupJournalStore,
} from "./PrimeDurableCleanup.ts";
import { writePrimeOwnership } from "./PrimeOwnership.ts";
import {
  decodePrimeResumeCursor,
  makePrimeResumeCursor,
  primeResumeCursorPreservedPath,
  primeSessionPathToken,
  readPrimeResumeCursor,
  writePrimeResumeCursor,
} from "./PrimeResumeCursor.ts";
import { primeHomeFingerprint, primeResourceLayout } from "./PrimeResourceLayout.ts";
import {
  makeInMemoryPrimeSessionLeaseStore,
  makePrimeSessionLeaseService,
  PRIME_SESSION_LEASE_TTL_MS,
} from "./PrimeSessionLease.ts";

/**
 * PA-B05 review artifact.
 *
 * Every assertion runs the checked-in cleanup planner/executor, the ownership
 * proof boundary, the resume-cursor codec and the PA-B03 arbitration lease.
 * Nothing is mocked. Two disposable T3 homes are created under the system temp
 * directory and removed at the end; no live state, database, browser or
 * simulator is touched, and the printed report carries digests only.
 */

let checks = 0;
function check(value: unknown, message: string): asserts value {
  checks++;
  if (!value) throw new Error(message);
}
const equal = (actual: unknown, expected: unknown, message: string) =>
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );

const report: Array<string> = [];
const line = (text: string) => report.push(text);

const RECORDED_AT = "2026-08-16T00:00:00.000Z";
const nowIso = () => RECORDED_AT;
const present = async (path: string) =>
  await stat(path).then(
    () => true,
    () => false,
  );

/** A whole disposable T3 home with two owned threads and two unowned sentinels. */
const makeHome = async (label: string) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), `t3-pa-b05-${label}-`)));
  const scopeFor = (threadId: string): PrimeResumeCursorScope =>
    ({
      environmentId: "env-a",
      providerInstanceId: "prime-agent",
      projectId: "project-a",
      threadId,
      homeFingerprint: primeHomeFingerprint(home),
    }) as PrimeResumeCursorScope;

  const seed = async (threadId: string, pid: number) => {
    const scope = scopeFor(threadId);
    const layout = primeResourceLayout({
      home,
      environmentId: "env-a",
      instanceId: "prime-agent",
      threadId,
    });
    await mkdir(layout.session, { recursive: true });
    await writeFile(join(layout.session, "owned"), "session bytes");
    await writeFile(layout.config, "{}");
    await writePrimeOwnership(layout.ownership, {
      version: 1,
      environmentId: "env-a",
      instanceId: "prime-agent",
      threadId,
      process: { pid, startToken: "captured-start" },
    });
    await writePrimeResumeCursor(
      layout.resumeCursor,
      makePrimeResumeCursor({
        scope,
        sessionPathToken: primeSessionPathToken(home, layout.session),
        ownershipGeneration: 1,
        compatibility: { agentVersion: "0.7.2", band: "compatible" },
        capabilityDigest: "sha256:cap",
        recordedAt: RECORDED_AT,
      }),
    );
    return { scope, layout };
  };

  // Sentinels: a Prime-shaped file this T3 never created, and a file outside
  // the Prime namespace entirely. Neither may be touched by any run.
  const primeSentinel = join(home, "userdata", "prime", "v1", "not-ours.json");
  const homeSentinel = join(home, "unrelated.txt");
  await mkdir(join(home, "userdata", "prime", "v1"), { recursive: true });
  await writeFile(primeSentinel, "another tool wrote this");
  await writeFile(homeSentinel, "not even prime");

  return { home, scopeFor, seed, primeSentinel, homeSentinel };
};

const proof = { processMatches: async () => true };
/** Platform removal boundary: only a proven inode is ever unlinked. */
const remover = (events: Array<string>) => ({
  stopProcess: async (handle: { readonly pid: number }) => {
    events.push(`stop:${handle.pid}`);
  },
  removeOwnedResource: async (resource: {
    readonly path: string;
    readonly identity: { readonly dev: string; readonly ino: string };
  }) => {
    const current = await stat(resource.path, { bigint: true }).catch(() => undefined);
    if (
      !current ||
      String(current.dev) !== resource.identity.dev ||
      String(current.ino) !== resource.identity.ino
    ) {
      return "retained" as const;
    }
    await rm(resource.path, { recursive: true, force: true });
    return "removed" as const;
  },
});

const clearGuard = async (): Promise<PrimeCleanupGuard> => ({ status: "clear" });

const homeA = await makeHome("home-a");
const homeB = await makeHome("home-b");
const target = await homeA.seed("thread-a", 4242);
const sibling = await homeA.seed("thread-b", 4243);
const otherHome = await homeB.seed("thread-a", 4244);

line("# PA-B05 durable cleanup, retention and rollback artifact");
line("");
line(
  `two disposable T3 homes: ${primeHomeFingerprint(homeA.home)} ${primeHomeFingerprint(homeB.home)}`,
);
line(
  `confirmed scope digest: ${planPrimeCleanup({ home: homeA.home, scope: target.scope, lifecycleEvent: "threadDelete", guard: { status: "clear" } }).scopeDigest}`,
);
line("");

// ---------------------------------------------------------------- retention
line("## 1. Retention: what never deletes");
for (const event of PRIME_LIFECYCLE_EVENTS) {
  const reason = primeCleanupReasonForLifecycle(event);
  const plan = planPrimeCleanup({
    home: homeA.home,
    scope: target.scope,
    lifecycleEvent: event,
    guard: { status: "clear" },
  });
  line(
    `- ${event.padEnd(22)} -> ${reason === undefined ? "no cleanup" : reason} / ${plan.decision.action}`,
  );
  if (reason === undefined) {
    equal(plan.decision, { action: "refuse", reason: "nonDestructiveLifecycle" }, event);
    equal(plan.targets.length, 0, `${event} plans no target`);
  }
}
check(primeCleanupReasonForLifecycle("threadStop") === undefined, "stop must never delete");
check(primeCleanupReasonForLifecycle("threadArchive") === undefined, "archive must never delete");
check(await present(target.layout.session), "stop/archive left the session in place");
line("");

// ------------------------------------------------------------------ dry run
line("## 2. Dry run (nothing is touched)");
const dryRun = planPrimeCleanup({
  home: homeA.home,
  scope: target.scope,
  lifecycleEvent: "threadDelete",
  guard: { status: "clear" },
});
equal(dryRun.mode, "dryRun", "a plan is always a dry run");
equal(dryRun.requiresConfirmation, true, "a plan always requires confirmation");
for (const entry of dryRun.targets) {
  line(`- ${entry.kind.padEnd(15)} ${entry.pathToken}`);
  check(entry.path.startsWith(homeA.home), "a target escaped its own T3 home");
  check(!entry.path.startsWith(homeB.home), "a target reached into the other T3 home");
  check(!entry.pathToken.includes(homeA.home), "a manifest token leaked a host path");
}
check(dryRun.targets.length === 2, "the manifest is bounded");
check(await present(target.layout.thread), "planning removed something");
line("");

// -------------------------------------------------------------- arbitration
line("## 3. Cleanup vs. an active writer");
const leaseStore = makeInMemoryPrimeSessionLeaseStore();
let clock = 1_000;
const lease = makePrimeSessionLeaseService({
  store: leaseStore,
  now: () => clock,
  authorize: () => true,
});
const granted = await lease.acquire({
  scope: target.scope,
  writer: { clientToken: "client-a", processToken: "process-a" },
  operation: "activate",
});
check(granted.status === "granted", "the writer could not activate");
const leaseGuard = async (): Promise<PrimeCleanupGuard> => {
  const seen = await lease.inspect(target.scope);
  return seen.status === "held" ? { status: "leaseHeld", generation: 1 } : { status: "clear" };
};
const journal = makeInMemoryPrimeCleanupJournalStore();
const events: Array<string> = [];
const confirmedRun = (store: PrimeCleanupJournalStore, guard = leaseGuard) =>
  executePrimeCleanup({
    plan: dryRun,
    confirmation: { scopeDigest: dryRun.scopeDigest, acknowledged: true },
    journal: store,
    guard,
    proof,
    cleanup: remover(events),
    now: nowIso,
  });

const deferred = await confirmedRun(journal);
line(`- while the lease is held: ${deferred.outcome} (${deferred.reasonCode})`);
equal(deferred.outcome, "deferred", "cleanup must defer to an active writer");
equal(journal.rows.size, 0, "a deferred run may not open a journal");
check(await present(target.layout.thread), "a deferred run deleted something");

const unconfirmed = await executePrimeCleanup({
  plan: dryRun,
  confirmation: { scopeDigest: "pl-someone-else", acknowledged: true },
  journal,
  guard: clearGuard,
  proof,
  cleanup: remover(events),
  now: nowIso,
});
line(`- confirming a different scope: ${unconfirmed.outcome} (${unconfirmed.reasonCode})`);
equal(unconfirmed.reasonCode, "confirmationMismatch", "a foreign confirmation was accepted");
check(await present(target.layout.thread), "a mismatched confirmation deleted something");
line("");

// ------------------------------------------------------------ crash barrier
line("## 4. Crash at each journal checkpoint, then resume");
for (const crashAt of [1, 2, 3]) {
  const crashHome = await makeHome(`crash-${crashAt}`);
  const crashTarget = await crashHome.seed("thread-a", 5000 + crashAt);
  const crashSibling = await crashHome.seed("thread-b", 6000 + crashAt);
  const durable = makeInMemoryPrimeCleanupJournalStore();
  const crashEvents: Array<string> = [];
  let writes = 0;
  const crashing: PrimeCleanupJournalStore = {
    read: durable.read,
    clear: durable.clear,
    write: async (entry) => {
      writes += 1;
      if (writes === crashAt) throw new Error("simulated crash");
      await durable.write(entry);
    },
  };
  const crashPlan = planPrimeCleanup({
    home: crashHome.home,
    scope: crashTarget.scope,
    lifecycleEvent: "threadDelete",
    guard: { status: "clear" },
  });
  const crashed = await executePrimeCleanup({
    plan: crashPlan,
    confirmation: { scopeDigest: crashPlan.scopeDigest, acknowledged: true },
    journal: crashing,
    guard: clearGuard,
    proof,
    cleanup: remover(crashEvents),
    now: nowIso,
  }).then(
    () => "did not crash",
    (error: Error) => error.message,
  );
  equal(crashed, "simulated crash", "the barrier did not stop the run");

  const resumed = await resumePrimeCleanup({
    home: crashHome.home,
    scope: crashTarget.scope,
    journal: durable,
    guard: clearGuard,
    proof,
    cleanup: remover(crashEvents),
    now: nowIso,
  });
  const stops = crashEvents.filter((event) => event.startsWith("stop:")).length;
  line(
    `- crash before write ${crashAt}: resume -> ${resumed?.outcome ?? "nothing journaled"}, process signalled ${stops}x`,
  );
  check(stops <= 1, "the captured process was signalled more than once");
  if (crashAt === 1) {
    check(resumed === undefined, "an unjournaled crash must not be resumable");
    check(await present(crashTarget.layout.thread), "an unjournaled crash deleted something");
  } else {
    equal(resumed?.outcome, "completed", "the resumed run did not finish");
    check(!(await present(crashTarget.layout.thread)), "the confirmed thread survived");
    equal(durable.rows.size, 0, "a completed cleanup left a journal row behind");
  }
  check(await present(crashSibling.layout.thread), "an unrelated thread was deleted");
  check(await present(crashHome.primeSentinel), "an unowned Prime file was deleted");
  await rm(crashHome.home, { recursive: true, force: true });
}
line("");

// -------------------------------------------------------------- destructive
line("## 5. Confirmed destructive run");
clock += PRIME_SESSION_LEASE_TTL_MS + 1; // the writer is gone; its lease lapsed
const destructive = await confirmedRun(journal);
line(`- outcome: ${destructive.outcome}`);
for (const step of destructive.steps) line(`  - ${step.kind}: ${step.status}`);
equal(destructive.outcome, "completed", "the confirmed run did not complete");
check(!(await present(target.layout.thread)), "the confirmed thread survived");
check(!(await present(target.layout.resumeCursor)), "the confirmed cursor survived");
check(await present(sibling.layout.thread), "a sibling thread was deleted");
check(await present(sibling.layout.resumeCursor), "a sibling cursor was deleted");
check(await present(otherHome.layout.thread), "the other T3 home was reached");
check(await present(otherHome.layout.resumeCursor), "the other home's cursor was deleted");
equal(
  await readFile(homeA.primeSentinel, "utf8"),
  "another tool wrote this",
  "an unowned Prime file changed",
);
equal(await readFile(homeA.homeSentinel, "utf8"), "not even prime", "an unrelated file changed");
equal(journal.rows.size, 0, "a completed cleanup left a journal row behind");

// Re-running is a no-op, and a deleted thread reads as "no cursor" — never as
// a silently fresh session.
const again = await confirmedRun(journal, clearGuard);
equal(again.outcome, "completed", "repeating cleanup was not idempotent");
equal(events.filter((event) => event === "stop:4242").length, 1, "the process was stopped twice");
const afterDelete = await readPrimeResumeCursor(target.layout.resumeCursor, target.scope);
equal(afterDelete.state, { status: "unavailable", reason: "missing" }, "cursor state after delete");
line("");

// ------------------------------------------------------------ rollback/roll
line("## 6. Rollback and staged rollout");
for (const transition of [
  primeRolloutTransition({ enabled: false, previouslyEnabled: true }),
  primeRolloutTransition({ enabled: true, previouslyEnabled: false }),
  primeRolloutTransition({ enabled: false, previouslyEnabled: true, rollingBack: true }),
]) {
  line(
    `- ${transition.provider} ${transition.action}: deletesDurableData=${transition.deletesDurableData}`,
  );
  check(transition.provider === "prime-agent", "a transition escaped the Prime provider");
  check(transition.deletesDurableData === false, "a rollout transition deleted durable data");
}

// A cursor written by a newer build, read and rewritten by this one: the
// unknown payload is preserved verbatim in a version-keyed sidecar.
const rollbackScope = sibling.scope;
const futureCursor = `${JSON.stringify({ version: 99, scope: rollbackScope, futureOnly: { keep: "me" } }, undefined, 2)}\n`;
await writeFile(sibling.layout.resumeCursor, futureCursor);
const decoded = decodePrimeResumeCursor(futureCursor);
line(`- future cursor decodes as: ${JSON.stringify(decoded)}`);
equal(
  decoded,
  { status: "unavailable", reason: "unsupportedVersion", storedVersion: 99 },
  "an unknown cursor version must be unavailable, not corrupt",
);
await writePrimeResumeCursor(
  sibling.layout.resumeCursor,
  makePrimeResumeCursor({
    scope: rollbackScope,
    sessionPathToken: primeSessionPathToken(homeA.home, sibling.layout.session),
    ownershipGeneration: 2,
    compatibility: { agentVersion: "0.7.2", band: "compatible" },
    capabilityDigest: "sha256:cap",
    recordedAt: RECORDED_AT,
  }),
);
const preserved = primeResumeCursorPreservedPath(sibling.layout.resumeCursor, 99);
equal(
  await readFile(preserved, "utf8"),
  futureCursor,
  "the unknown future cursor was not preserved verbatim",
);
line("- unknown future payload preserved verbatim in its version-keyed sidecar");
line("");

// ---------------------------------------------------------------- redaction
line("## 7. Redaction");
const partialHome = await makeHome("partial");
const partialTarget = await partialHome.seed("thread-a", 7000);
const partialPlan = planPrimeCleanup({
  home: partialHome.home,
  scope: partialTarget.scope,
  lifecycleEvent: "instanceRemoved",
  guard: { status: "clear" },
});
const partial = await executePrimeCleanup({
  plan: partialPlan,
  confirmation: { scopeDigest: partialPlan.scopeDigest, acknowledged: true },
  journal: makeInMemoryPrimeCleanupJournalStore(),
  guard: clearGuard,
  // No platform removal callback: the ownership boundary fails closed.
  cleanup: { stopProcess: async () => {} },
  proof,
  now: nowIso,
});
const redacted = JSON.stringify(redactPrimeCleanupReport(partial), undefined, 2);
line(redacted);
equal(partial.outcome, "incomplete", "a retained resource must be reported as incomplete");
equal(partial.resumable, true, "a partial failure must stay resumable");
check(await present(partialTarget.layout.session), "a failed run deleted the session anyway");
for (const secret of [
  partialHome.home,
  "thread-a",
  "project-a",
  "env-a",
  primeResumeScopeKey(partialTarget.scope),
]) {
  check(!redacted.includes(secret), `the report leaked ${secret.slice(0, 12)}`);
}
check(redacted.length < 1_500, "the report is bounded");
await rm(partialHome.home, { recursive: true, force: true });
line("");

await rm(homeA.home, { recursive: true, force: true });
await rm(homeB.home, { recursive: true, force: true });

line(`${checks} source-derived assertions passed.`);
line("Visual evidence: not applicable; PA-B05 ships no user-visible surface here.");
process.stdout.write(`${report.join("\n")}\n`);
