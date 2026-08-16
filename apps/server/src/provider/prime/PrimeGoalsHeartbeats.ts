import { boundedPrimeNoticeText } from "./PrimeExtensionUi.ts";
import type { PrimeRpcKnownEvent } from "./PrimeRpcProtocol.ts";

/**
 * Goal state and T3-owned heartbeats for Prime 0.7.2.
 *
 * Prime reports the current goal and the heartbeat store as whole snapshots
 * (`goal_update`, `heartbeat_update`) and exposes `heartbeat_create`,
 * `heartbeat_get`, `heartbeat_pause`, `heartbeat_resume`, and `heartbeat_stop`.
 * A heartbeat outlives a single turn, so creating one can promote the session
 * to Prime's resident daemon.
 *
 * Three rules shape everything here:
 *
 * - **Ownership is a list T3 keeps, not a guess.** A heartbeat is visible and
 *   actionable only because *this* environment created it and recorded its
 *   exact id. Everything else the daemon hosts — another T3 thread's schedule,
 *   a schedule a person made in the TUI — is filtered out before any surface
 *   sees it, so there is no global list and no unowned action target.
 * - **Labels, never prompts.** A row carries a bounded title, an interval, and
 *   a state. Goal instructions and heartbeat prompt bodies are content and stay
 *   out of the board, out of logs, and out of analytics.
 * - **Residency is disclosed with its exact owner.** When owned schedules keep
 *   the session resident, the board says so and names the owner, so the reverse
 *   control stops exactly that session and never the whole daemon.
 */
export type PrimeGoalUpdateEvent = Extract<PrimeRpcKnownEvent, { readonly type: "goal_update" }>;
export type PrimeHeartbeatUpdateEvent = Extract<
  PrimeRpcKnownEvent,
  { readonly type: "heartbeat_update" }
>;
export type PrimeNativeGoal = NonNullable<PrimeGoalUpdateEvent["goal"]>;
export type PrimeNativeHeartbeat = PrimeHeartbeatUpdateEvent["heartbeats"][number];

export type PrimeGoalStatus = "active" | "completed" | "cancelled";
export type PrimeHeartbeatStatus = "active" | "paused";

export type PrimeGoal = {
  readonly goalId: string;
  readonly title: string;
  readonly status: PrimeGoalStatus;
  readonly detail?: string;
};
export type PrimeHeartbeat = {
  readonly heartbeatId: string;
  readonly title: string;
  readonly intervalSeconds: number;
  readonly status: PrimeHeartbeatStatus;
  readonly nextRunAt?: string;
};
export type PrimeGoalBoard = {
  readonly goal?: PrimeGoal;
  readonly heartbeats: ReadonlyArray<PrimeHeartbeat>;
  readonly resident?: { readonly owner: string };
};

/** The canonical contract caps the board at eight owned rows with clamped text. */
export const MAX_PRIME_HEARTBEATS = 8;
export const MAX_PRIME_GOAL_ID = 128;
export const MAX_PRIME_GOAL_TITLE = 120;
export const MAX_PRIME_GOAL_DETAIL = 256;
/**
 * A heartbeat runs unattended, so the interval is bounded on both sides: below
 * a minute it is a busy loop that keeps a daemon permanently hot, and beyond a
 * day it is a schedule, which this milestone deliberately does not offer.
 */
export const MIN_PRIME_HEARTBEAT_INTERVAL_SECONDS = 60;
export const MAX_PRIME_HEARTBEAT_INTERVAL_SECONDS = 86_400;

export const EMPTY_PRIME_GOAL_BOARD: PrimeGoalBoard = Object.freeze({
  heartbeats: Object.freeze([]),
});

/**
 * Ids T3 cannot reproduce exactly are dropped rather than renamed. The wire
 * contract brands these ids (`RuntimeExtensionId`: leading letter, then
 * letters/digits/_/-), so an id outside that shape can never be listed or
 * targeted through the contract — admitting it here would only make the
 * publish step throw inside the event pump.
 */
const CONTRACT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const exactId = (value: string): string | undefined => {
  const bounded = boundedPrimeNoticeText(value, MAX_PRIME_GOAL_ID);
  return bounded && bounded === value && CONTRACT_ID.test(bounded) ? bounded : undefined;
};

