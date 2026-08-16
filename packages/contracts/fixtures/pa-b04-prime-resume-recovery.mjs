import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";

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
      ["retry"],
    );
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
  NodeAssert.deepEqual(primeResumeIntentFor(surface, "fresh"), {
    kind: "fresh",
    discardCursor: false,
  });
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

say("");
say(`${checks} assertions passed across ${PRIME_RESUME_FAILURE_REASONS.length} refusal reasons.`);
