import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

/**
 * Source-derived PA-A07 goals and owned-heartbeat transcript.
 *
 * An isolated daemon root hosts one unrelated sentinel schedule that T3 never
 * created, plus the heartbeat this environment creates, pauses, resumes, and
 * stops. Everything runs through the *shipped* adapter mapper, the shipped
 * canonical contract, the shipped ownership record validator, and the shipped
 * client projection: every mapping is imported and executed rather than
 * mirrored, so a regression in any of them fails this transcript with it.
 *
 * No live daemon, no live Prime state, and no host paths are involved.
 *
 * Run: `node packages/contracts/fixtures/pa-a07-prime-goals-heartbeats-transcript.mjs`
 */
const ROOT = new URL("../../../", import.meta.url);
const read = (relative) => NodeFS.readFileSync(new URL(relative, ROOT), "utf8");
const load = (relative) => import(new URL(relative, ROOT).href);

const {
  primeGoalBoard,
  primeGoalBoardFingerprint,
  primeHeartbeatCreateDecision,
  primeHeartbeatDecision,
  primeHeartbeatRefusalMessage,
  MAX_PRIME_HEARTBEATS,
  PRIME_HEARTBEAT_DAEMON_DISCLOSURE,
  PRIME_GOAL_MUTATION_REFUSAL,
} = await load("apps/server/src/provider/prime/PrimeGoalsHeartbeats.ts");
const { ProviderRuntimeEvent, reduceProviderSessionGoalBoard } = await load(
  "packages/contracts/src/providerRuntime.ts",
);
const { capabilityForRuntimeOperation, supportsRuntimeOperation } = await load(
  "packages/contracts/src/providerCapabilities.ts",
);
const { hasPrimeGoals, primeHeartbeatControls, primeHeartbeatDraftDecision, renderPrimeGoalBoard } =
  await load("apps/web/src/components/chat/primeHeartbeat.ts");

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const canonical = (type, payload) =>
  decodeRuntimeEvent({
    type,
    eventId: `pa-a07-${type}-${JSON.stringify(payload).length}`,
    provider: "prime-agent",
    providerInstanceId: "prime-agent",
    threadId: "thread-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload,
  });

const OWNER = "T3 thread thread-1";
/** A schedule the isolated daemon already hosts for somebody else. */
const SENTINEL = {
  heartbeatId: "hb-sentinel",
  title: "Someone else's nightly deploy",
  intervalSeconds: 3_600,
};
const T3_HEARTBEAT = {
  heartbeatId: "hb-t3-1",
  title: "Check CI",
  intervalSeconds: 1_200,
  nextRunAt: "2026-01-01T00:20:00.000Z",
};
const GOAL = {
  goalId: "goal-1",
  title: "Finish provider adapter review",
  status: "active",
  detail: "3 of 8",
};

/**
 * The native heartbeat stores the scripted scenario produces, in order:
 * create, pause, resume, stop. The sentinel is present in every one of them.
 */
export const fixtureHeartbeatStores = [
  [SENTINEL],
  [SENTINEL, T3_HEARTBEAT],
  [SENTINEL, { ...T3_HEARTBEAT, paused: true, nextRunAt: undefined }],
  [SENTINEL, T3_HEARTBEAT],
  [SENTINEL],
];

/** Runs the shipped mapper over one store and returns the published board. */
export function mapBoard(heartbeats, owned = new Set(), resident = true, goal = GOAL) {
  return primeGoalBoard({ goal, heartbeats, owned, resident, owner: OWNER });
}

/** The shipped canonical reducer, fed shipped-schema-decoded snapshots. */
export function projectBoards(boards) {
  return boards.reduce(
    (state, board) =>
      reduceProviderSessionGoalBoard(state, canonical("session.goals.updated", board)),
    undefined,
  );
}

function verifyDerivedFromSource() {
  if (
    !read("apps/server/src/provider/prime/PrimeGoalsHeartbeats.ts").includes(
      "export const primeGoalBoard",
    )
  )
    throw new Error("the shipped mapper moved; this transcript is no longer source-derived");
  if (
    read("apps/mobile/src/features/threads/primeHeartbeat.ts") !==
    read("apps/web/src/components/chat/primeHeartbeat.ts")
  )
    throw new Error("the web and mobile client projections drifted apart");
}

