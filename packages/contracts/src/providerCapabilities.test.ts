import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  capabilityForRuntimeOperation,
  ProviderRuntimeExtensionState,
  ProviderRuntimeOperation,
  ProviderRuntimeOperationOutcome,
  supportsRuntimeOperation,
} from "./providerCapabilities.ts";

const decodeOperation = Schema.decodeUnknownSync(ProviderRuntimeOperation);
const encodeOperation = Schema.encodeSync(ProviderRuntimeOperation);
const decodeOutcome = Schema.decodeUnknownSync(ProviderRuntimeOperationOutcome);
const decodeState = Schema.decodeUnknownSync(ProviderRuntimeExtensionState);

const operations: ReadonlyArray<[unknown, string]> = [
  [{ type: "steer.add", commandId: "c1", threadId: "t1", steerId: "s1", text: "steer" }, "steer"],
  [
    { type: "follow-up.add", commandId: "c1", threadId: "t1", followUpId: "f1", text: "continue" },
    "followUps",
  ],
  [
    { type: "follow-up.edit", commandId: "c1", threadId: "t1", followUpId: "f1", text: "revise" },
    "followUps",
  ],
  [
    { type: "follow-up.reorder", commandId: "c1", threadId: "t1", followUpId: "f1", position: 0 },
    "followUps",
  ],
  [{ type: "follow-up.cancel", commandId: "c1", threadId: "t1", followUpId: "f1" }, "followUps"],
  [
    {
      type: "follow-up.reverse",
      commandId: "c1",
      threadId: "t1",
      followUpId: "f1",
      targetCommandId: "c0",
    },
    "followUps",
  ],
  [
    { type: "compaction.request", commandId: "c1", threadId: "t1", compactionId: "x1" },
    "compaction",
  ],
  [
    { type: "compaction.cancel", commandId: "c1", threadId: "t1", compactionId: "x1" },
    "compaction",
  ],
  [
    {
      type: "compaction.reverse",
      commandId: "c1",
      threadId: "t1",
      compactionId: "x1",
      targetCommandId: "c0",
    },
    "compaction",
  ],
  [{ type: "command.discover", commandId: "c1", threadId: "t1" }, "commandDiscovery"],
  [
    { type: "command.invoke", commandId: "c1", threadId: "t1", commandName: "format" },
    "commandDiscovery",
  ],
  [{ type: "skill.discover", commandId: "c1", threadId: "t1" }, "commandDiscovery"],
  [
    { type: "skill.invoke", commandId: "c1", threadId: "t1", skillName: "review" },
    "commandDiscovery",
  ],
  [
    {
      type: "interaction.respond",
      commandId: "c1",
      threadId: "t1",
      interactionId: "i1",
      choiceId: "yes",
    },
    "interactions",
  ],
  [
    { type: "interaction.cancel", commandId: "c1", threadId: "t1", interactionId: "i1" },
    "interactions",
  ],
  ...(["observe", "pause", "resume", "cancel"] as const).map(
    (action) =>
      [{ type: `task.${action}`, commandId: "c1", threadId: "t1", taskId: "task1" }, "tasks"] as [
        unknown,
        string,
      ],
  ),
  [{ type: "goal.create", commandId: "c1", threadId: "t1", goalId: "g1", title: "ship" }, "goals"],
  [{ type: "goal.update", commandId: "c1", threadId: "t1", goalId: "g1" }, "goals"],
  [{ type: "goal.delete", commandId: "c1", threadId: "t1", goalId: "g1" }, "goals"],
  [
    { type: "goal.reverse", commandId: "c1", threadId: "t1", goalId: "g1", targetCommandId: "c0" },
    "goals",
  ],
  ...(["create", "update", "pause", "resume", "delete", "reverse"] as const).map(
    (action) =>
      [
        {
          type: `heartbeat.${action}`,
          commandId: "c1",
          threadId: "t1",
          heartbeatId: "h1",
          ...(action === "create"
            ? { title: "watch", intervalSeconds: 10 }
            : action === "reverse"
              ? { targetCommandId: "c0" }
              : {}),
        },
        "goals",
      ] as [unknown, string],
  ),
  [{ type: "thread.rename", commandId: "c1", threadId: "t1", title: "named" }, "namingAndForking"],
  [{ type: "thread.fork", commandId: "c1", threadId: "t1" }, "namingAndForking"],
  [
    { type: "usage.snapshot.retry", commandId: "c1", threadId: "t1", requestId: "r1" },
    "usageAndRetry",
  ],
];

