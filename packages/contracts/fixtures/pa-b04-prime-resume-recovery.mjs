import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Source-derived PA-B04 resume and recovery transcript.
 *
 * Every state below is the *shipped* one: the wire contract's closed reason set
 * (`packages/contracts/src/primeResume.ts`), the host's fresh-start rule, and
 * the single client surface every client renders
 * (`packages/client-runtime/src/primeResume.ts`) are imported and executed
 * rather than mirrored, so a regression in any of them fails this transcript.
 *
 * No live Prime Agent, no live session, no host paths, no client launch.
 *
 * Run: `node packages/contracts/fixtures/pa-b04-prime-resume-recovery.mjs`
 */
const ROOT = new URL("../../../", import.meta.url);
const read = (relative) => NodeFS.readFileSync(new URL(relative, ROOT), "utf8");
const load = (relative) => import(new URL(relative, ROOT).href);

const { PRIME_RESUME_FAILURE_REASONS, primeResumeAllowsFreshStart } = await load(
  "packages/contracts/src/primeResume.ts",
);
const {
  initialPrimeResumeModel,
  primeResumeAwaitingChoice,
  primeResumeBlocksComposer,
  primeResumeIntentFor,
  primeResumeReduce,
  primeResumeSurface,
  renderPrimeResume,
} = await load("packages/client-runtime/src/primeResume.ts");

const lines = [];
const say = (line) => {
  lines.push(line);
  console.log(line);
};
let checks = 0;
const check = (label, run) => {
  run();
  checks += 1;
  say(`  ok  ${label}`);
};
/** Same contract as `check`, for the checks that touch a real host on disk. */
const checkAsync = async (label, run) => {
  await run();
  checks += 1;
  say(`  ok  ${label}`);
};

const model = (state) => ({ ...initialPrimeResumeModel, state });

say("PA-B04 — Prime Agent resume and recovery, as every client sees it");
say("");
say("1. Published resume states");
for (const state of [
  { status: "reconnecting" },
  { status: "resumed", mode: "adopted" },
  { status: "resumed", mode: "relaunched" },
]) {
  const surface = primeResumeSurface("prime-agent", model(state));
  say(
    `  ${JSON.stringify(state)} -> ${surface.kind} (composer blocked: ${surface.composerBlocked})`,
  );
  say(`      ${surface.title}`);
}

say("");
say("2. Every refusal the wire can carry");
for (const reason of PRIME_RESUME_FAILURE_REASONS) {
  const surface = primeResumeSurface("prime-agent", model({ status: "unavailable", reason }));
  const choices = surface.choices.map((choice) => choice.kind).join(", ") || "—";
  say(
    `  ${reason.padEnd(20)} -> ${surface.kind.padEnd(13)} blocked: ${String(
      surface.composerBlocked,
    ).padEnd(5)} choices: ${choices}`,
  );
}

say("");
say("3. Assertions");

check("a thread with no published state, or another provider, shows nothing", () => {
  NodeAssert.equal(primeResumeSurface("prime-agent", initialPrimeResumeModel).kind, "hidden");
  NodeAssert.equal(primeResumeSurface("codex", model({ status: "reconnecting" })).kind, "hidden");
  NodeAssert.deepEqual(renderPrimeResume("prime-agent", initialPrimeResumeModel), []);
});

check("no failed resume silently becomes a fresh conversation", () => {
  for (const reason of PRIME_RESUME_FAILURE_REASONS) {
    const blocked = primeResumeBlocksComposer(
      "prime-agent",
      model({ status: "unavailable", reason }),
    );
    // The host's rule and the client's gate are the same rule, checked against
    // each other rather than restated: only "nothing to resume" may send.
    NodeAssert.equal(blocked, !primeResumeAllowsFreshStart(reason), reason);
  }
});

check("every blocked refusal offers at least one way out", () => {
  for (const reason of PRIME_RESUME_FAILURE_REASONS) {
    const surface = primeResumeSurface("prime-agent", model({ status: "unavailable", reason }));
    if (!surface.composerBlocked) continue;
    NodeAssert.ok(surface.choices.length > 0, reason);
  }
});

