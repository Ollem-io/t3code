import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ProviderEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from "./provider.ts";
import { ModelSelection } from "./orchestration.ts";
import { ServerProvider } from "./server.ts";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);
const decodeProviderSession = Schema.decodeUnknownSync(ProviderSession);
const decodeProviderEvent = Schema.decodeUnknownSync(ProviderEvent);
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);
const encodeModelSelection = Schema.encodeSync(ModelSelection);
const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      runtimeMode: "full-access",
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelSelection?.instanceId).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    expect(getOptionValue(parsed.modelSelection?.options, "reasoningEffort")).toBe("high");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("accepts claude runtime knobs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeAgent",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: [
          { id: "thinking", value: true },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ],
      },
      runtimeMode: "full-access",
    });
    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.modelSelection?.instanceId).toBe("claudeAgent");
    expect(parsed.modelSelection?.model).toBe("claude-sonnet-4-6");
    expect(getOptionValue(parsed.modelSelection?.options, "thinking")).toBe(true);
    expect(getOptionValue(parsed.modelSelection?.options, "effort")).toBe("max");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
    expect(parsed.runtimeMode).toBe("full-access");
  });

  it("accepts cursor provider", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "cursor",
      cwd: "/tmp/workspace",
      runtimeMode: "full-access",
      modelSelection: {
        provider: "cursor",
        model: "composer-2",
        options: [{ id: "fastMode", value: true }],
      },
    });
    expect(parsed.provider).toBe("cursor");
    expect(parsed.modelSelection?.instanceId).toBe("cursor");
    expect(parsed.modelSelection?.model).toBe("composer-2");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });

  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      cwd: "/tmp/workspace",
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: "ollama_local",
        model: "llama3.3",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
    expect(parsed.modelSelection?.instanceId).toBe("ollama_local");
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts codex modelSelection", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "fastMode", value: true },
        ],
      },
    });

    expect(parsed.modelSelection?.instanceId).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    expect(getOptionValue(parsed.modelSelection?.options, "reasoningEffort")).toBe("xhigh");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });

  it("accepts claude modelSelection including ultrathink", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: [
          { id: "effort", value: "ultrathink" },
          { id: "fastMode", value: true },
        ],
      },
    });

    expect(parsed.modelSelection?.instanceId).toBe("claudeAgent");
    expect(getOptionValue(parsed.modelSelection?.options, "effort")).toBe("ultrathink");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });
  it("accepts bounded text attachments", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      input: "inspect",
      attachments: [{
        type: "text",
        id: "thread-1-11111111-1111-4111-8111-111111111111",
        name: "error.log",
        mimeType: "text/plain",
        sizeBytes: 4,
      }],
    });
    expect(parsed.attachments?.[0]?.type).toBe("text");
  });

});

describe("providerInstanceId routing key (slice-2 invariant)", () => {
  it("decodes a ProviderSessionStartInput without providerInstanceId (legacy producer)", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      runtimeMode: "full-access",
    });
    expect(parsed.providerInstanceId).toBeUndefined();
  });

  it("decodes a ProviderSessionStartInput with providerInstanceId (post-migration producer)", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      providerInstanceId: "codex_personal",
      runtimeMode: "full-access",
    });
    expect(parsed.providerInstanceId).toBe("codex_personal");
  });

  it("propagates providerInstanceId through ProviderSession decode", () => {
    const session = decodeProviderSession({
      provider: "codex",
      providerInstanceId: "codex_work",
      status: "ready",
      runtimeMode: "full-access",
      threadId: "thread-1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    expect(session.providerInstanceId).toBe("codex_work");
  });

  it("decodes ProviderSession for fork-provided driver kinds", () => {
    const session = decodeProviderSession({
      provider: "ollama",
      providerInstanceId: "ollama_local",
      status: "ready",
      runtimeMode: "full-access",
      threadId: "thread-1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    expect(session.provider).toBe("ollama");
    expect(session.providerInstanceId).toBe("ollama_local");
  });

  it("decodes a ProviderEvent carrying both legacy provider and new instance routing", () => {
    const event = decodeProviderEvent({
      id: "event-1",
      kind: "notification",
      provider: "codex",
      providerInstanceId: "codex_personal",
      threadId: "thread-1",
      createdAt: "2024-01-01T00:00:00Z",
      method: "session.created",
    });
    expect(event.provider).toBe("codex");
    expect(event.providerInstanceId).toBe("codex_personal");
  });

  it("rejects providerInstanceId values that fail the slug pattern (defense in depth)", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
        providerInstanceId: "1bad",
        runtimeMode: "full-access",
      }),
    ).toThrow();
  });
});

describe("Prime structured model identity compatibility", () => {
  it("keeps overlapping upstream model ids distinct in selections and snapshots", () => {
    const anthropic = decodeModelSelection({
      instanceId: "prime-agent",
      model: "anthropic/claude-sonnet",
      nativeIdentity: { provider: "anthropic", modelId: "claude-sonnet" },
    });
    const custom = decodeModelSelection({
      instanceId: "prime-agent",
      model: "custom/claude-sonnet",
      nativeIdentity: { provider: "custom", modelId: "claude-sonnet" },
    });
    expect(anthropic.nativeIdentity).not.toEqual(custom.nativeIdentity);
    expect(encodeModelSelection(anthropic).nativeIdentity).toEqual({
      provider: "anthropic", modelId: "claude-sonnet",
    });
    expect(encodeModelSelection(custom).nativeIdentity).toEqual({
      provider: "custom", modelId: "claude-sonnet",
    });

    const snapshot = decodeServerProvider({
      instanceId: "prime-agent", driver: "prime-agent", enabled: true, installed: true,
      version: "0.7.2", status: "ready", compatibility: "compatible",
      auth: { status: "authenticated" }, checkedAt: "2026-01-01T00:00:00Z",
      models: [
        { slug: "anthropic/claude-sonnet", name: "Claude", isCustom: false, capabilities: null,
          nativeIdentity: { provider: "anthropic", modelId: "claude-sonnet" } },
        { slug: "custom/claude-sonnet", name: "Claude", isCustom: true, capabilities: null,
          nativeIdentity: { provider: "custom", modelId: "claude-sonnet" }, availability: "stale" },
      ],
    });
    expect(snapshot.models.map((model) => model.nativeIdentity?.provider)).toEqual([
      "anthropic", "custom",
    ]);
  });

  it("decodes older readable selections and snapshots when new fields are absent", () => {
    expect(decodeModelSelection({ provider: "prime-agent", model: "anthropic/claude-sonnet" }))
      .toMatchObject({ instanceId: "prime-agent", model: "anthropic/claude-sonnet" });
    const legacy = decodeServerProvider({
      instanceId: "prime-agent", driver: "prime-agent", enabled: false, installed: false,
      version: null, status: "disabled", auth: { status: "unknown" },
      checkedAt: "2026-01-01T00:00:00Z", models: [],
    });
    expect(legacy.compatibility).toBeUndefined();
  });
});
