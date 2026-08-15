import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import {
  buildModelOptions,
  getModelSelectionAvailability,
  groupByProvider,
  modelCapabilityLabels,
  resolveDefaultableModelSelection,
  resolveSelectableModelSelection,
} from "./modelOptions";

describe("mobile model options", () => {
  it("groups models by provider and flags legacy entries", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(groupByProvider(buildModelOptions(config, null))).toMatchObject([
      {
        providerKey: "codex",
        providerLabel: "Codex",
        models: [
          { key: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", isLegacy: false },
          { key: "codex:gpt-5.4", label: "GPT-5.4", isLegacy: true },
        ],
      },
    ]);
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed)).toBeNull();
    // No config (environment offline) — nothing to validate against.
    expect(resolveSelectableModelSelection(null, disabled)).toBe(disabled);
  });

  it("keeps legacy models out of implicit defaults", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

    expect(resolveDefaultableModelSelection(config, current)).toBe(current);
    // A legacy last-used selection falls through to the provider default.
    expect(resolveDefaultableModelSelection(config, legacy)).toBeNull();
    // Offline: nothing to validate against, selection passes through.
    expect(resolveDefaultableModelSelection(null, legacy)).toBe(legacy);
  });
});

describe("Prime model snapshot behavior", () => {
  const config = {
    providers: [
      {
        instanceId: "prime-a",
        driver: "prime-agent",
        displayName: "Prime A",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        version: "1",
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00Z",
        models: [
          {
            slug: "reasoner",
            name: "Reasoner",
            isCustom: false,
            availability: "available",
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Thinking",
                  type: "select",
                  options: [{ id: "high", label: "High" }],
                },
              ],
            },
          },
        ],
        slashCommands: [],
        skills: [],
      },
      {
        instanceId: "prime-b",
        driver: "prime-agent",
        displayName: "Prime B",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        version: "1",
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00Z",
        models: [
          {
            slug: "reasoner",
            name: "Reasoner",
            isCustom: false,
            availability: "stale",
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ],
  } as unknown as ServerConfig;
  it("keeps duplicate names distinct and exposes descriptor labels", () => {
    const options = buildModelOptions(config, null);
    expect(options.map((x) => x.key)).toEqual(["prime-a:reasoner", "prime-b:reasoner"]);
    expect(modelCapabilityLabels(options[0]!.capabilities)).toEqual(["Thinking"]);
  });
  it("retains exact bound selection when stale", () => {
    const selection = { instanceId: ProviderInstanceId.make("prime-b"), model: "reasoner" };
    expect(getModelSelectionAvailability(config, selection)).toEqual({
      available: false,
      reason: "model-unavailable",
    });
    expect(buildModelOptions(config, selection).at(-1)?.selection).toEqual(selection);
  });
  it("does not reject selection offline", () => {
    const selection = { instanceId: ProviderInstanceId.make("prime-a"), model: "reasoner" };
    expect(getModelSelectionAvailability(null, selection)).toEqual({
      available: true,
      instanceId: "prime-a",
      model: "reasoner",
    });
  });
});
