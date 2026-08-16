export type PrimeGoalCapabilities = {
  readonly goals?: boolean | undefined;
};
export type PrimeGoal = {
  readonly goalId: string;
  readonly title: string;
  readonly status: "active" | "completed" | "cancelled";
  readonly detail?: string | undefined;
};
export type PrimeHeartbeat = {
  readonly heartbeatId: string;
  readonly title: string;
  readonly intervalSeconds: number;
  readonly status: "active" | "paused";
  readonly nextRunAt?: string | undefined;
};
export type PrimeGoalBoard = {
  readonly goal?: PrimeGoal | undefined;
  readonly heartbeats: ReadonlyArray<PrimeHeartbeat>;
  readonly resident?: { readonly owner: string } | undefined;
};
export type PrimeSessionLiveness = {
  readonly status?: string | undefined;
} | null;

/**
 * Goals and T3-owned heartbeats as both clients see them. This module is kept
 * byte-identical with its mobile twin
 * (`apps/mobile/src/features/threads/primeHeartbeat.ts`), and each surface's
 * test asserts that equality so the two cannot drift apart.
 */
export const PRIME_HEARTBEAT_OWNERSHIP_NOTE =
  "Only heartbeats created here are listed. Schedules made elsewhere in Prime Agent are never shown or changed by T3.";

/** Shown instead of controls when the installed runtime has no heartbeats. */
export const PRIME_HEARTBEATS_UNAVAILABLE =
  "This Prime Agent version does not support goals or heartbeats. Update Prime Agent to schedule recurring work.";

/**
 * Shown before creating a heartbeat, every time, and worded as a consequence
 * rather than a warning: the session stays resident so the schedule can run,
 * which is the point of asking for one.
 */
export const PRIME_HEARTBEAT_DAEMON_DISCLOSURE =
  "Creating a heartbeat keeps this Prime Agent session resident so it can run on schedule, even while the thread is closed. Pause, resume, or delete it here at any time; stopping the session ends only this T3-owned session.";

/** Goal state is read-only: Prime reports progress and exposes no goal command. */
export const PRIME_GOAL_READ_ONLY =
  "Prime Agent reports goal progress but has no goal-change command; the goal is read-only here.";

export const MIN_PRIME_HEARTBEAT_INTERVAL_SECONDS = 60;
export const MAX_PRIME_HEARTBEAT_INTERVAL_SECONDS = 86_400;
export const MAX_PRIME_HEARTBEATS = 8;
/** Mirrors the `thread.heartbeat.create` title bound so the cap is stated inline, not by schema rejection. */
export const MAX_PRIME_HEARTBEAT_TITLE_CHARS = 120;

/** True only when the runtime advertises the PA-A07 goals extension. */
export function hasPrimeGoals(
  providerName: string | null | undefined,
  capabilities: PrimeGoalCapabilities | undefined,
): boolean {
  return providerName === "prime-agent" && capabilities?.goals === true;
}

/**
 * A board only describes a live runtime. After a crash or restart the session
 * row can survive with its last snapshot attached, and offering "Pause" on a
 * schedule inside a dead process would be a control that can never succeed.
 */
export function hasLivePrimeSession(session: PrimeSessionLiveness | undefined): boolean {
  return session?.status === "running" || session?.status === "ready";
}

export type PrimeGoalBoardView =
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "board";
      readonly goal?: PrimeGoal | undefined;
      readonly heartbeats: ReadonlyArray<PrimeHeartbeat>;
      readonly resident?: { readonly owner: string } | undefined;
    };

/**
 * The single surface decision, shared by both clients.
 *
 * A live Prime session on a runtime that never advertises the extension
 * explains itself instead of rendering nothing: an older runtime should look
 * outdated, not broken. Everything else (another provider, a dead session)
 * stays hidden — but a capable live session is always shown, even with nothing
 * scheduled, because that is where a heartbeat gets created.
 */
export function primeGoalBoardView(
  providerName: string | null | undefined,
  capabilities: PrimeGoalCapabilities | undefined,
  board: PrimeGoalBoard | undefined,
  session: PrimeSessionLiveness | undefined,
): PrimeGoalBoardView {
  if (providerName !== "prime-agent" || !hasLivePrimeSession(session)) return { kind: "hidden" };
  if (capabilities?.goals !== true)
    return { kind: "unavailable", reason: PRIME_HEARTBEATS_UNAVAILABLE };
  return {
    kind: "board",
    ...(board?.goal ? { goal: board.goal } : {}),
    heartbeats: board?.heartbeats ?? [],
    // Residency is shown only while the runtime still reports it, so the
    // "stop this session" reverse control never points at nothing.
    ...(board?.resident ? { resident: board.resident } : {}),
  };
}

/** Plain-language interval, so a schedule reads the way a person would say it. */
export function renderPrimeInterval(intervalSeconds: number): string {
  if (intervalSeconds % 3600 === 0) {
    const hours = intervalSeconds / 3600;
    return hours === 1 ? "every hour" : `every ${hours} hours`;
  }
  if (intervalSeconds % 60 === 0) {
    const minutes = intervalSeconds / 60;
    return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
  }
  return `every ${intervalSeconds} seconds`;
}

