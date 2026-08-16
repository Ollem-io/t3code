import { assert, describe, it } from "@effect/vitest";
import {
  EMPTY_PROVIDER_SESSION_AGENT_ROSTER,
  EMPTY_PROVIDER_SESSION_GOAL_BOARD,
  EMPTY_PROVIDER_SESSION_IDENTITY_CARD,
  ProviderInstanceId,
  RuntimeExtensionId,
  capabilityForRuntimeOperation,
  reduceProviderSessionAgentRoster,
  reduceProviderSessionGoalBoard,
  reduceProviderSessionIdentityCard,
  supportsRuntimeOperation,
  type ProviderRuntimeCapabilities,
  type ProviderRuntimeCapability,
  type ProviderRuntimeEvent,
  type ProviderRuntimeOperation,
} from "@t3tools/contracts";

import {
  primeAgentsView,
  PRIME_AGENTS_UNAVAILABLE,
} from "../../web/src/components/agents/primeAgents.ts";
import {
  primeGoalBoardView,
  PRIME_HEARTBEATS_UNAVAILABLE,
} from "../../web/src/components/chat/primeHeartbeat.ts";
import {
  primeIdentityView,
  PRIME_NAMING_UNAVAILABLE,
} from "../../web/src/components/chat/primeFork.ts";

/**
 * PA-A08 Alpha phase gate.
 *
 * Every Alpha milestone added one capability, one snapshot, and one surface.
 * This test is the integration of all of them: each operation is refused unless
 * its own flag is negotiated, every snapshot converges identically on two
 * independent clients, and an older Prime Agent leaves each surface explained
 * rather than silently missing.
 */
const ALPHA_OPERATIONS: ReadonlyArray<{
  readonly type: ProviderRuntimeOperation["type"];
  readonly capability: ProviderRuntimeCapability;
}> = [
  { type: "steer.add", capability: "steer" },
  { type: "follow-up.add", capability: "followUps" },
  { type: "follow-up.cancel", capability: "followUpCancel" },
  { type: "compaction.request", capability: "compaction" },
  { type: "compaction.cancel", capability: "compactionCancel" },
  { type: "command.discover", capability: "commandDiscovery" },
  { type: "skill.invoke", capability: "commandDiscovery" },
  { type: "interaction.respond", capability: "interactions" },
  { type: "task.observe", capability: "tasks" },
  { type: "heartbeat.create", capability: "goals" },
  { type: "goal.update", capability: "goals" },
  { type: "thread.rename", capability: "namingAndForking" },
  { type: "thread.fork", capability: "namingAndForking" },
  { type: "usage.snapshot.retry", capability: "usageAndRetry" },
];

const event = (
  type: ProviderRuntimeEvent["type"],
  payload: Record<string, unknown>,
  sequence: number,
): ProviderRuntimeEvent =>
  ({
    eventId: `event-${sequence}`,
    sequence,
    provider: "prime-agent",
    providerInstanceId: ProviderInstanceId.make("prime-agent"),
    threadId: "thread-1",
    occurredAt: "2026-08-16T09:00:00.000Z",
    type,
    payload,
  }) as unknown as ProviderRuntimeEvent;

