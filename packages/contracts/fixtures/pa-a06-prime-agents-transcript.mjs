import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

/**
 * Source-derived PA-A06 subagent observation transcript.
 *
 * A scripted root plus two subagents runs through the *shipped* adapter mapper,
 * the shipped canonical contract, and the shipped client projection. Every
 * mapping below is imported and executed rather than mirrored, so a regression
 * in any of them fails this transcript with it.
 *
 * Run: `node packages/contracts/fixtures/pa-a06-prime-agents-transcript.mjs`
 */
const ROOT = new URL("../../../", import.meta.url);
const read = (relative) => NodeFS.readFileSync(new URL(relative, ROOT), "utf8");
const load = (relative) => import(new URL(relative, ROOT).href);

const {
  primeAgentRoster,
  primeAgentRosterFingerprint,
  primeObservationDecision,
  primeObservationRefusalMessage,
  MAX_PRIME_AGENTS,
} = await load("apps/server/src/provider/prime/PrimeObservation.ts");
const { ProviderRuntimeEvent, reduceProviderSessionAgentRoster } = await load(
  "packages/contracts/src/providerRuntime.ts",
);
const { capabilityForRuntimeOperation, supportsRuntimeOperation } = await load(
  "packages/contracts/src/providerCapabilities.ts",
);
const { hasPrimeAgents, primeAgentControl, renderPrimeAgent, visiblePrimeAgents } = await load(
  "apps/web/src/components/agents/primeAgents.ts",
);

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const canonical = (type, payload) =>
  decodeRuntimeEvent({
    type,
    eventId: `pa-a06-${type}-${JSON.stringify(payload).length}`,
    provider: "prime-agent",
    providerInstanceId: "prime-agent",
    threadId: "thread-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload,
  });

/** The native task store snapshots one scripted turn produces. */
export const fixtureTaskStores = [
  [
    { taskId: "root-1", title: "Refactor pass", status: "running" },
    { taskId: "sub-1", parentTaskId: "root-1", title: "Read the tests", status: "running" },
    { taskId: "sub-2", parentTaskId: "root-1", title: "Run the tests", status: "running" },
  ],
  [
    { taskId: "root-1", title: "Refactor pass", status: "running" },
    {
      taskId: "sub-1",
      parentTaskId: "root-1",
      title: "Read the tests",
      status: "running",
      detail: "12 tests read",
    },
    { taskId: "sub-2", parentTaskId: "root-1", title: "Run the tests", status: "running" },
  ],
  [
    { taskId: "root-1", title: "Refactor pass", status: "running" },
    {
      taskId: "sub-1",
      parentTaskId: "root-1",
      title: "Read the tests",
      status: "completed",
      detail: "12 tests read",
    },
    { taskId: "sub-2", parentTaskId: "root-1", title: "Run the tests", status: "failed" },
  ],
];

/** Runs the shipped mapper over a task store and returns the roster. */
export function mapRoster(tasks, observed = new Set()) {
  return primeAgentRoster(tasks, observed);
}

/** The shipped canonical reducer, fed shipped-schema-decoded snapshots. */
export function projectRoster(rosters) {
  return rosters.reduce(
    (state, agents) =>
      reduceProviderSessionAgentRoster(state, canonical("session.agents.updated", { agents })),
    undefined,
  );
}

function verifyDerivedFromSource() {
  if (
    !read("apps/server/src/provider/prime/PrimeObservation.ts").includes(
      "export const primeAgentRoster",
    )
  )
    throw new Error("the shipped mapper moved; this transcript is no longer source-derived");
  if (
    read("apps/mobile/src/features/threads/primeAgents.ts") !==
    read("apps/web/src/components/agents/primeAgents.ts")
  )
    throw new Error("the web and mobile client projections drifted apart");
}

function verifyRoster() {
  const observed = new Set();
  const first = mapRoster(fixtureTaskStores[0], observed);
  if (
    first.map((agent) => `${agent.role}:${agent.agentId}`).join(",") !==
    "root:root-1,subagent:sub-1,subagent:sub-2"
  )
    throw new Error("root and subagent identities were not mapped as the runtime reported them");
  // Repeated stores are byte-identical: nothing to republish.
  if (
    primeAgentRosterFingerprint(first) !==
    primeAgentRosterFingerprint(mapRoster(fixtureTaskStores[0], observed))
  )
    throw new Error("an unchanged task store produced a different roster");
  // A chatty runtime cannot grow the roster past the canonical bound.
  const flood = Array.from({ length: 64 }, (_, index) => ({
    taskId: `t-${index}`,
    parentTaskId: "root-1",
    status: "running",
  }));
  if (mapRoster(flood).length !== MAX_PRIME_AGENTS) throw new Error("the roster is not bounded");
  let refused = false;
  try {
    canonical("session.agents.updated", {
      agents: [
        ...mapRoster(flood),
        { agentId: "extra", role: "subagent", status: "running", title: "x", observed: false },
      ],
    });
  } catch {
    refused = true;
  }
  if (!refused) throw new Error("the canonical contract accepted an unbounded roster");
  return first;
}

