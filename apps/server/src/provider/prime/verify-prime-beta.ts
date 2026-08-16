// A standalone review artifact: it runs outside any Effect runtime, against a
// real disposable two-home tree, with fixed timestamps.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PRIME_RESUME_CURSOR_VERSION, type PrimeResumeCursorScope } from "@t3tools/contracts";

import {
  classifyPrimeCompatibility,
  KNOWN_INCOMPATIBLE_PRIME_AGENT_VERSIONS,
  MINIMUM_PRIME_AGENT_VERSION,
} from "./PrimeCompatibility.ts";
import {
  planPrimeCleanup,
  primeRolloutTransition,
  PRIME_LIFECYCLE_EVENTS,
} from "./PrimeDurableCleanup.ts";
import { writePrimeOwnership } from "./PrimeOwnership.ts";
import {
  makePrimeResumeCoordinator,
  type PrimeResumeCoordinatorDeps,
} from "./PrimeResumeCoordinator.ts";
import {
  makePrimeResumeCursor,
  PRIME_RESUME_MAX_BYTES,
  primeSessionPathToken,
  readPrimeResumeCursor,
  writePrimeResumeCursor,
} from "./PrimeResumeCursor.ts";
import { primeHomeFingerprint, primeResourceLayout } from "./PrimeResourceLayout.ts";
import {
  initialPrimeResumeModel,
  primeResumeReduce,
  primeResumeSurface,
} from "../../../../../packages/client-runtime/src/primeResume.ts";
import {
  makeInMemoryPrimeSessionLeaseStore,
  makePrimeSessionLeaseService,
  PrimeSessionLeaseConflictError,
} from "./PrimeSessionLease.ts";

/**
 * PA-B06 Beta certification review artifact.
 *
 * Every assertion runs the checked-in compatibility classifier, recovery
 * coordinator, cursor codec, ownership writer, cleanup planner and arbitration
 * lease. Nothing is mocked. Two disposable T3 homes are created under the
 * system temp directory and removed at the end; no live state, database,
 * browser, Electron process or simulator is touched, and paths never print.
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
const NOW_MS = Date.parse(RECORDED_AT);
const AGENT_VERSION = "0.7.2";
const CAPABILITY_DIGEST = "sha256:pa-b06-capabilities";
let cursorReads = 0;
let cursorWrites = 0;
/**
 * Reads this file performs *directly*. The recovery coordinator opens the
 * cursor itself on every resume, and those reads are not counted here — the
 * report below states the direct number and a lower bound, never a total.
 */
const readCursor = async (path: string) => {
  cursorReads++;
  return await readPrimeResumeCursor(path);
};
const cursorFiles = new Set<string>();

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
};
const scopeHash = (scope: PrimeResumeCursorScope) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(scope)))
    .digest("hex")
    .slice(0, 12);

const makeHome = async (label: string) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), `t3-pa-b06-${label}-`)));
  const scope = {
    environmentId: `env-${label}`,
    providerInstanceId: "prime-agent",
    projectId: "project-a",
    threadId: "thread-a",
    homeFingerprint: primeHomeFingerprint(home),
  } as PrimeResumeCursorScope;
  const layout = primeResourceLayout({
    home,
    environmentId: scope.environmentId,
    instanceId: scope.providerInstanceId,
    threadId: scope.threadId,
  });
  await mkdir(layout.session, { recursive: true });
  await writeFile(join(layout.session, "durable"), "session bytes");
  cursorFiles.add(layout.resumeCursor);
  return { home, scope, layout };
};

const homeA = await makeHome("a");
const homeB = await makeHome("b");

const cursorFor = (
  home: typeof homeA,
  overrides: { scope?: PrimeResumeCursorScope; generation?: number; version?: string } = {},
) =>
  makePrimeResumeCursor({
    scope: overrides.scope ?? home.scope,
    sessionPathToken: primeSessionPathToken(home.home, home.layout.session),
    ownershipGeneration: overrides.generation ?? 1,
    compatibility: {
      agentVersion: overrides.version ?? AGENT_VERSION,
      band: classifyPrimeCompatibility(overrides.version ?? AGENT_VERSION),
    },
    capabilityDigest: CAPABILITY_DIGEST,
    recordedAt: RECORDED_AT,
  });

const writeCursor = async (path: string, cursor: ReturnType<typeof cursorFor>) => {
  cursorWrites++;
  cursorFiles.add(path);
  await writePrimeResumeCursor(path, cursor);
};