describe("PA-A08 Alpha phase integration", () => {
  it("gates every Alpha operation on its own negotiated capability", () => {
    for (const operation of ALPHA_OPERATIONS) {
      assert.strictEqual(capabilityForRuntimeOperation(operation), operation.capability);
      // An MVP runtime negotiates nothing: no Alpha operation may pass.
      assert.strictEqual(supportsRuntimeOperation(undefined, operation), false);
      assert.strictEqual(supportsRuntimeOperation({}, operation), false);
      // One flag enables exactly its own family and nothing else.
      const only = { [operation.capability]: true } as ProviderRuntimeCapabilities;
      assert.strictEqual(supportsRuntimeOperation(only, operation), true);
      for (const other of ALPHA_OPERATIONS)
        if (other.capability !== operation.capability)
          assert.strictEqual(supportsRuntimeOperation(only, other), false);
    }
  });

  it("converges two clients on one broadcast of every Alpha snapshot", () => {
    const broadcast: ReadonlyArray<ProviderRuntimeEvent> = [
      event(
        "session.agents.updated",
        {
          agents: [
            { agentId: "task-1", role: "root", status: "running", title: "Root", observed: false },
          ],
        },
        1,
      ),
      event(
        "session.goals.updated",
        {
          heartbeats: [
            {
              heartbeatId: "hb-1",
              title: "Check CI",
              intervalSeconds: 1_200,
              status: "active",
            },
          ],
        },
        2,
      ),
      event(
        "session.identity.updated",
        {
          name: "Migration work",
          forkPoints: [
            {
              forkPointId: RuntimeExtensionId.make("msg-2"),
              label: "Adapter drafted",
              role: "assistant",
              index: 1,
            },
          ],
        },
        3,
      ),
    ];
    // Two clients, two independent reducers, one broadcast: the second client
    // is derived from the events, never from the first client's result.
    const project = (events: ReadonlyArray<ProviderRuntimeEvent>) => ({
      agents: events.reduce(reduceProviderSessionAgentRoster, EMPTY_PROVIDER_SESSION_AGENT_ROSTER),
      goals: events.reduce(reduceProviderSessionGoalBoard, EMPTY_PROVIDER_SESSION_GOAL_BOARD),
      identity: events.reduce(
        reduceProviderSessionIdentityCard,
        EMPTY_PROVIDER_SESSION_IDENTITY_CARD,
      ),
    });
    const clientA = project(broadcast);
    const clientB = project(broadcast);
    assert.deepStrictEqual(clientA, clientB);
    assert.strictEqual(clientA.identity.name, "Migration work");
    assert.strictEqual(clientA.identity.forkPoints.length, 1);

    // A client that drops a snapshot must be detectable, or the assertion above
    // would prove nothing.
    const divergent = project(broadcast.slice(0, 2));
    assert.notStrictEqual(JSON.stringify(clientA), JSON.stringify(divergent));
  });

  it("clears every Alpha snapshot when the session exits", () => {
    const exited = event("session.exited", { reason: "closed" }, 9);
    assert.deepStrictEqual(
      reduceProviderSessionIdentityCard({ name: "Migration work", forkPoints: [] }, exited),
      EMPTY_PROVIDER_SESSION_IDENTITY_CARD,
    );
    assert.deepStrictEqual(
      reduceProviderSessionGoalBoard(EMPTY_PROVIDER_SESSION_GOAL_BOARD, exited),
      EMPTY_PROVIDER_SESSION_GOAL_BOARD,
    );
    assert.deepStrictEqual(
      reduceProviderSessionAgentRoster(EMPTY_PROVIDER_SESSION_AGENT_ROSTER, exited),
      EMPTY_PROVIDER_SESSION_AGENT_ROSTER,
    );
  });

  it("explains an older Prime Agent on every Alpha surface instead of hiding it", () => {
    const live = { status: "running" };
    assert.deepStrictEqual(primeAgentsView("prime-agent", {}, undefined, live), {
      kind: "unavailable",
      reason: PRIME_AGENTS_UNAVAILABLE,
    });
    assert.deepStrictEqual(primeGoalBoardView("prime-agent", {}, undefined, live), {
      kind: "unavailable",
      reason: PRIME_HEARTBEATS_UNAVAILABLE,
    });
    assert.deepStrictEqual(primeIdentityView("prime-agent", {}, undefined, live), {
      kind: "unavailable",
      reason: PRIME_NAMING_UNAVAILABLE,
    });
    // A dead session offers nothing at all: an explanation is for an older
    // runtime, not for a process that is gone.
    for (const view of [
      primeAgentsView("prime-agent", { tasks: true }, undefined, { status: "stopped" }),
      primeGoalBoardView("prime-agent", { goals: true }, undefined, { status: "stopped" }),
      primeIdentityView("prime-agent", { namingAndForking: true }, undefined, {
        status: "stopped",
      }),
    ])
      assert.strictEqual(view.kind, "hidden");
  });
});