check("a capability mismatch is recoverable and discards the refusing cursor", () => {
  const surface = primeResumeSurface(
    "prime-agent",
    model({ status: "unavailable", reason: "capabilityMismatch" }),
  );
  NodeAssert.equal(surface.kind, "forkRequired");
  NodeAssert.deepEqual(primeResumeIntentFor(surface, "fork"), { kind: "fork" });
  NodeAssert.deepEqual(primeResumeIntentFor(surface, "fresh"), {
    kind: "fresh",
    discardCursor: true,
  });
});

check("a two-device conflict names no device, no path and no owner", () => {
  for (const reason of ["conflict", "unauthorized"]) {
    const surface = primeResumeSurface("prime-agent", model({ status: "unavailable", reason }));
    NodeAssert.equal(surface.kind, "conflict");
    NodeAssert.deepEqual(
      surface.choices.map((choice) => choice.kind),
      // Fork is the escape hatch for a writer that never finishes; a fresh
      // start stays refused while someone else is authoritative.
      ["retry", "fork"],
    );
    NodeAssert.equal(primeResumeIntentFor(surface, "fresh"), undefined);
    const text = `${surface.title} ${surface.detail}`.toLowerCase();
    for (const leak of ["/", "pid", "device", "host", "session id"])
      NodeAssert.ok(!text.includes(leak), `${reason} leaked ${leak}`);
  }
});

check("a reconnect that never lands becomes actionable instead of spinning", () => {
  const stalled = primeResumeReduce(
    primeResumeReduce(initialPrimeResumeModel, {
      type: "state",
      state: { status: "reconnecting" },
    }),
    { type: "sessionStatus", status: "error" },
  );
  const surface = primeResumeSurface("prime-agent", stalled);
  NodeAssert.equal(surface.kind, "stalled");
  // The "Start a new session" button has to be one: a stalled reconnect that
  // silently retried would hit the same cursor and stall again.
  NodeAssert.deepEqual(primeResumeIntentFor(surface, "fresh"), {
    kind: "fresh",
    discardCursor: true,
  });
});

check("a retry that lands on the same refusal is still an answer", () => {
  // The host announces a user-requested attempt with `reconnecting` before it
  // revalidates, so an identical refusal still arrives as a transition. Without
  // that the banner would spin forever with every button disabled.
  const settled = [
    { type: "state", state: { status: "unavailable", reason: "corrupt" } },
    { type: "choice", intent: { kind: "retry" } },
    { type: "state", state: { status: "reconnecting" } },
    { type: "state", state: { status: "unavailable", reason: "corrupt" } },
  ].reduce(primeResumeReduce, initialPrimeResumeModel);
  NodeAssert.equal(primeResumeAwaitingChoice(settled), false);
  NodeAssert.deepEqual(
    primeResumeSurface("prime-agent", settled).choices.map((choice) => choice.kind),
    ["retry", "fork", "fresh"],
  );
});

check("a confirmed fresh start ends the block instead of leaving the refusal", () => {
  const settled = [
    { type: "state", state: { status: "unavailable", reason: "capabilityMismatch" } },
    { type: "choice", intent: { kind: "fresh", discardCursor: true } },
    { type: "state", state: { status: "reconnecting" } },
    // The cursor the user agreed to leave behind is gone, so the truthful
    // terminal state is "there is no durable session", not the old refusal.
    { type: "state", state: { status: "unavailable", reason: "missing" } },
  ].reduce(primeResumeReduce, initialPrimeResumeModel);
  NodeAssert.equal(primeResumeSurface("prime-agent", settled).kind, "missing");
  NodeAssert.equal(primeResumeBlocksComposer("prime-agent", settled), false);
  NodeAssert.equal(primeResumeAwaitingChoice(settled), false);
});