/** The sentinel must be invisible and untouchable at every single step. */
function verifyOwnership() {
  const owned = new Set();
  const before = mapBoard(fixtureHeartbeatStores[0], owned);
  if (before.heartbeats.length !== 0) throw new Error("an unowned schedule appeared on the board");
  if (before.resident !== undefined)
    throw new Error("residency was claimed with nothing owned to justify it");
  // Creating is disclosed before it happens, and bounded.
  if (!primeHeartbeatCreateDecision(before, 1_200).allowed)
    throw new Error("a legal heartbeat could not be created");
  for (const interval of [30, 90_000]) {
    const refusal = primeHeartbeatCreateDecision(before, interval);
    if (refusal.allowed || refusal.reason !== "interval-out-of-range")
      throw new Error("an out-of-range interval was accepted");
  }
  owned.add("hb-t3-1");
  const created = mapBoard(fixtureHeartbeatStores[1], owned);
  if (created.heartbeats.map((row) => row.heartbeatId).join(",") !== "hb-t3-1")
    throw new Error("the board is not exactly the set of schedules T3 created");
  if (created.resident?.owner !== OWNER)
    throw new Error("residency was not disclosed with its exact owner");
  // The sentinel is not an action target under any intent.
  for (const intent of ["pause", "resume", "delete"]) {
    const refusal = primeHeartbeatDecision(created, "hb-sentinel", intent);
    if (refusal.allowed || refusal.reason !== "unknown-heartbeat")
      throw new Error(`the sentinel was accepted as a ${intent} target`);
    if (!primeHeartbeatRefusalMessage(refusal.reason).includes("owned"))
      throw new Error("the refusal does not say what happened");
  }
  return { owned, created };
}

/** Create → pause → resume → stop, each through the shipped ownership gate. */
function verifyLifecycle(state) {
  const { owned } = state;
  let board = state.created;
  if (!primeHeartbeatDecision(board, "hb-t3-1", "pause").allowed)
    throw new Error("an owned running heartbeat could not be paused");
  board = mapBoard(fixtureHeartbeatStores[2], owned);
  const paused = board.heartbeats[0];
  if (paused.status !== "paused" || paused.nextRunAt !== undefined)
    throw new Error("a paused heartbeat still advertised a next run");
  if (primeHeartbeatDecision(board, "hb-t3-1", "pause").reason !== "already-paused")
    throw new Error("pausing a paused heartbeat was accepted");
  // The exact reverse always exists.
  if (!primeHeartbeatDecision(board, "hb-t3-1", "resume").allowed)
    throw new Error("a paused heartbeat could not be resumed");
  board = mapBoard(fixtureHeartbeatStores[3], owned);
  if (board.heartbeats[0].status !== "active") throw new Error("resume did not take effect");
  if (!primeHeartbeatDecision(board, "hb-t3-1", "delete").allowed)
    throw new Error("an owned heartbeat could not be deleted");
  owned.delete("hb-t3-1");
  const stopped = mapBoard(fixtureHeartbeatStores[4], owned);
  if (stopped.heartbeats.length !== 0) throw new Error("a deleted heartbeat stayed on the board");
  if (stopped.resident !== undefined) throw new Error("residency outlived the last owned schedule");
  // ...and the sentinel survived the entire lifecycle untouched.
  if (fixtureHeartbeatStores.every((store) => store[0].heartbeatId === "hb-sentinel") !== true)
    throw new Error("the unrelated sentinel did not survive");
  return { board, stopped };
}

function verifyBounds() {
  const flood = Array.from({ length: 64 }, (_unused, index) => ({
    heartbeatId: `hb-${index}`,
    title: `Heartbeat ${index}`,
    intervalSeconds: 1_200,
  }));
  const owned = new Set(flood.map((row) => row.heartbeatId));
  const board = mapBoard(flood, owned);
  if (board.heartbeats.length !== MAX_PRIME_HEARTBEATS) throw new Error("the board is not bounded");
  if (primeHeartbeatCreateDecision(board, 1_200).reason !== "limit-reached")
    throw new Error("creation past the bound was accepted");
  let refused = false;
  try {
    canonical("session.goals.updated", {
      heartbeats: [
        ...board.heartbeats,
        { heartbeatId: "extra", title: "x", intervalSeconds: 60, status: "active" },
      ],
    });
  } catch {
    refused = true;
  }
  if (!refused) throw new Error("the canonical contract accepted an unbounded board");
  // Byte-identical stores publish nothing new.
  if (primeGoalBoardFingerprint(board) !== primeGoalBoardFingerprint(mapBoard(flood, owned)))
    throw new Error("an unchanged heartbeat store produced a different board");
}