/**
 * The canonical contract carries an exact UTC instant. A native timestamp is
 * passed through only when it already is one: re-encoding a loose value would
 * silently invent precision or a timezone the runtime never stated, and a next
 * run T3 cannot state exactly is better left absent.
 */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isoOrUndefined = (value: string | undefined): string | undefined =>
  value !== undefined && UTC_INSTANT.test(value) ? value : undefined;

/**
 * Maps one native goal snapshot onto the board's goal.
 *
 * A goal whose id or title cannot be represented exactly is dropped: showing a
 * renamed goal would be worse than showing none, and the goal is read-only here
 * so nothing downstream needs a placeholder to act on.
 */
export const primeGoal = (goal: PrimeNativeGoal | undefined): PrimeGoal | undefined => {
  if (!goal) return undefined;
  const goalId = exactId(goal.goalId);
  const title = boundedPrimeNoticeText(goal.title, MAX_PRIME_GOAL_TITLE);
  if (!goalId || !title) return undefined;
  const detail = boundedPrimeNoticeText(goal.detail, MAX_PRIME_GOAL_DETAIL);
  return { goalId, title, status: goal.status, ...(detail ? { detail } : {}) };
};

/**
 * Maps the native heartbeat store onto the owned board.
 *
 * `owned` is the set of ids this environment created and recorded. It is the
 * whole authorization story: a heartbeat the daemon hosts for anyone else never
 * enters the board, so it cannot be listed, rendered, or targeted. Rows are
 * emitted in the runtime's own order and capped, and an out-of-range interval
 * is dropped rather than clamped — a schedule T3 cannot state exactly is a
 * schedule T3 should not claim to control.
 */
export const primeOwnedHeartbeats = (
  heartbeats: ReadonlyArray<PrimeNativeHeartbeat>,
  owned: ReadonlySet<string>,
): ReadonlyArray<PrimeHeartbeat> => {
  const rows: PrimeHeartbeat[] = [];
  const seen = new Set<string>();
  for (const heartbeat of heartbeats) {
    const heartbeatId = exactId(heartbeat.heartbeatId);
    if (!heartbeatId || !owned.has(heartbeatId) || seen.has(heartbeatId)) continue;
    const title = boundedPrimeNoticeText(heartbeat.title, MAX_PRIME_GOAL_TITLE);
    if (!title) continue;
    if (
      !Number.isSafeInteger(heartbeat.intervalSeconds) ||
      heartbeat.intervalSeconds < MIN_PRIME_HEARTBEAT_INTERVAL_SECONDS ||
      heartbeat.intervalSeconds > MAX_PRIME_HEARTBEAT_INTERVAL_SECONDS
    )
      continue;
    seen.add(heartbeatId);
    const status: PrimeHeartbeatStatus = heartbeat.paused === true ? "paused" : "active";
    // A paused heartbeat has no next run; publishing one would be a promise the
    // runtime is not making.
    const nextRunAt = status === "paused" ? undefined : isoOrUndefined(heartbeat.nextRunAt);
    rows.push({
      heartbeatId,
      title,
      intervalSeconds: heartbeat.intervalSeconds,
      status,
      ...(nextRunAt ? { nextRunAt } : {}),
    });
    if (rows.length === MAX_PRIME_HEARTBEATS) break;
  }
  return rows;
};

/**
 * Assembles the published board.
 *
 * Residency is reported only while an owned heartbeat actually needs it: a
 * disclosure that outlives its cause would leave a "stop resident session"
 * control pointing at nothing.
 */
export const primeGoalBoard = (input: {
  readonly goal?: PrimeNativeGoal | undefined;
  readonly heartbeats: ReadonlyArray<PrimeNativeHeartbeat>;
  readonly owned: ReadonlySet<string>;
  readonly resident?: boolean;
  readonly owner: string;
}): PrimeGoalBoard => {
  const goal = primeGoal(input.goal);
  const heartbeats = primeOwnedHeartbeats(input.heartbeats, input.owned);
  const owner = boundedPrimeNoticeText(input.owner, MAX_PRIME_GOAL_TITLE);
  return {
    ...(goal ? { goal } : {}),
    heartbeats,
    ...(input.resident === true && heartbeats.length > 0 && owner ? { resident: { owner } } : {}),
  };
};

