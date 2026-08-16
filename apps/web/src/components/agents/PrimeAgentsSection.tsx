import {
  PRIME_AGENTS_ARE_NOT_TRANSCRIPT,
  hasPrimeAgents,
  primeAgentControl,
  renderPrimeAgent,
  visiblePrimeAgents,
  type PrimeAgent,
  type PrimeAgentCapabilities,
  type PrimeAgentRoster,
  type PrimeSessionLiveness,
} from "./primeAgents";

export interface PrimeAgentsSectionProps {
  readonly providerName: string | null | undefined;
  readonly capabilities: PrimeAgentCapabilities | undefined;
  readonly roster: PrimeAgentRoster | undefined;
  /** Liveness fact, so a crashed session never offers controls that cannot work. */
  readonly session: PrimeSessionLiveness | undefined;
  readonly onToggleObservation: (
    agent: PrimeAgent,
    action: "task.observe" | "task.unobserve",
  ) => void;
}

/**
 * Root and subagent rows inside the existing Agents surface.
 *
 * Every row is derived from the latest authoritative roster, so all attached
 * clients show the same thing and there is nothing to animate. Watching an
 * agent always has its exact reverse on the same row.
 */
export function PrimeAgentsSection(props: PrimeAgentsSectionProps) {
  if (!hasPrimeAgents(props.providerName, props.capabilities)) return null;
  const agents = visiblePrimeAgents(props.roster, props.session);
  if (agents.length === 0) return null;

  return (
    <div className="px-2 py-1 text-xs text-muted-foreground" data-testid="prime-agents">
      {agents.map((agent) => {
        const control = primeAgentControl(agent, props.session, props.capabilities);
        return (
          <div
            key={agent.agentId}
            className="flex items-center gap-2"
            data-testid="prime-agent-row"
          >
            <span>{renderPrimeAgent(agent)}</span>
            <button
              type="button"
              className="rounded-md border px-2 py-0.5 disabled:opacity-50"
              disabled={!control.enabled}
              title={control.reason}
              onClick={() => {
                props.onToggleObservation(agent, control.action);
              }}
            >
              {control.label}
            </button>
            {control.reason === undefined ? null : <span>{control.reason}</span>}
          </div>
        );
      })}
      <div>{PRIME_AGENTS_ARE_NOT_TRANSCRIPT}</div>
    </div>
  );
}