check("one fork click cannot become two, and settling brings the buttons back", () => {
  const forked = [
    { type: "state", state: { status: "unavailable", reason: "conflict" } },
    { type: "choice", intent: { kind: "fork" } },
  ].reduce(primeResumeReduce, initialPrimeResumeModel);
  // In flight: every button is inert, so a double click dispatches nothing.
  NodeAssert.equal(primeResumeAwaitingChoice(forked), true);
  // The fork command settles (it answers with a new thread, not a resume state
  // for this one), and the caller reports that so recovery stays reachable.
  const settledAgain = primeResumeReduce(forked, { type: "settled" });
  NodeAssert.equal(primeResumeAwaitingChoice(settledAgain), false);
  NodeAssert.equal(primeResumeSurface("prime-agent", settledAgain).kind, "conflict");
});

check("a retry keeps the composer shut until the host answers", () => {
  const refused = primeResumeReduce(initialPrimeResumeModel, {
    type: "state",
    state: { status: "unavailable", reason: "corrupt" },
  });
  const retrying = primeResumeReduce(refused, { type: "choice", intent: { kind: "retry" } });
  NodeAssert.equal(primeResumeBlocksComposer("prime-agent", retrying), true);
  const answered = primeResumeReduce(retrying, {
    type: "state",
    state: { status: "resumed", mode: "relaunched" },
  });
  NodeAssert.equal(primeResumeBlocksComposer("prime-agent", answered), false);
});

check("two clients that saw different histories converge on the published state", () => {
  // Client A watched the whole reconnect; client B attached late and has only
  // the last published state. Each model is built independently — no shared
  // array — so agreement is a real convergence result, not a tautology.
  const clientA = [
    { type: "state", state: { status: "reconnecting" } },
    { type: "sessionStatus", status: "starting" },
    { type: "choice", intent: { kind: "retry" } },
    { type: "state", state: { status: "unavailable", reason: "storageMismatch" } },
  ].reduce(primeResumeReduce, initialPrimeResumeModel);
  const clientB = primeResumeReduce(initialPrimeResumeModel, {
    type: "state",
    state: { status: "unavailable", reason: "storageMismatch" },
  });
  NodeAssert.deepEqual(
    renderPrimeResume("prime-agent", clientA),
    renderPrimeResume("prime-agent", clientB),
  );
  NodeAssert.deepEqual(clientA.state, clientB.state);
});

check("a dropped client connection never keeps claiming a live resume", () => {
  const resumed = primeResumeReduce(initialPrimeResumeModel, {
    type: "state",
    state: { status: "resumed", mode: "adopted" },
  });
  const dropped = primeResumeReduce(resumed, { type: "disconnected" });
  NodeAssert.equal(primeResumeSurface("prime-agent", dropped).kind, "reconnecting");
});

check("stop and archive copy stays non-destructive", () => {
  const source = read("packages/client-runtime/src/primeResume.ts");
  for (const promise of ["can be resumed", "Nothing is deleted", "nothing on disk is deleted"])
    NodeAssert.ok(source.includes(promise), promise);
  NodeAssert.ok(!/delete the session|erase|wipe/i.test(source));
});

check("both clients render the shared surface rather than local copy", () => {
  for (const path of [
    "apps/web/src/components/chat/PrimeResumeBanner.tsx",
    "apps/mobile/src/features/threads/PrimeResumeBanner.tsx",
  ]) {
    const source = read(path);
    NodeAssert.ok(source.includes('from "@t3tools/client-runtime/prime-resume"'), path);
    NodeAssert.ok(source.includes("primeResumeSurface(props.providerName, props.model)"), path);
  }
});

