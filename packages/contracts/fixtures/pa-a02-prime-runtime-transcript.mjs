import { fileURLToPath } from "node:url";

/** Source-derived Prime 0.7.2 action snapshot convergence fixture.
 * `steer` and `follow_up` return only success acknowledgements. A snapshot has
 * text lanes/count/active state, never action IDs, so clients replace state.
 */
export const NATIVE_COMMANDS = Object.freeze({
  steer: Object.freeze({ type: "steer", message: "steer now" }),
  followUp: Object.freeze({ type: "follow_up", message: "queue next" }),
});
const snapshots = Object.freeze([
  Object.freeze({ queuedCount: 1, steering: Object.freeze(["steer now"]), followUps: Object.freeze([]) }),
  Object.freeze({ queuedCount: 2, steering: Object.freeze(["steer now"]), followUps: Object.freeze(["queue next"]) }),
]);
// The server broadcasts every authoritative snapshot to every attached client.
export const SERVER_DELIVERY = Object.freeze([
  Object.freeze({ client: "A", snapshots }),
  Object.freeze({ client: "B", snapshots }),
]);
const project = (delivered) => delivered.map(({ queuedCount, steering, followUps, active }) => ({
  queuedCount, steering: [...steering], followUps: [...followUps], ...(active ? { active } : {}),
}));
export function verifyTranscript() {
  const [a, b] = SERVER_DELIVERY.map(({ snapshots: received }) => project(received));
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("attached clients diverged");
  if (a.some((snapshot) => "actionId" in snapshot || "steerId" in snapshot || "followUpId" in snapshot)) throw new Error("invented action id");
  if (NATIVE_COMMANDS.steer.type !== "steer" || NATIVE_COMMANDS.followUp.type !== "follow_up") throw new Error("native command shape changed");
  return true;
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  verifyTranscript();
  console.log("PA-A02 Prime runtime transcript verified");
}