line("# PA-B06 Beta recovery-matrix certification artifact");
line("");
line("## 1. VERSION MATRIX");
for (const version of ["0.6.0", "0.7.1", "0.7.2", "0.7.3", "9.9.9"]) {
  const band = classifyPrimeCompatibility(version);
  line(`- ${version}: ${band}`);
}
line(`- minimum: ${MINIMUM_PRIME_AGENT_VERSION}`);
line(`- known incompatible: ${JSON.stringify([...KNOWN_INCOMPATIBLE_PRIME_AGENT_VERSIONS])}`);
equal(classifyPrimeCompatibility("0.6.0"), "incompatible", "0.6.0 compatibility");
equal(classifyPrimeCompatibility("0.7.1"), "incompatible", "0.7.1 compatibility");
equal(classifyPrimeCompatibility("0.7.2"), "compatible", "0.7.2 compatibility");
equal(classifyPrimeCompatibility("0.7.3"), "advisory", "0.7.3 compatibility");
equal(classifyPrimeCompatibility("9.9.9"), "advisory", "9.9.9 compatibility");
check(KNOWN_INCOMPATIBLE_PRIME_AGENT_VERSIONS.size > 0, "known-incompatible set is empty");
line("");

type ScenarioOptions = {
  readonly cursor?: ReturnType<typeof cursorFor>;
  readonly storage?: boolean;
  readonly generation?: number;
  readonly installedVersion?: string;
  readonly live?: boolean;
  readonly conflict?: boolean;
};

const runScenario = async (name: string, options: ScenarioOptions) => {
  await rm(homeA.layout.resumeCursor, { force: true });
  await rm(homeA.layout.resumeCursorBackup, { force: true });
  if (options.cursor !== undefined) await writeCursor(homeA.layout.resumeCursor, options.cursor);
  if (options.storage === false) await rm(homeA.layout.session, { recursive: true, force: true });

  const store = makeInMemoryPrimeSessionLeaseStore();
  const lease = makePrimeSessionLeaseService({ store, now: () => NOW_MS, authorize: () => true });
  const expectedWriter = { clientToken: `expected-${name}`, processToken: "process-a" };
  if (options.conflict === true) {
    const held = await lease.acquire({
      scope: homeA.scope,
      writer: { clientToken: "another-writer", processToken: "another-process" },
      operation: "activate",
    });
    equal(held.status, "granted", `${name} competing lease setup`);
  }
  let handle: Awaited<ReturnType<typeof lease.acquire>> extends infer T
    ? T extends { status: "granted"; handle: infer H }
      ? H | undefined
      : never
    : never;
  const deps: PrimeResumeCoordinatorDeps = {
    scopeForThread: async () => homeA.scope,
    cursorPath: () => homeA.layout.resumeCursor,
    sessionPathToken: () => primeSessionPathToken(homeA.home, homeA.layout.session),
    // A real filesystem answer, not a flag: the "storage removed" scenario
    // actually removes the durable session directory below.
    sessionStorageExists: async () =>
      await stat(homeA.layout.session).then(
        () => true,
        () => false,
      ),
    ownershipGeneration: async () => options.generation ?? 1,
    agentVersion: async () => options.installedVersion ?? AGENT_VERSION,
    capabilityDigest: () => CAPABILITY_DIGEST,
    liveSession: () => (options.live === undefined ? undefined : async () => options.live === true),
    acquireLease: async () => {
      const outcome = await lease.acquire({
        scope: homeA.scope,
        writer: expectedWriter,
        operation: "activate",
      });
      if (outcome.status === "conflict") throw new PrimeSessionLeaseConflictError(outcome.receipt);
      handle = outcome.handle;
    },
    releaseLease: async () => {
      if (handle === undefined) return;
      await lease.release(handle, {
        scope: homeA.scope,
        writer: expectedWriter,
        operation: "release",
      });
      handle = undefined;
    },
    now: () => new Date(RECORDED_AT),
  };
  const decision = await makePrimeResumeCoordinator(deps).resume(homeA.scope.threadId);
  if (handle !== undefined) await deps.releaseLease(homeA.scope.threadId);
  if (options.storage === false) {
    await mkdir(homeA.layout.session, { recursive: true });
    await writeFile(join(homeA.layout.session, "durable"), "session bytes");
  }
  line(`- ${name}: ${decision.plan.kind} / ${JSON.stringify(decision.state)}`);
  return decision;
};

