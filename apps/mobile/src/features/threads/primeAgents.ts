export type PrimeAgentCapabilities = {
  readonly tasks?: boolean | undefined;
};
export type PrimeAgent = {
  readonly agentId: string;
  readonly role: "root" | "subagent";
  readonly status: "running" | "paused" | "completed" | "cancelled" | "failed";
  readonly title: string;
  readonly observed: boolean;
  readonly detail?: string | undefined;
};
export type PrimeAgentRoster = { readonly agents: ReadonlyArray<PrimeAgent> };
export type PrimeSessionLiveness = {
  readonly status?: string | undefined;
} | null;

/**
 * Root and subagent work as the Agents surface sees it. This module is kept
 * byte-identical with its mobile twin
 * (`apps/mobile/src/features/threads/primeAgents.ts`), and each surface's test
 * asserts that equality so the two cannot drift apart.
 */
export const PRIME_AGENTS_ARE_NOT_TRANSCRIPT =
  "Agent work is shown here rather than in the conversation, so a subagent's output never floods the transcript.";

/** Shown instead of controls when the installed runtime cannot observe agents. */
export const PRIME_AGENTS_UNAVAILABLE =
  "This Prime Agent version does not support watching agents. Update Prime Agent to observe subagent work.";

/** True only when the runtime advertises the PA-A06 agents extension. */
export function hasPrimeAgents(
  providerName: string | null | undefined,
  capabilities: PrimeAgentCapabilities | undefined,
): boolean {
  return providerName === "prime-agent" && capabilities?.tasks === true;
}

/**
 * A roster only describes a live runtime. After a crash or restart the session
 * row can survive with its last snapshot attached, and offering "Watch" on an
 * agent inside a dead process would be a control that can never succeed.
 */
export function hasLivePrimeSession(session: PrimeSessionLiveness | undefined): boolean {
  return session?.status === "running" || session?.status === "ready";
}

export function isTerminalPrimeAgent(agent: PrimeAgent): boolean {
  return agent.status === "completed" || agent.status === "cancelled" || agent.status === "failed";
}

/** Every attached client derives this from the same snapshot, so views converge. */
export function visiblePrimeAgents(
  roster: PrimeAgentRoster | undefined,
  session: PrimeSessionLiveness | undefined,
): ReadonlyArray<PrimeAgent> {
  if (!roster || !hasLivePrimeSession(session)) return [];
  return roster.agents;
}

export type PrimeAgentsView =
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "agents"; readonly agents: ReadonlyArray<PrimeAgent> };

/**
 * The single surface decision, shared by both clients.
 *
 * A live Prime session on a runtime that never advertises the agents extension
 * explains itself instead of rendering nothing: an older runtime should look
 * outdated, not broken. Everything else (another provider, a dead session, a
 * capable runtime with no agents to show) stays hidden.
 */
export function primeAgentsView(
  providerName: string | null | undefined,
  capabilities: PrimeAgentCapabilities | undefined,
  roster: PrimeAgentRoster | undefined,
  session: PrimeSessionLiveness | undefined,
): PrimeAgentsView {
  if (providerName !== "prime-agent" || !hasLivePrimeSession(session)) return { kind: "hidden" };
  if (capabilities?.tasks !== true)
    return { kind: "unavailable", reason: PRIME_AGENTS_UNAVAILABLE };
  const agents = visiblePrimeAgents(roster, session);
  if (agents.length === 0) return { kind: "hidden" };
  return { kind: "agents", agents };
}

const STATUS_LABELS: Record<PrimeAgent["status"], string> = {
  running: "Working",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Stopped",
  failed: "Failed",
};

/** Static one-line rendering; every line is derived from the latest snapshot. */
export function renderPrimeAgent(agent: PrimeAgent): string {
  const role = agent.role === "root" ? "Main agent" : "Subagent";
  const watching = agent.observed ? " · Watching" : "";
  const detail = agent.detail ? ` — ${agent.detail}` : "";
  return `${role}: ${agent.title} · ${STATUS_LABELS[agent.status]}${watching}${detail}`;
}

export function renderPrimeAgents(
  roster: PrimeAgentRoster | undefined,
  session: PrimeSessionLiveness | undefined,
): ReadonlyArray<string> {
  return visiblePrimeAgents(roster, session).map(renderPrimeAgent);
}

export type PrimeAgentControl = {
  readonly action: "task.observe" | "task.unobserve";
  readonly label: string;
  readonly enabled: boolean;
  readonly reason?: string;
};

/**
 * The one control decision, shared by both clients.
 *
 * Watching always has its exact reverse next to it, and a control that cannot
 * work says why instead of failing after the click. The server re-checks
 * ownership on every action regardless: this only keeps the UI honest.
 */
export function primeAgentControl(
  agent: PrimeAgent,
  session: PrimeSessionLiveness | undefined,
  capabilities: PrimeAgentCapabilities | undefined,
): PrimeAgentControl {
  const action = agent.observed ? "task.unobserve" : "task.observe";
  const label = agent.observed ? "Stop watching" : "Watch";
  if (capabilities?.tasks !== true)
    return { action, label, enabled: false, reason: PRIME_AGENTS_UNAVAILABLE };
  if (!hasLivePrimeSession(session))
    return { action, label, enabled: false, reason: "This agent's session is no longer running." };
  if (!agent.observed && isTerminalPrimeAgent(agent))
    return { action, label, enabled: false, reason: "This agent has already finished." };
  return { action, label, enabled: true };
}