describe("provider runtime extension contract", () => {
  it.each(operations)("round trips and maps %o", (wire, capability) => {
    const operation = decodeOperation(wire);
    expect(encodeOperation(operation)).toMatchObject(wire as Record<string, unknown>);
    expect(capabilityForRuntimeOperation(operation)).toBe(capability);
    expect(supportsRuntimeOperation({ [capability]: true }, operation)).toBe(true);
    expect(supportsRuntimeOperation({}, operation)).toBe(false);
  });
  it("has typed lifecycle outcomes including bounded error and reverse reference", () => {
    expect(
      decodeOutcome({
        status: "pending",
        commandId: "c1",
        type: "goal.create",
        capability: "goals",
      }).status,
    ).toBe("pending");
    expect(
      decodeOutcome({
        status: "succeeded",
        commandId: "c1",
        type: "command.discover",
        capability: "commandDiscovery",
        result: { commands: [{ name: "format" }] },
      }).status,
    ).toBe("succeeded");
    expect(
      decodeOutcome({
        status: "succeeded",
        commandId: "c1",
        type: "goal.create",
        capability: "goals",
        result: { acknowledged: true },
      }).status,
    ).toBe("succeeded");
    for (const [type, capability, result] of [
      ["interaction.respond", "interactions", { interactionResponse: { status: "responded" } }],
      ["interaction.cancel", "interactions", { interactionResponse: { status: "cancelled" } }],
      [
        "command.invoke",
        "commandDiscovery",
        { commandInvocation: { name: "format", status: "completed" } },
      ],
      [
        "skill.invoke",
        "commandDiscovery",
        { skillInvocation: { name: "review", status: "completed" } },
      ],
    ] as const) {
      expect(
        decodeOutcome({ status: "succeeded", commandId: "c1", type, capability, result }).status,
      ).toBe("succeeded");
    }
    for (const [type, capability, result] of [
      ["interaction.respond", "interactions", { interactionResponse: { status: "cancelled" } }],
      ["interaction.cancel", "interactions", { interactionResponse: { status: "responded" } }],
      [
        "command.invoke",
        "commandDiscovery",
        { skillInvocation: { name: "review", status: "completed" } },
      ],
      [
        "skill.invoke",
        "commandDiscovery",
        { commandInvocation: { name: "format", status: "completed" } },
      ],
    ] as const) {
      expect(() =>
        decodeOutcome({ status: "succeeded", commandId: "c1", type, capability, result }),
      ).toThrow();
    }
    expect(() =>
      decodeOutcome({
        status: "succeeded",
        commandId: "c1",
        type: "goal.create",
        capability: "goals",
        result: { commands: [{ name: "format" }] },
      }),
    ).toThrow();
    expect(() =>
      decodeOutcome({
        status: "succeeded",
        commandId: "c1",
        type: "command.discover",
        capability: "commandDiscovery",
        result: { skills: [{ name: "review" }] },
      }),
    ).toThrow();
    expect(
      decodeOutcome({
        status: "failed",
        commandId: "c1",
        type: "goal.create",
        capability: "goals",
        errorCode: "NOT_SUPPORTED",
      }).status,
    ).toBe("failed");
    expect(
      decodeOutcome({
        status: "reversed",
        commandId: "c1",
        type: "goal.reverse",
        capability: "goals",
        reverseCommandId: "c0",
      }).status,
    ).toBe("reversed");
    expect(() =>
      decodeOutcome({
        status: "failed",
        commandId: "c1",
        type: "goal.create",
        capability: "goals",
        errorCode: "too long and invalid",
      }),
    ).toThrow();
  });
  it("keeps historical extension state and rejects generic command passthrough", () => {
    expect(decodeState({ future: { anything: true } })).toEqual({ capabilities: {} });
    for (const type of ["shell.run", "prime.raw", "native.invoke"] as const) {
      expect(() => decodeOperation({ type, commandId: "c1", threadId: "t1" })).toThrow();
    }
  });
});


it("does not imply follow-up cancellation from enqueue capability", () => {
  const add = decodeOperation({ type: "follow-up.add", commandId: "c1", threadId: "t1", followUpId: "f1", text: "later" });
  const cancel = decodeOperation({ type: "follow-up.cancel", commandId: "c2", threadId: "t1", followUpId: "f1" });
  expect(supportsRuntimeOperation({ followUps: true }, add)).toBe(true);
  expect(supportsRuntimeOperation({ followUps: true }, cancel)).toBe(false);
  expect(supportsRuntimeOperation({ followUpCancel: true }, cancel)).toBe(true);
});