export function renderPrimeHeartbeat(heartbeat: PrimeHeartbeat): string {
  const state = heartbeat.status === "paused" ? "Paused" : "Running";
  // A paused heartbeat has no next run, and inventing one would be a promise
  // nothing is making.
  const next =
    heartbeat.status === "active" && heartbeat.nextRunAt ? ` · next ${heartbeat.nextRunAt}` : "";
  return `${heartbeat.title} · ${renderPrimeInterval(heartbeat.intervalSeconds)} · ${state}${next}`;
}

const GOAL_STATUS_LABELS: Record<PrimeGoal["status"], string> = {
  active: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function renderPrimeGoal(goal: PrimeGoal): string {
  const detail = goal.detail ? ` — ${goal.detail}` : "";
  return `Goal: ${goal.title} · ${GOAL_STATUS_LABELS[goal.status]}${detail}`;
}

/** Every attached client derives these lines from the same snapshot. */
export function renderPrimeGoalBoard(
  board: PrimeGoalBoard | undefined,
  session: PrimeSessionLiveness | undefined,
): ReadonlyArray<string> {
  if (!board || !hasLivePrimeSession(session)) return [];
  return [
    ...(board.goal ? [renderPrimeGoal(board.goal)] : []),
    ...board.heartbeats.map(renderPrimeHeartbeat),
    ...(board.resident
      ? [`Resident Prime Agent session owned by ${board.resident.owner} · Stop session to end it`]
      : []),
  ];
}

export type PrimeHeartbeatControl = {
  readonly action: "heartbeat.pause" | "heartbeat.resume" | "heartbeat.delete";
  readonly label: string;
  readonly enabled: boolean;
  readonly reason?: string;
};

/**
 * The controls for one heartbeat, shared by both clients.
 *
 * Pause always renders next to its exact reverse, and delete is always present:
 * a schedule that can be created and not removed is a one-way door. A control
 * that cannot work says why instead of failing after the click. The server
 * re-checks ownership on every action regardless; this only keeps the UI honest.
 */
export function primeHeartbeatControls(
  heartbeat: PrimeHeartbeat,
  session: PrimeSessionLiveness | undefined,
  capabilities: PrimeGoalCapabilities | undefined,
): ReadonlyArray<PrimeHeartbeatControl> {
  const toggle =
    heartbeat.status === "paused"
      ? { action: "heartbeat.resume" as const, label: "Resume" }
      : { action: "heartbeat.pause" as const, label: "Pause" };
  const remove = { action: "heartbeat.delete" as const, label: "Delete" };
  const disabled = (reason: string): ReadonlyArray<PrimeHeartbeatControl> => [
    { ...toggle, enabled: false, reason },
    { ...remove, enabled: false, reason },
  ];
  if (capabilities?.goals !== true) return disabled(PRIME_HEARTBEATS_UNAVAILABLE);
  if (!hasLivePrimeSession(session))
    return disabled("This heartbeat's session is no longer running.");
  return [
    { ...toggle, enabled: true },
    { ...remove, enabled: true },
  ];
}

export type PrimeHeartbeatDraftDecision =
  | { readonly canCreate: true; readonly disclosure: string }
  | { readonly canCreate: false; readonly reason: string };

/**
 * Whether a new heartbeat may be requested, and the disclosure to show first.
 *
 * The disclosure is returned with the permission rather than left to each
 * surface: the daemon consequence must be stated before creation on every
 * client, and nothing can render the button without also getting the sentence.
 */
export function primeHeartbeatDraftDecision(
  board: PrimeGoalBoard | undefined,
  session: PrimeSessionLiveness | undefined,
  capabilities: PrimeGoalCapabilities | undefined,
  draft: { readonly title: string; readonly intervalSeconds: number },
): PrimeHeartbeatDraftDecision {
  if (capabilities?.goals !== true)
    return { canCreate: false, reason: PRIME_HEARTBEATS_UNAVAILABLE };
  if (!hasLivePrimeSession(session))
    return { canCreate: false, reason: "Start a Prime Agent session before scheduling work." };
  if ((board?.heartbeats.length ?? 0) >= MAX_PRIME_HEARTBEATS)
    return {
      canCreate: false,
      reason: `This session already owns ${MAX_PRIME_HEARTBEATS} heartbeats; delete one before adding another.`,
    };
  if (draft.title.trim().length === 0)
    return { canCreate: false, reason: "Name what this heartbeat should do." };
  if (draft.title.trim().length > MAX_PRIME_HEARTBEAT_TITLE_CHARS)
    return {
      canCreate: false,
      reason: `Keep the heartbeat name to ${MAX_PRIME_HEARTBEAT_TITLE_CHARS} characters or fewer.`,
    };
  if (
    !Number.isSafeInteger(draft.intervalSeconds) ||
    draft.intervalSeconds < MIN_PRIME_HEARTBEAT_INTERVAL_SECONDS ||
    draft.intervalSeconds > MAX_PRIME_HEARTBEAT_INTERVAL_SECONDS
  )
    return { canCreate: false, reason: "A heartbeat runs every minute to once a day." };
  return { canCreate: true, disclosure: PRIME_HEARTBEAT_DAEMON_DISCLOSURE };
}
