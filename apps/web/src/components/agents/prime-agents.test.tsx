// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PRIME_AGENTS_ARE_NOT_TRANSCRIPT,
  PRIME_AGENTS_UNAVAILABLE,
  hasLivePrimeSession,
  hasPrimeAgents,
  primeAgentControl,
  primeAgentsView,
  renderPrimeAgent,
  renderPrimeAgents,
  visiblePrimeAgents,
  type PrimeAgent,
} from "./primeAgents";
import { PrimeAgentsSection } from "./PrimeAgentsSection";

const root: PrimeAgent = {
  agentId: "root-1",
  role: "root",
  status: "running",
  title: "Refactor pass",
  observed: false,
};
const watched: PrimeAgent = {
  agentId: "sub-1",
  role: "subagent",
  status: "running",
  title: "Read the tests",
  observed: true,
  detail: "12 tests read",
};
const finished: PrimeAgent = {
  agentId: "sub-2",
  role: "subagent",
  status: "completed",
  title: "Run the tests",
  observed: false,
};
const roster = { agents: [root, watched, finished] };
const live = { status: "running" };
const capabilities = { tasks: true };

describe("prime agents surface", () => {
  it("is unavailable without prime-agent or the negotiated capability", () => {
    expect(hasPrimeAgents("codex", { tasks: true })).toBe(false);
    expect(hasPrimeAgents("prime-agent", {})).toBe(false);
    expect(hasPrimeAgents("prime-agent", { tasks: true })).toBe(true);
  });

  // Crash-restart regression shape: a stopped session can keep its last
  // snapshot, and offering "Watch" inside a dead process is a control that can
  // never succeed.
  it("shows nothing for a session that is not live", () => {
    expect(hasLivePrimeSession({ status: "ready" })).toBe(true);
    expect(hasLivePrimeSession({ status: "stopped" })).toBe(false);
    expect(visiblePrimeAgents(roster, { status: "stopped" })).toEqual([]);
    expect(visiblePrimeAgents(undefined, live)).toEqual([]);
  });

  it("renders identity, state, and observation for every agent", () => {
    expect(renderPrimeAgents(roster, live)).toEqual([
      "Main agent: Refactor pass · Working",
      "Subagent: Read the tests · Working · Watching — 12 tests read",
      "Subagent: Run the tests · Completed",
    ]);
  });

  it("always offers the exact reverse of the current observation state", () => {
    expect(primeAgentControl(watched, live, capabilities)).toEqual({
      action: "task.unobserve",
      label: "Stop watching",
      enabled: true,
    });
    expect(primeAgentControl(root, live, capabilities)).toEqual({
      action: "task.observe",
      label: "Watch",
      enabled: true,
    });
  });

  it("explains a disabled control rather than failing after the click", () => {
    expect(primeAgentControl(finished, live, capabilities)).toMatchObject({
      enabled: false,
      reason: "This agent has already finished.",
    });
    expect(primeAgentControl(root, { status: "stopped" }, capabilities)).toMatchObject({
      enabled: false,
    });
    // A runtime without observation says so instead of hiding the reason.
    expect(primeAgentControl(root, live, {})).toMatchObject({
      enabled: false,
      reason: PRIME_AGENTS_UNAVAILABLE,
    });
  });

  it("still lets a watched agent be unwatched after it is paused", () => {
    const paused = { ...watched, status: "paused" as const };
    expect(primeAgentControl(paused, live, capabilities).action).toBe("task.unobserve");
    expect(primeAgentControl(paused, live, capabilities).enabled).toBe(true);
  });

  it("converges two clients on one snapshot", () => {
    // Two independently derived views of the same roster must agree; deriving
    // B from A's output would make this assertion unfalsifiable.
    const clientA = visiblePrimeAgents(roster, live).map(renderPrimeAgent);
    const clientB = visiblePrimeAgents({ agents: [...roster.agents] }, { status: "ready" }).map(
      renderPrimeAgent,
    );
    expect(clientB).toEqual(clientA);
  });

  it("renders rows and says the output is not transcript", () => {
    const markup = renderToStaticMarkup(
      <PrimeAgentsSection
        providerName="prime-agent"
        capabilities={capabilities}
        roster={roster}
        session={live}
        onToggleObservation={() => {}}
      />,
    );
    expect(markup).toContain("Refactor pass");
    expect(markup).toContain("Stop watching");
    expect(markup).toContain("Watch");
    expect(markup).toContain(PRIME_AGENTS_ARE_NOT_TRANSCRIPT.split("'")[0]);
    expect(markup).toContain("disabled=");
  });

  // Regression: a runtime without the agents extension used to render literally
  // nothing, so the promised explanation was unreachable product code.
  it("explains an older runtime instead of rendering nothing", () => {
    expect(primeAgentsView("prime-agent", {}, roster, live)).toEqual({
      kind: "unavailable",
      reason: PRIME_AGENTS_UNAVAILABLE,
    });
    expect(primeAgentsView("prime-agent", undefined, undefined, live)).toEqual({
      kind: "unavailable",
      reason: PRIME_AGENTS_UNAVAILABLE,
    });
    const markup = renderToStaticMarkup(
      <PrimeAgentsSection
        providerName="prime-agent"
        capabilities={{}}
        roster={roster}
        session={live}
        onToggleObservation={() => {}}
      />,
    );
    expect(markup).toContain(PRIME_AGENTS_UNAVAILABLE);
    expect(markup).not.toContain("Refactor pass");
  });

  it("renders nothing for another provider, a dead session, or an empty roster", () => {
    expect(primeAgentsView("codex", capabilities, roster, live)).toEqual({ kind: "hidden" });
    expect(primeAgentsView("prime-agent", {}, roster, { status: "stopped" })).toEqual({
      kind: "hidden",
    });
    expect(primeAgentsView("prime-agent", capabilities, { agents: [] }, live)).toEqual({
      kind: "hidden",
    });
    for (const props of [
      { providerName: "codex", capabilities, session: live },
      { providerName: "prime-agent", capabilities, session: { status: "stopped" } },
      { providerName: "prime-agent", capabilities: {}, session: { status: "stopped" } },
    ]) {
      expect(
        renderToStaticMarkup(
          <PrimeAgentsSection roster={roster} onToggleObservation={() => {}} {...props} />,
        ),
      ).toBe("");
    }
  });

  it("keeps the mobile twin byte-identical", () => {
    expect(readFileSync("apps/mobile/src/features/threads/primeAgents.ts", "utf8")).toBe(
      readFileSync("apps/web/src/components/agents/primeAgents.ts", "utf8"),
    );
  });
});