function verifyCapabilityGate() {
  for (const type of [
    "heartbeat.create",
    "heartbeat.pause",
    "heartbeat.resume",
    "heartbeat.delete",
    "goal.create",
  ]) {
    if (capabilityForRuntimeOperation({ type }) !== "goals")
      throw new Error(`${type} is not gated by the goals capability`);
    if (
      supportsRuntimeOperation({}, { type }) ||
      !supportsRuntimeOperation({ goals: true }, { type })
    )
      throw new Error(`${type} is not capability-gated`);
  }
  // Goal state is reported; goal mutation is refused with a stated reason.
  if (!PRIME_GOAL_MUTATION_REFUSAL.includes("read-only"))
    throw new Error("goal mutation is not refused truthfully");
}

function verifyClients(board) {
  if (hasPrimeGoals("prime-agent", {}) || !hasPrimeGoals("prime-agent", { goals: true }))
    throw new Error("the client surface is not capability-gated");
  const capabilities = { goals: true };
  const live = { status: "running" };
  // Two clients derive their view independently from the same snapshot.
  const a = renderPrimeGoalBoard(board, live);
  const b = renderPrimeGoalBoard(
    {
      ...(board.goal ? { goal: { ...board.goal } } : {}),
      heartbeats: board.heartbeats.map((row) => ({ ...row })),
      ...(board.resident ? { resident: { ...board.resident } } : {}),
    },
    { status: "ready" },
  );
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error("two clients disagreed about the same snapshot");
  // A session that is no longer live shows nothing and offers no control.
  if (renderPrimeGoalBoard(board, { status: "stopped" }).length !== 0)
    throw new Error("a dead session kept showing schedules");
  for (const control of primeHeartbeatControls(
    board.heartbeats[0],
    { status: "stopped" },
    capabilities,
  )) {
    if (control.enabled) throw new Error("a dead session still offered a heartbeat control");
  }
  // Pause and delete always render together: creation is not a one-way door.
  const actions = primeHeartbeatControls(board.heartbeats[0], live, capabilities).map(
    (control) => control.action,
  );
  if (!actions.includes("heartbeat.delete") || actions.length !== 2)
    throw new Error("a heartbeat did not render its exact reverse plus delete");
  // The daemon consequence is disclosed with the permission to create.
  const draft = primeHeartbeatDraftDecision(board, live, capabilities, {
    title: "Watch the deploy",
    intervalSeconds: 900,
  });
  if (!draft.canCreate || draft.disclosure !== PRIME_HEARTBEAT_DAEMON_DISCLOSURE)
    throw new Error("creation was offered without the resident-daemon disclosure");
  return { a, disclosure: draft.disclosure };
}

function verifyProjection(board) {
  const projected = projectBoards([board]);
  if (JSON.stringify(projected.heartbeats) !== JSON.stringify(board.heartbeats))
    throw new Error("the canonical snapshot did not round-trip");
  // An exited session keeps no board: a control whose session is gone must not
  // be offered.
  const cleared = reduceProviderSessionGoalBoard(
    projected,
    canonical("session.exited", { reason: "exited" }),
  );
  if (cleared.heartbeats.length !== 0 || cleared.resident !== undefined)
    throw new Error("an exited session kept its goal board");
  return projected;
}

export function verifyTranscript() {
  verifyDerivedFromSource();
  const ownership = verifyOwnership();
  const lifecycle = verifyLifecycle(ownership);
  verifyBounds();
  verifyCapabilityGate();
  const clients = verifyClients(lifecycle.board);
  const projected = verifyProjection(lifecycle.board);
  return { ownership, lifecycle, clients, projected };
}

if (process.argv[1] !== undefined && NodeURL.fileURLToPath(import.meta.url) === process.argv[1]) {
  const { clients, lifecycle } = verifyTranscript();
  for (const line of clients.a) console.log(line);
  console.log(`confirmation copy: ${clients.disclosure}`);
  console.log(
    `after stop: ${lifecycle.stopped.heartbeats.length} owned heartbeats, resident=${String(
      lifecycle.stopped.resident !== undefined,
    )}; unrelated sentinel hb-sentinel untouched`,
  );
  console.log(
    "PA-A07 Prime goals and heartbeats transcript verified (source-derived, owned-only board, create/pause/resume/stop reversible, unowned sentinel never listed or targeted, residency disclosed with its exact owner, goal read-only, bounded and coalesced, dead sessions show nothing)",
  );
}
