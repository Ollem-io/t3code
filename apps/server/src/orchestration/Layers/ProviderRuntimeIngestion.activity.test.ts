import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});

describe("runtimeEventToActivities prime context", () => {
  const contextEvent = (eventId: string, payload: Record<string, unknown>): ProviderRuntimeEvent =>
    ({
      ...base,
      provider: ProviderDriverKind.make("prime-agent"),
      type: "session.context.updated",
      eventId: EventId.make(eventId),
      payload,
    }) as ProviderRuntimeEvent;

  it("labels compaction as compaction, never as a checkpoint or revert", () => {
    const [activity] = runtimeEventToActivities(
      contextEvent("evt-compacted", {
        compaction: { status: "succeeded", trigger: "manual" },
        usage: { usedTokens: 120, maxTokens: 8_000 },
      }),
    );

    expect(activity?.kind).toBe("context-compaction");
    expect(activity?.summary).toBe("Context compacted");
    expect(activity?.tone).toBe("info");
    expect(JSON.stringify(activity?.payload)).not.toMatch(/checkpoint|revert|rollback/i);
  });

  it("surfaces running, failed, and cancelled compaction distinctly", () => {
    expect(
      runtimeEventToActivities(
        contextEvent("evt-running", { compaction: { status: "running", trigger: "manual" } }),
      )[0]?.summary,
    ).toBe("Compacting context");
    const [failed] = runtimeEventToActivities(
      contextEvent("evt-failed", {
        compaction: { status: "failed", trigger: "automatic", reason: "provider busy" },
        retry: { attempt: 2, maxAttempts: 3 },
      }),
    );
    expect(failed?.summary).toBe("Context compaction failed");
    expect(failed?.tone).toBe("error");
    expect(failed?.payload).toMatchObject({
      status: "failed",
      trigger: "automatic",
      detail: "provider busy",
      retry: { attempt: 2, maxAttempts: 3 },
    });
    expect(
      runtimeEventToActivities(
        contextEvent("evt-cancelled", { compaction: { status: "cancelled", trigger: "manual" } }),
      )[0]?.summary,
    ).toBe("Context compaction cancelled");
  });

  it("emits nothing while the runtime reports an idle context", () => {
    expect(
      runtimeEventToActivities(
        contextEvent("evt-idle", { compaction: { status: "idle", trigger: "automatic" } }),
      ),
    ).toEqual([]);
  });
});
