import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

/**
 * Source-derived PA-A03 context/compaction/retry transcript.
 *
 * Prime 0.7.2 reports compaction and retry as bounded status snapshots; there
 * are no compaction IDs on the wire, so replacing the snapshot is the only safe
 * reconciliation. Compaction is the runtime's context management and is never a
 * T3 checkpoint: this fixture asserts that no revert vocabulary can leak into
 * the projected state.
 */
const ROOT = new URL("../../../", import.meta.url);
const read = (relative) => NodeFS.readFileSync(new URL(relative, ROOT), "utf8");

/** Golden native transcript: automatic success, manual failure + retry, manual abort. */
export const NATIVE_TRANSCRIPT = Object.freeze([
  Object.freeze({ type: "compaction_update", phase: "started", trigger: "automatic" }),
  Object.freeze({
    type: "compaction_update",
    phase: "completed",
    trigger: "automatic",
    usedTokens: 4200,
    maxTokens: 200000,
  }),
  // Byte-identical repeat: a bounded projection must not publish it twice.
  Object.freeze({
    type: "compaction_update",
    phase: "completed",
    trigger: "automatic",
    usedTokens: 4200,
    maxTokens: 200000,
  }),
  Object.freeze({ type: "compaction_update", phase: "started", trigger: "manual" }),
  Object.freeze({
    type: "compaction_update",
    phase: "failed",
    trigger: "manual",
    reason: "provider busy",
  }),
  Object.freeze({ type: "retry_update", attempt: 1, maxAttempts: 3 }),
  Object.freeze({ type: "compaction_update", phase: "started", trigger: "manual" }),
  Object.freeze({ type: "compaction_update", phase: "cancelled", trigger: "manual" }),
]);

/** Mirrors `COMPACTION_STATUS` in PrimeCompaction.ts; verified against it below. */
export const PHASE_TO_STATUS = Object.freeze({
  started: "running",
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
});

/** Mirrors the `session.context.updated` activity summaries in ProviderRuntimeIngestion.ts. */
export const STATUS_TO_SUMMARY = Object.freeze({
  running: "Compacting context",
  succeeded: "Context compacted",
  failed: "Context compaction failed",
  cancelled: "Context compaction cancelled",
});

/** Snapshot replacement, matching the shipped tracker/reducer semantics. */
export const replaceReducer = (previous, event) => {
  if (event.type === "retry_update")
    return {
      ...previous,
      retry: {
        attempt: event.attempt,
        ...(event.maxAttempts === undefined ? {} : { maxAttempts: event.maxAttempts }),
      },
    };
  const usage =
    event.usedTokens === undefined
      ? previous?.usage
      : {
          usedTokens: event.usedTokens,
          ...(event.maxTokens === undefined ? {} : { maxTokens: event.maxTokens }),
        };
  return {
    compaction: {
      status: PHASE_TO_STATUS[event.phase],
      trigger: event.trigger,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    },
    ...(previous?.retry === undefined ? {} : { retry: previous.retry }),
    ...(usage === undefined ? {} : { usage }),
  };
};

/** A client that wrongly accumulates status history instead of replacing it. */
export const accumulateReducer = (previous, event) => {
  const next = replaceReducer(previous, event);
  return { ...next, history: [...(previous?.history ?? []), event.type] };
};

/** Each client derives its own projection from the shared broadcast. */
export function projectClient(reducer, transcript = NATIVE_TRANSCRIPT) {
  let state;
  const published = [];
  let lastJson;
  for (const event of transcript) {
    state = reducer(state, event);
    const json = JSON.stringify(state);
    // Bounded publication: byte-identical snapshots are dropped, so the status
    // UI is a discrete state list and never a repaint loop.
    if (json === lastJson) continue;
    lastJson = json;
    published.push(state);
  }
  return published;
}

export function verifyConvergence(
  clientAReducer = replaceReducer,
  clientBReducer = replaceReducer,
) {
  const a = projectClient(clientAReducer);
  const b = projectClient(clientBReducer);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("attached clients diverged");
  if (a.length !== NATIVE_TRANSCRIPT.length - 1)
    throw new Error("duplicate snapshot was not coalesced");
  if (/checkpoint|revert|rollback/i.test(JSON.stringify(a)))
    throw new Error("compaction state leaked checkpoint vocabulary");
  if (a.some((state) => "compactionId" in state.compaction))
    throw new Error("invented compaction id");
  const last = a[a.length - 1];
  if (last.compaction.status !== "cancelled") throw new Error("abort was not visible as cancelled");
  return true;
}

/** The convergence check must be able to fail; prove it on every run. */
export function verifyFalsifiable() {
  try {
    verifyConvergence(replaceReducer, accumulateReducer);
  } catch (error) {
    if (error instanceof Error && error.message === "attached clients diverged") return true;
    throw error;
  }
  throw new Error("convergence check is not falsifiable");
}

/** The fixture is only trustworthy while it matches the shipped source. */
export function verifyDerivedFromSource() {
  const tracker = read("apps/server/src/provider/prime/PrimeCompaction.ts");
  for (const [phase, status] of Object.entries(PHASE_TO_STATUS)) {
    if (!new RegExp(`${phase}:\\s*"${status}"`).test(tracker))
      throw new Error(`phase mapping drifted: ${phase}`);
  }
  const ingestion = read("apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts");
  for (const summary of Object.values(STATUS_TO_SUMMARY)) {
    if (!ingestion.includes(`"${summary}"`))
      throw new Error(`activity summary drifted: ${summary}`);
  }
  return true;
}

/**
 * The transcript is only meaningful if a user can actually produce it. Walk the
 * whole chain for both manual operations: client command -> decider event ->
 * reactor operation -> adapter, plus the read-model projection and the two
 * client surfaces that render it.
 */
export function verifyReachable() {
  const link = (file, needles) => {
    const source = read(file);
    for (const needle of needles) {
      if (!source.includes(needle)) throw new Error(`unreachable: ${file} is missing ${needle}`);
    }
  };
  link("packages/contracts/src/orchestration.ts", [
    '"thread.compaction.request"',
    '"thread.usage.refresh"',
    '"thread.compaction-requested"',
    '"thread.usage-refresh-requested"',
    "OrchestrationSessionContextState",
  ]);
  link("packages/client-runtime/src/operations/commands.ts", [
    "requestThreadCompaction",
    "refreshThreadUsage",
  ]);
  link("apps/server/src/orchestration/decider.ts", [
    'case "thread.compaction.request":',
    'case "thread.usage.refresh":',
  ]);
  link("apps/server/src/orchestration/Layers/ProviderCommandReactor.ts", [
    '"compaction.request"',
    '"usage.snapshot.retry"',
  ]);
  link("apps/server/src/provider/Layers/PrimeAdapter.ts", [
    '"compaction.request"',
    '"usage.snapshot.retry"',
  ]);
  link("apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts", [
    "session-context-snapshot",
    "contextState: nextContextState",
  ]);
  link("apps/web/src/components/ChatView.tsx", ["<PrimeContextStatus"]);
  link("apps/mobile/src/features/threads/ThreadComposer.tsx", ["renderPrimeContext"]);
  return true;
}

export function verifyTranscript() {
  verifyReachable();
  verifyDerivedFromSource();
  verifyConvergence();
  verifyFalsifiable();
  return true;
}

if (process.argv[1] !== undefined && NodeURL.fileURLToPath(import.meta.url) === process.argv[1]) {
  verifyTranscript();
  console.log(
    "PA-A03 Prime context transcript verified (reachable end-to-end, source-derived, coalesced, proven falsifiable)",
  );
}