// The round-one review's blockers, as executable facts: the state has a wire,
// the choice has a command, the composer has a gate, and the cursor has a
// deletion. Each is read from the shipped source rather than described.
check("the resume state has a transport clients actually receive", () => {
  const runtime = read("packages/contracts/src/providerRuntime.ts");
  NodeAssert.ok(runtime.includes('"session.resume.updated"'), "canonical runtime event");
  NodeAssert.ok(runtime.includes("ProviderRuntimeSessionResumeUpdatedEvent"), "event in the union");
  NodeAssert.ok(
    read("packages/contracts/src/orchestration.ts").includes(
      "resumeState: Schema.optional(PrimeResumeState)",
    ),
    "the session read model every client renders carries it",
  );
  NodeAssert.ok(
    read("apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts").includes(
      'event.type === "session.resume.updated"',
    ),
    "ingestion projects it onto the thread session",
  );
  NodeAssert.ok(
    read("apps/server/src/provider/Layers/PrimeAdapter.ts").includes("publishResumeState"),
    "the adapter publishes it without needing an optional caller",
  );
  NodeAssert.ok(
    read("apps/server/src/provider/Layers/PrimeAdapter.ts").includes(
      "resumePublishes = resumePublishes.then(",
    ),
    "and publishes them in order, so a settled thread never reads as spinning",
  );
});

check("every recovery choice reaches a host that can act on it", () => {
  NodeAssert.ok(
    read("packages/contracts/src/orchestration.ts").includes('"thread.prime-resume.recover"'),
    "recover command exists on the wire",
  );
  NodeAssert.ok(
    read("apps/server/src/orchestration/Layers/ProviderCommandReactor.ts").includes(
      "processPrimeResumeRecoverRequested",
    ),
    "a reactor handles it",
  );
  NodeAssert.ok(
    read("apps/server/src/provider/prime/PrimeResumeCursor.ts").includes(
      "export const discardPrimeResumeCursor",
    ),
    "a confirmed fresh start can delete the cursor that keeps refusing",
  );
  NodeAssert.ok(
    read("apps/server/src/provider/Layers/PrimeAdapter.ts").includes(
      "announce: input.resumeRecovery !== undefined",
    ),
    "a start the user asked for announces itself, so its outcome is published",
  );
});

check("both clients mount the banner and gate their own send path", () => {
  const web = read("apps/web/src/components/ChatView.tsx");
  NodeAssert.ok(web.includes("<PrimeResumeBanner"), "web mounts the banner");
  NodeAssert.ok(web.includes("resolveSendDisabledReason({"), "web gates the composer");
  const mobile = read("apps/mobile/src/features/threads/ThreadDetailScreen.tsx");
  NodeAssert.ok(mobile.includes("<PrimeResumeBanner"), "mobile mounts the banner");
  NodeAssert.ok(
    mobile.includes("if (primeResumeComposerBlocked) return null;"),
    "mobile gates its send funnel",
  );
});

// Round-two review's blockers, answered behaviourally rather than by grep: the
// real host coordinator runs against a throwaway T3 home, and the states it
// publishes are fed through the real client reducer. Nothing about the recovery
// path is described here; it is executed.
const { makePrimeResumeCoordinator, primeCapabilityDigest } = await load(
  "apps/server/src/provider/prime/PrimeResumeCoordinator.ts",
);
const { makePrimeResumeCursor, primeSessionPathToken, writePrimeResumeCursor } = await load(
  "apps/server/src/provider/prime/PrimeResumeCursor.ts",
);
const { primeHomeFingerprint, primeResourceLayout } = await load(
  "apps/server/src/provider/prime/PrimeResourceLayout.ts",
);

const CAPABILITIES = primeCapabilityDigest({ runtimeExtensions: { steer: true } });
const THREAD = "thread-a";

