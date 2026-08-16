import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  PRIME_AGENTS_UNAVAILABLE,
  hasLivePrimeSession,
  hasPrimeAgents,
  primeAgentControl,
  primeAgentsView,
  renderPrimeAgents,
  visiblePrimeAgents,
  type PrimeAgent,
} from "./primeAgents";

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
const roster = { agents: [root, watched] };
const live = { status: "running" };
const capabilities = { tasks: true };

describe("prime agents surface (mobile)", () => {
  it("is capability-gated to prime-agent", () => {
    expect(hasPrimeAgents("prime-agent", { tasks: true })).toBe(true);
    expect(hasPrimeAgents("prime-agent", {})).toBe(false);
    expect(hasPrimeAgents("codex", { tasks: true })).toBe(false);
  });

  it("hides every agent once the session is no longer live", () => {
    expect(hasLivePrimeSession({ status: "error" })).toBe(false);
    expect(visiblePrimeAgents(roster, { status: "stopped" })).toEqual([]);
    expect(renderPrimeAgents(roster, live)).toEqual([
      "Main agent: Refactor pass · Working",
      "Subagent: Read the tests · Working · Watching — 12 tests read",
    ]);
  });

  it("offers watch and its reverse, and explains a disabled control", () => {
    expect(primeAgentControl(root, live, capabilities)).toEqual({
      action: "task.observe",
      label: "Watch",
      enabled: true,
    });
    expect(primeAgentControl(watched, live, capabilities).action).toBe("task.unobserve");
    expect(primeAgentControl(root, live, undefined)).toMatchObject({
      enabled: false,
      reason: PRIME_AGENTS_UNAVAILABLE,
    });
    expect(primeAgentControl({ ...root, status: "failed" }, live, capabilities).enabled).toBe(
      false,
    );
  });

  // Regression: the composer used to hide the whole section when the runtime
  // lacked `tasks`, so the promised explanation never reached a phone.
  it("explains an older runtime instead of rendering nothing", () => {
    expect(primeAgentsView("prime-agent", {}, roster, live)).toEqual({
      kind: "unavailable",
      reason: PRIME_AGENTS_UNAVAILABLE,
    });
    expect(primeAgentsView("prime-agent", capabilities, roster, live)).toEqual({
      kind: "agents",
      agents: roster.agents,
    });
    expect(primeAgentsView("codex", capabilities, roster, live)).toEqual({ kind: "hidden" });
    expect(primeAgentsView("prime-agent", {}, roster, { status: "stopped" })).toEqual({
      kind: "hidden",
    });
    const composer = readFileSync("apps/mobile/src/features/threads/ThreadComposer.tsx", "utf8");
    expect(composer).toContain('primeAgentsSurface.kind === "unavailable"');
    expect(composer).toContain("{primeAgentsSurface.reason}");
    // ...and outside the runtime-action panel, whose own gate needs `steer` or
    // `followUps`: observation is a separate capability and must not inherit
    // an unrelated one.
    expect(composer.indexOf('primeAgentsSurface.kind === "hidden" ? null : (')).toBeGreaterThan(
      composer.indexOf("{/* Transient extension status"),
    );
  });

  it("shows the same rows as web for the same snapshot", () => {
    // The projection is one shared module; this asserts the two copies of it
    // cannot drift, which is what makes multi-device parity real.
    expect(readFileSync("apps/mobile/src/features/threads/primeAgents.ts", "utf8")).toBe(
      readFileSync("apps/web/src/components/agents/primeAgents.ts", "utf8"),
    );
  });
});
