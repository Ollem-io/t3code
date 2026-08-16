import { boundedPrimeNoticeText } from "./PrimeExtensionUi.ts";
import type { PrimeRpcKnownEvent } from "./PrimeRpcProtocol.ts";

/**
 * Subagent roster and observation mapping for Prime 0.7.2.
 *
 * Prime reports its task store as a whole snapshot (`task_update`), and exposes
 * `observe` / `unobserve` to attach and detach from one task's output. T3 maps
 * that onto a bounded provider-neutral roster: one row per agent reported by
 * the runtime, the root included, with its own identity, state, and whether
 * this environment is currently observing it.
 *
 * Two rules shape everything here:
 *
 * - **Identities are the runtime's, never ours.** A row exists only because the
 *   runtime reported it. T3 invents no id and infers no parent, so the roster
 *   doubles as the authorization list: an id that is not in it is not a legal
 *   action target and no daemon-wide enumeration can produce one.
 * - **Observed output is status, not transcript.** An observed agent
 *   contributes one bounded line to its own row. Nothing a subagent says is
 *   copied into the thread timeline.
 */
export type PrimeTaskUpdateEvent = Extract<PrimeRpcKnownEvent, { readonly type: "task_update" }>;
export type PrimeTaskEntry = PrimeTaskUpdateEvent["tasks"][number];

export type PrimeAgentRole = "root" | "subagent";
export type PrimeAgentStatus = "running" | "paused" | "completed" | "cancelled" | "failed";

export type PrimeAgentRosterEntry = {
  readonly agentId: string;
  readonly role: PrimeAgentRole;
  readonly status: PrimeAgentStatus;
  readonly title: string;
  readonly observed: boolean;
  readonly detail?: string;
};

/** The canonical contract caps the roster at sixteen rows with clamped text. */
export const MAX_PRIME_AGENTS = 16;
export const MAX_PRIME_AGENT_ID = 128;
export const MAX_PRIME_AGENT_TITLE = 120;
export const MAX_PRIME_AGENT_DETAIL = 256;

/** A terminal agent can no longer be observed, and holds no observation open. */
export const isTerminalPrimeAgentStatus = (status: PrimeAgentStatus): boolean =>
  status === "completed" || status === "cancelled" || status === "failed";

/**
 * Maps one native task snapshot onto the roster.
 *
 * `observed` is the set of ids this environment currently holds an observation
 * on; a row is only marked observed when the runtime still reports it, so a
 * finished agent never shows a live observation. Rows whose id does not survive
 * clamping are dropped rather than renamed: an id we cannot reproduce exactly
 * could not be used as an action target anyway.
 */
export const primeAgentRoster = (
  tasks: ReadonlyArray<PrimeTaskEntry>,
  observed: ReadonlySet<string> = new Set(),
): ReadonlyArray<PrimeAgentRosterEntry> => {
  const rows: PrimeAgentRosterEntry[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    const agentId = boundedPrimeNoticeText(task.taskId, MAX_PRIME_AGENT_ID);
    if (!agentId || agentId !== task.taskId || seen.has(agentId)) continue;
    seen.add(agentId);
    const status = task.status;
    const detail = boundedPrimeNoticeText(task.detail, MAX_PRIME_AGENT_DETAIL);
    rows.push({
      agentId,
      role: task.parentTaskId === undefined ? "root" : "subagent",
      status,
      // The id is allowed to be longer than a title, so the fallback is clamped
      // again: an over-long title fails the wire contract and would drop the
      // whole roster update for this thread.
      title:
        boundedPrimeNoticeText(task.title, MAX_PRIME_AGENT_TITLE) ||
        agentId.slice(0, MAX_PRIME_AGENT_TITLE),
      observed: observed.has(agentId) && !isTerminalPrimeAgentStatus(status),
      ...(detail ? { detail } : {}),
    });
    if (rows.length === MAX_PRIME_AGENTS) break;
  }
  return rows;
};

/** Byte-identical rosters are dropped rather than republished. */
export const primeAgentRosterFingerprint = (agents: ReadonlyArray<PrimeAgentRosterEntry>): string =>
  JSON.stringify(agents);

/**
 * The one ownership gate for agent actions.
 *
 * Only an agent this T3-owned session currently reports may be observed or
 * unobserved. A stale id from a client that rendered an older roster, an id
 * belonging to another thread's session, and an id fished out of a daemon all
 * fail here with the same answer, because none of them is in this roster.
 */
export const findOwnedPrimeAgent = (
  agents: ReadonlyArray<PrimeAgentRosterEntry>,
  agentId: string,
): PrimeAgentRosterEntry | undefined => agents.find((agent) => agent.agentId === agentId);

export type PrimeObservationRefusal = "unknown-agent" | "terminal-agent" | "not-observed";

/**
 * Decides whether an observe/unobserve request may reach the runtime.
 *
 * Returning a reason rather than throwing keeps the refusals typed and lets the
 * adapter state exactly what happened; every one of them leaves the runtime
 * untouched.
 */
export const primeObservationDecision = (
  agents: ReadonlyArray<PrimeAgentRosterEntry>,
  agentId: string,
  intent: "observe" | "unobserve",
):
  | { readonly allowed: true; readonly agent: PrimeAgentRosterEntry }
  | { readonly allowed: false; readonly reason: PrimeObservationRefusal } => {
  const agent = findOwnedPrimeAgent(agents, agentId);
  if (!agent) return { allowed: false, reason: "unknown-agent" };
  if (intent === "observe") {
    return isTerminalPrimeAgentStatus(agent.status)
      ? { allowed: false, reason: "terminal-agent" }
      : { allowed: true, agent };
  }
  return agent.observed ? { allowed: true, agent } : { allowed: false, reason: "not-observed" };
};

export const primeObservationRefusalMessage = (reason: PrimeObservationRefusal): string => {
  switch (reason) {
    case "unknown-agent":
      return "Prime Agent does not report this agent for this thread's session.";
    case "terminal-agent":
      return "Prime Agent has already finished this agent; there is nothing left to observe.";
    case "not-observed":
      return "This environment is not observing that Prime Agent agent.";
  }
};