/** Byte-identical boards are dropped rather than republished. */
export const primeGoalBoardFingerprint = (board: PrimeGoalBoard): string => JSON.stringify(board);

export const findOwnedPrimeHeartbeat = (
  board: PrimeGoalBoard,
  heartbeatId: string,
): PrimeHeartbeat | undefined =>
  board.heartbeats.find((heartbeat) => heartbeat.heartbeatId === heartbeatId);

export type PrimeHeartbeatIntent = "pause" | "resume" | "delete";
export type PrimeHeartbeatRefusal =
  | "unknown-heartbeat"
  | "already-paused"
  | "already-active"
  | "limit-reached"
  | "interval-out-of-range";

/**
 * Decides whether a pause/resume/delete may reach the runtime.
 *
 * A stale id from a client that rendered an older board, another thread's
 * heartbeat, and an id fished out of the daemon all fail identically, because
 * none of them is in this session's owned board. Returning a reason rather than
 * throwing keeps the refusals typed; every one of them leaves the runtime — and
 * every unowned schedule — untouched.
 */
export const primeHeartbeatDecision = (
  board: PrimeGoalBoard,
  heartbeatId: string,
  intent: PrimeHeartbeatIntent,
):
  | { readonly allowed: true; readonly heartbeat: PrimeHeartbeat }
  | { readonly allowed: false; readonly reason: PrimeHeartbeatRefusal } => {
  const heartbeat = findOwnedPrimeHeartbeat(board, heartbeatId);
  if (!heartbeat) return { allowed: false, reason: "unknown-heartbeat" };
  if (intent === "pause" && heartbeat.status === "paused")
    return { allowed: false, reason: "already-paused" };
  if (intent === "resume" && heartbeat.status === "active")
    return { allowed: false, reason: "already-active" };
  return { allowed: true, heartbeat };
};

/** Creation is bounded the same way, and for the same reason. */
export const primeHeartbeatCreateDecision = (
  board: PrimeGoalBoard,
  intervalSeconds: number,
):
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: PrimeHeartbeatRefusal } => {
  if (board.heartbeats.length >= MAX_PRIME_HEARTBEATS)
    return { allowed: false, reason: "limit-reached" };
  if (
    !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds < MIN_PRIME_HEARTBEAT_INTERVAL_SECONDS ||
    intervalSeconds > MAX_PRIME_HEARTBEAT_INTERVAL_SECONDS
  )
    return { allowed: false, reason: "interval-out-of-range" };
  return { allowed: true };
};

export const primeHeartbeatRefusalMessage = (reason: PrimeHeartbeatRefusal): string => {
  switch (reason) {
    case "unknown-heartbeat":
      return "Prime Agent does not report this heartbeat as owned by this thread's session.";
    case "already-paused":
      return "This heartbeat is already paused.";
    case "already-active":
      return "This heartbeat is already running.";
    case "limit-reached":
      return `This session already owns ${MAX_PRIME_HEARTBEATS} heartbeats; delete one before adding another.`;
    case "interval-out-of-range":
      return "A heartbeat runs every minute to once a day.";
  }
};

/**
 * Goal mutation is not mapped.
 *
 * Prime 0.7.2 reports goal state but exposes no goal create/update/cancel RPC.
 * Inventing one — or aiming it at the turn-wide `abort` — would be a control
 * that silently does something else, so the operation is refused with the
 * reason stated instead.
 */
export const PRIME_GOAL_MUTATION_REFUSAL =
  "Prime Agent reports goal progress but has no goal-change command; the goal is read-only here.";

/**
 * Shown before creating a heartbeat, every time.
 *
 * Promotion to a resident daemon is a real consequence — the session keeps
 * running when the thread is closed — so it is disclosed before the fact, not
 * discovered after it.
 */
export const PRIME_HEARTBEAT_DAEMON_DISCLOSURE =
  "Creating a heartbeat keeps this Prime Agent session resident so it can run on schedule, even while the thread is closed. Pause, resume, or delete it here at any time; stopping the session ends only this T3-owned session.";
