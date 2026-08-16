import { fileURLToPath } from "node:url";

/** Source-derived Prime 0.7.2 action snapshot convergence fixture.
 * `steer` and `follow_up` return only success acknowledgements. A snapshot has
 * text lanes/count/active state, never action IDs, so clients replace state.
 */
export const NATIVE_COMMANDS = Object.freeze({
  steer: Object.freeze({ type: "steer", message: "steer now" }),
  followUp: Object.freeze({ type: "follow_up", message: "queue next" }),
});

/** One authoritative broadcast, delivered to every attached client. */
export const SERVER_BROADCAST = Object.freeze([
  Object.freeze({
    queuedCount: 1,
    steering: Object.freeze(["steer now"]),
    followUps: Object.freeze([]),
  }),
  Object.freeze({
    queuedCount: 2,
    steering: Object.freeze(["steer now"]),
    followUps: Object.freeze(["queue next"]),
    active: Object.freeze({ kind: "turn", phase: "running", label: "steer now" }),
  }),
  Object.freeze({ queuedCount: 0, steering: Object.freeze([]), followUps: Object.freeze([]) }),
]);

/** Replacement semantics: the newest snapshot is the whole visible state. */
export const replaceReducer = (_previous, snapshot) => ({
  queuedCount: snapshot.queuedCount,
  steering: [...snapshot.steering],
  followUps: [...snapshot.followUps],
  ...(snapshot.active ? { active: { ...snapshot.active } } : {}),
});

/** A client that wrongly accumulates lanes instead of replacing them. */
export const appendReducer = (previous, snapshot) => ({
  queuedCount: snapshot.queuedCount,
  steering: [...(previous?.steering ?? []), ...snapshot.steering],
  followUps: [...(previous?.followUps ?? []), ...snapshot.followUps],
  ...(snapshot.active ? { active: { ...snapshot.active } } : {}),
});

/** Each client derives its own projection from the shared broadcast. */
export function projectClient(reducer, broadcast = SERVER_BROADCAST) {
  let state;
  const history = [];
  for (const snapshot of broadcast) {
    state = reducer(state, snapshot);
    history.push(state);
  }
  return history;
}

/**
 * Convergence is asserted between two independently derived projections, so a
 * client whose reducer diverges makes this check fail (see `verifyFalsifiable`).
 */
export function verifyConvergence(
  clientAReducer = replaceReducer,
  clientBReducer = replaceReducer,
) {
  const a = projectClient(clientAReducer);
  const b = projectClient(clientBReducer);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("attached clients diverged");
  if (a.some((state) => "actionId" in state || "steerId" in state || "followUpId" in state))
    throw new Error("invented action id");
  const last = a[a.length - 1];
  if (last.queuedCount !== 0 || last.steering.length !== 0 || last.followUps.length !== 0)
    throw new Error("terminal snapshot did not clear the queue");
  return true;
}

/** The convergence check must be able to fail; prove it on every run. */
export function verifyFalsifiable() {
  try {
    verifyConvergence(replaceReducer, appendReducer);
  } catch (error) {
    if (error instanceof Error && error.message === "attached clients diverged") return true;
    throw error;
  }
  throw new Error("convergence check is not falsifiable");
}

export function verifyTranscript() {
  verifyConvergence();
  verifyFalsifiable();
  if (NATIVE_COMMANDS.steer.type !== "steer" || NATIVE_COMMANDS.followUp.type !== "follow_up")
    throw new Error("native command shape changed");
  return true;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  verifyTranscript();
  console.log("PA-A02 Prime runtime transcript verified (convergence proven falsifiable)");
}