function verifyObservation() {
  const observed = new Set();
  let roster = mapRoster(fixtureTaskStores[0], observed);
  // Ownership: only an agent this session reports may be observed.
  const foreign = primeObservationDecision(roster, "sub-from-another-daemon", "observe");
  if (foreign.allowed || foreign.reason !== "unknown-agent")
    throw new Error("an unowned identity was accepted");
  if (!primeObservationRefusalMessage(foreign.reason).includes("does not report"))
    throw new Error("the refusal does not say what happened");
  const allowed = primeObservationDecision(roster, "sub-1", "observe");
  if (!allowed.allowed) throw new Error("an owned running subagent could not be observed");
  observed.add("sub-1");
  roster = mapRoster(fixtureTaskStores[1], observed);
  const watching = roster.find((agent) => agent.agentId === "sub-1");
  if (!watching.observed || watching.detail !== "12 tests read")
    throw new Error("observed output did not land on the agent's own row");
  // The reverse always exists while it is observed.
  if (!primeObservationDecision(roster, "sub-1", "unobserve").allowed)
    throw new Error("an observed agent could not be unobserved");
  // A finished agent drops its observation instead of keeping a dead stream.
  roster = mapRoster(fixtureTaskStores[2], observed);
  const finished = roster.find((agent) => agent.agentId === "sub-1");
  if (finished.observed) throw new Error("a finished agent kept an observation");
  if (primeObservationDecision(roster, "sub-1", "observe").reason !== "terminal-agent")
    throw new Error("a finished agent could still be observed");
  return roster;
}

function verifyCapabilityGate() {
  for (const type of ["task.observe", "task.unobserve"]) {
    if (capabilityForRuntimeOperation({ type }) !== "tasks")
      throw new Error(`${type} is not gated by the tasks capability`);
    if (
      supportsRuntimeOperation({}, { type }) ||
      !supportsRuntimeOperation({ tasks: true }, { type })
    )
      throw new Error(`${type} is not capability-gated`);
  }
}

function verifyClients(roster) {
  if (hasPrimeAgents("prime-agent", {}) || !hasPrimeAgents("prime-agent", { tasks: true }))
    throw new Error("the client surface is not capability-gated");
  const live = { status: "running" };
  // Two clients derive their view independently from the same snapshot.
  const a = visiblePrimeAgents({ agents: roster }, live).map(renderPrimeAgent);
  const b = visiblePrimeAgents(
    { agents: roster.map((agent) => ({ ...agent })) },
    { status: "ready" },
  ).map(renderPrimeAgent);
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error("two clients disagreed about the same snapshot");
  // A session that is no longer live shows nothing and offers no control.
  if (visiblePrimeAgents({ agents: roster }, { status: "stopped" }).length !== 0)
    throw new Error("a dead session kept showing agents");
  if (primeAgentControl(roster[0], { status: "stopped" }, { tasks: true }).enabled)
    throw new Error("a dead session still offered an agent control");
  return { a, b };
}

function verifyProjection(roster) {
  const projected = projectRoster([roster]);
  if (JSON.stringify(projected.agents) !== JSON.stringify(roster))
    throw new Error("the canonical snapshot did not round-trip");
  // An exited session keeps no agents: an observation cannot outlive it.
  const cleared = reduceProviderSessionAgentRoster(
    projected,
    canonical("session.exited", { reason: "exited" }),
  );
  if (cleared.agents.length !== 0) throw new Error("an exited session kept its roster");
  return projected;
}

export function verifyTranscript() {
  verifyDerivedFromSource();
  const roster = verifyRoster();
  const observedRoster = verifyObservation();
  verifyCapabilityGate();
  const clients = verifyClients(observedRoster);
  const projected = verifyProjection(roster);
  return { roster, observedRoster, clients, projected };
}

if (process.argv[1] !== undefined && NodeURL.fileURLToPath(import.meta.url) === process.argv[1]) {
  const { clients, observedRoster } = verifyTranscript();
  for (const line of clients.a) console.log(line);
  console.log(
    `final roster: ${observedRoster.map((agent) => `${agent.agentId}=${agent.status}`).join(", ")}`,
  );
  console.log(
    "PA-A06 Prime agents transcript verified (source-derived, runtime-owned identities, bounded roster, observation reversible, unowned targets refused, no transcript duplication, dead sessions show nothing)",
  );
}