/** A real coordinator over a disposable home. Returns what it published. */
const hostFor = async (over = {}) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pa-b04-"));
  const layout = primeResourceLayout({
    home: root,
    environmentId: "env-a",
    instanceId: "prime",
    threadId: THREAD,
  });
  NodeFS.mkdirSync(layout.session, { recursive: true });
  const scope = {
    environmentId: "env-a",
    providerInstanceId: "prime",
    projectId: "project-a",
    threadId: THREAD,
    homeFingerprint: primeHomeFingerprint(root),
  };
  await writePrimeResumeCursor(
    layout.resumeCursor,
    makePrimeResumeCursor({
      scope,
      sessionPathToken: primeSessionPathToken(root, layout.session),
      ownershipGeneration: 1,
      compatibility: { agentVersion: "0.7.2", band: "compatible" },
      capabilityDigest: CAPABILITIES,
      recordedAt: "2026-08-16T00:00:00.000Z",
    }),
  );
  const published = [];
  const coordinator = makePrimeResumeCoordinator({
    scopeForThread: async () => scope,
    cursorPath: () => layout.resumeCursor,
    sessionPathToken: () => primeSessionPathToken(root, layout.session),
    sessionStorageExists: async () => true,
    ownershipGeneration: async () => 1,
    agentVersion: async () => "0.7.3",
    capabilityDigest: () => CAPABILITIES,
    liveSession: () => undefined,
    acquireLease: async () => {},
    releaseLease: async () => {},
    publish: (_threadId, state) => published.push(state),
    ...over,
  });
  return {
    coordinator,
    published,
    cursorPath: layout.resumeCursor,
    cleanup: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
};

/** Replays host states through the shared client model, as a client would. */
const clientAfter = (states, choice) =>
  states.reduce(
    (acc, state) => primeResumeReduce(acc, { type: "state", state }),
    primeResumeReduce(initialPrimeResumeModel, { type: "choice", intent: choice }),
  );

await checkAsync("a user-pressed retry is answered even when nothing changed", async () => {
  const host = await hostFor();
  NodeFS.writeFileSync(host.cursorPath, "{not json");
  const first = await host.coordinator.resume(THREAD);
  NodeAssert.deepEqual(first.plan, { kind: "unavailable", reason: "corrupt" });
  host.published.length = 0;
  host.coordinator.forget(THREAD);
  const retried = await host.coordinator.resume(THREAD, { announce: true });
  NodeAssert.deepEqual(retried.plan, { kind: "unavailable", reason: "corrupt" });
  NodeAssert.deepEqual(host.published, [
    { status: "reconnecting" },
    { status: "unavailable", reason: "corrupt" },
  ]);
  const client = clientAfter(host.published, { kind: "retry" });
  NodeAssert.equal(primeResumeAwaitingChoice(client), false);
  NodeAssert.deepEqual(
    primeResumeSurface("prime-agent", client).choices.map((choice) => choice.kind),
    ["retry", "fork", "fresh"],
  );
  host.cleanup();
});

await checkAsync("a confirmed fresh start is not a silent, permanent block", async () => {
  const host = await hostFor({
    // The capability set moved on since the cursor was written: the
    // capabilityMismatch brick whose only way out is a confirmed fresh start.
    capabilityDigest: () => primeCapabilityDigest({ runtimeExtensions: { steer: false } }),
  });
  const refused = await host.coordinator.resume(THREAD);
  NodeAssert.deepEqual(refused.plan, { kind: "unavailable", reason: "capabilityMismatch" });
  host.published.length = 0;
  NodeAssert.equal(await host.coordinator.discardCursor(THREAD), true);
  const afterFresh = await host.coordinator.resume(THREAD, { announce: true });
  NodeAssert.deepEqual(afterFresh.plan, { kind: "fresh" });
  NodeAssert.deepEqual(host.published, [
    { status: "reconnecting" },
    { status: "unavailable", reason: "missing" },
  ]);
  const client = clientAfter(host.published, { kind: "fresh", discardCursor: true });
  NodeAssert.equal(primeResumeSurface("prime-agent", client).kind, "missing");
  NodeAssert.equal(primeResumeBlocksComposer("prime-agent", client), false);
  host.cleanup();
});

await checkAsync("an ordinary first turn still publishes no recovery state", async () => {
  const host = await hostFor();
  NodeFS.rmSync(host.cursorPath, { force: true });
  NodeAssert.deepEqual((await host.coordinator.resume(THREAD)).plan, { kind: "fresh" });
  NodeAssert.deepEqual(host.published, []);
  host.cleanup();
});

say("");
say(`${checks} assertions passed across ${PRIME_RESUME_FAILURE_REASONS.length} refusal reasons.`);