line("## 2. SCENARIO RESULTS");
const scenarios = [
  ["no cursor", await runScenario("no cursor", {})],
  [
    "live session proof",
    await runScenario("live session proof", { cursor: cursorFor(homeA), live: true }),
  ],
  [
    "recorded, no live session",
    await runScenario("recorded, no live session", { cursor: cursorFor(homeA) }),
  ],
  [
    "storage directory removed",
    await runScenario("storage directory removed", { cursor: cursorFor(homeA), storage: false }),
  ],
  [
    "other home/environment cursor",
    await runScenario("other home/environment cursor", {
      cursor: cursorFor(homeA, { scope: homeB.scope }),
    }),
  ],
  [
    "ownership generation changed",
    await runScenario("ownership generation changed", { cursor: cursorFor(homeA), generation: 2 }),
  ],
  [
    "incompatible agent version",
    await runScenario("incompatible agent version", {
      cursor: cursorFor(homeA),
      installedVersion: "0.7.1",
    }),
  ],
  [
    "lease held by another writer",
    await runScenario("lease held by another writer", { cursor: cursorFor(homeA), conflict: true }),
  ],
] as const;
equal(scenarios[0][1].plan.kind, "fresh", "no cursor plan");
equal(scenarios[1][1].plan.kind, "adopt", "live session plan");
equal(scenarios[2][1].plan.kind, "relaunch", "durable session plan");
equal(
  scenarios[3][1].state,
  { status: "unavailable", reason: "storageMismatch" },
  "storageMissing scenario state",
);
equal(
  scenarios[4][1].state,
  { status: "unavailable", reason: "scopeMismatch" },
  "scopeMismatch scenario state",
);
equal(
  scenarios[5][1].state,
  { status: "unavailable", reason: "ownershipMismatch" },
  "ownershipChanged scenario state",
);
equal(
  scenarios[6][1].state,
  { status: "unavailable", reason: "incompatibleVersion" },
  "incompatible version state",
);
equal(scenarios[7][1].state, { status: "unavailable", reason: "conflict" }, "lease conflict state");
equal(
  scenarios.filter(([, decision]) => decision.plan.kind === "fresh").length,
  1,
  "only no-cursor may start fresh",
);
for (const [name, decision] of scenarios.slice(1))
  check(decision.plan.kind !== "fresh", `${name} refusal started fresh`);
line("");

line("## 3. SPAWN/OWNERSHIP MANIFEST");
const homeAPlanPaths: Array<string> = [];
for (const [index, home] of [homeA, homeB].entries()) {
  await writePrimeOwnership(home.layout.ownership, {
    version: 1,
    environmentId: home.scope.environmentId,
    instanceId: home.scope.providerInstanceId,
    threadId: home.scope.threadId,
    process: { pid: 4200 + index, startToken: "captured-start" },
  });
}
for (const event of PRIME_LIFECYCLE_EVENTS) {
  const plan = planPrimeCleanup({
    home: homeA.home,
    scope: homeA.scope,
    lifecycleEvent: event,
    guard: { status: "clear" },
  });
  const tokens = plan.targets.map((target) => target.pathToken);
  line(`- ${event}: ${tokens.length === 0 ? "no targets" : tokens.join(" ")}`);
  const destructive = [
    "threadDelete",
    "instanceRemoved",
    "instanceReconfigured",
    "storageMigration",
  ].includes(event);
  equal(plan.targets.length, destructive ? 2 : 0, `${event} target count`);
  for (const target of plan.targets) {
    check(!target.pathToken.includes(homeA.home), `${event} token leaked a path`);
    homeAPlanPaths.push(target.path);
  }
}
line("");

line("## 4. CURSOR-STATE HASHES");
await writeCursor(homeA.layout.resumeCursor, cursorFor(homeA));
await writeCursor(homeB.layout.resumeCursor, cursorFor(homeB));
const hashes: Array<string> = [];
for (const [label, home] of [
  ["home-a", homeA],
  ["home-b", homeB],
] as const) {
  // Derived from what is actually on disk, not from the in-memory scope.
  const { state } = await readCursor(home.layout.resumeCursor);
  check(state.status === "available", `${label} cursor is not readable`);
  if (state.status !== "available") break;
  const hash = scopeHash(state.cursor.scope);
  hashes.push(hash);
  line(`- ${label}: ${hash} (session ${state.cursor.sessionPathToken})`);
  const raw = await readFile(home.layout.resumeCursor, "utf8");
  check(!raw.includes(home.home), "cursor leaked its home path");
  check(!raw.includes(home.layout.root), "cursor leaked its Prime root path");
}
check(hashes[0] !== hashes[1], "two homes produced the same scope hash");
// The second home is a bystander of every scenario above: still there, still
// readable, and never named by the first home's cleanup manifest.
check(
  homeAPlanPaths.every((path) => path.startsWith(homeA.home) && !path.startsWith(homeB.home)),
  "a cleanup target escaped its own home",
);
for (const path of [homeB.layout.session, homeB.layout.ownership, homeB.layout.resumeCursor])
  check(
    await stat(path).then(
      () => true,
      () => false,
    ),
    "the second T3 home lost a resource",
  );
line(`- home-b survived every home-a scenario and manifest: yes`);
line("");

line("## 5. ROLLBACK");
const futureVersion = PRIME_RESUME_CURSOR_VERSION + 1;
const futureBytes = `${JSON.stringify({ version: futureVersion, scope: homeA.scope, futureOnly: { keep: true } }, undefined, 2)}\n`;
await writeFile(homeA.layout.resumeCursor, futureBytes);
cursorWrites++;
const futureRead = await readPrimeResumeCursor(homeA.layout.resumeCursor);
cursorReads++;
equal(
  futureRead.state,
  { status: "unavailable", reason: "unsupportedVersion", storedVersion: futureVersion },
  "future cursor state",
);
equal(
  await readFile(homeA.layout.resumeCursor, "utf8"),
  futureBytes,
  "future cursor read changed bytes",
);
for (const transition of [
  primeRolloutTransition({ enabled: true, previouslyEnabled: false }),
  primeRolloutTransition({ enabled: false, previouslyEnabled: true }),
  primeRolloutTransition({ enabled: false, previouslyEnabled: true, rollingBack: true }),
]) {
  line(`- ${transition.action}: deletesDurableData=${transition.deletesDurableData}`);
  check(transition.deletesDurableData === false, `${transition.action} deleted durable data`);
}
line("");

line("## 6. PERFORMANCE COUNTS");
let largestCursorBytes = 0;
for (const path of cursorFiles) {
  const size = await stat(path).then(
    (entry) => entry.size,
    () => 0,
  );
  largestCursorBytes = Math.max(largestCursorBytes, size);
  check(size < PRIME_RESUME_MAX_BYTES, "cursor exceeded PRIME_RESUME_MAX_BYTES");
}
line(`- scenarios: ${scenarios.length}`);
line(`- direct cursor reads by this artifact: ${cursorReads}`);
line(`- direct cursor writes by this artifact: ${cursorWrites}`);
// The coordinator reads the cursor itself, at least once per resume, so the
// two numbers above are floors and not an I/O total. Say so rather than let a
// reader treat a partial count as the bound.
line(
  `- total cursor reads including the coordinator's own: >= ${cursorReads + scenarios.length} (not instrumented inside the coordinator)`,
);
line(`- largest cursor: ${largestCursorBytes} bytes`);
equal(scenarios.length, 8, "scenario count");
check(largestCursorBytes < PRIME_RESUME_MAX_BYTES, "largest cursor is not bounded");
line("");

line("## 7. CLIENT SURFACE (web, desktop and mobile share this reducer)");
for (const [name, decision] of scenarios) {
  const surface = primeResumeSurface(
    "prime-agent",
    primeResumeReduce(initialPrimeResumeModel, { type: "state", state: decision.state }),
  );
  line(`- ${name}: ${surface.kind}, composer ${surface.composerBlocked ? "blocked" : "open"}`);
  if (decision.state.status === "unavailable" && decision.state.reason !== "missing") {
    check(surface.composerBlocked, `${name} left the composer open after a refusal`);
    check(surface.choices.length > 0, `${name} offered no way out`);
  }
  // Coarse by construction: no refusal copy carries a path or a device.
  check(!surface.detail.includes("/"), `${name} surface leaked a path`);
}
line("");

line("## 8. VISUAL AND REAL-BINARY EVIDENCE");
line(
  "Visual evidence: NOT captured; no browser, Electron or simulator was launched, and permission was not granted.",
);
line(
  `Real-binary lane: PRIME_AGENT_BIN ${process.env.PRIME_AGENT_BIN === undefined ? "was not set" : "was set"}; nothing was installed.`,
);
line("");

await rm(homeA.home, { recursive: true, force: true });
await rm(homeB.home, { recursive: true, force: true });

line(`${checks} source-derived assertions passed.`);
process.stdout.write(`${report.join("\n")}\n`);
