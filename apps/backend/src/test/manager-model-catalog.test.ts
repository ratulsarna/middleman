import { beforeEach, describe, expect, it, vi } from "vitest";

const piAiMockState = vi.hoisted(() => ({
  modelsByProvider: {} as Record<string, Array<{ id: string; name?: string; reasoning?: boolean; xhigh?: boolean }>>
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModels: (provider: string) => {
    return piAiMockState.modelsByProvider[provider] ?? [];
  },
  supportsXhigh: (model: { xhigh?: unknown }) => {
    return model?.xhigh === true;
  }
}));

import { ManagerModelCatalogService, parseCodexModelListData } from "../swarm/manager-model-catalog.js";

describe("ManagerModelCatalogService", () => {
  beforeEach(() => {
    piAiMockState.modelsByProvider = {
      "openai-codex": [],
      anthropic: []
    };
  });

  it("builds provider catalogs with capability-filtered thinking options and deterministic ordering", async () => {
    piAiMockState.modelsByProvider = {
      "openai-codex": [
        { id: "gpt-reason", name: "GPT Reason", reasoning: true, xhigh: false },
        { id: "gpt-no-reason", name: "GPT No Reason", reasoning: false, xhigh: false },
        { id: "gpt-xhigh", name: "GPT XHigh", reasoning: true, xhigh: true },
        { id: "GPT-XHIGH", name: "Duplicate XHigh", reasoning: true, xhigh: true }
      ],
      anthropic: [
        { id: "claude-z", name: "Claude Z", reasoning: true, xhigh: false },
        { id: "claude-a", name: "Claude A", reasoning: false, xhigh: false }
      ]
    };

    const service = new ManagerModelCatalogService({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      probeCodexModelListData: async () => [
        {
          id: "codex-beta",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "xhigh" }],
          defaultReasoningEffort: "low"
        },
        {
          model: "codex-alpha",
          supported_reasoning_efforts: ["none", "medium"],
          default_reasoning_effort: "medium"
        }
      ]
    });

    const catalog = await service.getCatalog();
    expect(catalog.fetchedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(catalog.providers.map((provider) => provider.provider)).toEqual([
      "openai-codex",
      "anthropic",
      "claude-agent-sdk",
      "openai-codex-app-server"
    ]);

    const openaiCodex = catalog.providers[0];
    expect(openaiCodex.models.map((model) => model.modelId)).toEqual([
      "gpt-no-reason",
      "gpt-reason",
      "gpt-xhigh"
    ]);
    expect(openaiCodex.models[0]).toMatchObject({
      modelId: "gpt-no-reason",
      allowedThinkingLevels: ["off"],
      defaultThinkingLevel: "off"
    });
    expect(openaiCodex.models[1]).toMatchObject({
      modelId: "gpt-reason",
      allowedThinkingLevels: ["off", "minimal", "low", "medium", "high"],
      defaultThinkingLevel: "high"
    });
    expect(openaiCodex.models[2]).toMatchObject({
      modelId: "gpt-xhigh",
      allowedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      defaultThinkingLevel: "xhigh"
    });

    const anthropic = catalog.providers[1];
    expect(anthropic.models.map((model) => model.modelId)).toEqual(["claude-a", "claude-z"]);

    const claudeAgentSdk = catalog.providers[2];
    expect(claudeAgentSdk.models).toEqual(anthropic.models);

    const codexAppServer = catalog.providers[3];
    expect(codexAppServer.surfaces).toEqual(["manager_settings", "spawn_default"]);
    expect(codexAppServer.models).toEqual([
      {
        modelId: "codex-alpha",
        modelLabel: "codex-alpha",
        allowedThinkingLevels: ["off", "medium"],
        defaultThinkingLevel: "medium"
      },
      {
        modelId: "codex-beta",
        modelLabel: "codex-beta",
        allowedThinkingLevels: ["low", "xhigh"],
        defaultThinkingLevel: "low"
      }
    ]);
  });

  it("deduplicates concurrent codex probes, serves cached data within TTL, and falls back to stale cache on failure", async () => {
    piAiMockState.modelsByProvider = {
      "openai-codex": [{ id: "gpt-model", reasoning: true, xhigh: true }],
      anthropic: [{ id: "claude-model", reasoning: true, xhigh: false }]
    };

    let now = new Date("2026-01-01T00:00:00.000Z");
    const probe = vi.fn(async () => {
      return [
        {
          id: "codex-live",
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high"
        }
      ];
    });

    const service = new ManagerModelCatalogService({
      now: () => now,
      codexProbeTtlMs: 60_000,
      probeCodexModelListData: probe
    });

    const [first, second] = await Promise.all([service.getCatalog(), service.getCatalog()]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(first.providers[3]?.models[0]?.modelId).toBe("codex-live");
    expect(second.providers[3]?.models[0]?.modelId).toBe("codex-live");

    now = new Date("2026-01-01T00:00:30.000Z");
    await service.getCatalog();
    expect(probe).toHaveBeenCalledTimes(1);

    now = new Date("2026-01-01T00:02:00.000Z");
    probe.mockRejectedValueOnce(new Error("probe unavailable"));
    const stale = await service.getCatalog();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(stale.providers[3]?.models[0]?.modelId).toBe("codex-live");
    expect(stale.warnings?.join(" ")).toContain("stale cached");
  });

  it("uses fallback codex model catalog when probe fails without cache", async () => {
    piAiMockState.modelsByProvider = {
      "openai-codex": [{ id: "gpt-model", reasoning: true, xhigh: true }],
      anthropic: [{ id: "claude-model", reasoning: true, xhigh: false }]
    };

    const service = new ManagerModelCatalogService({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      probeCodexModelListData: async () => {
        throw new Error("codex unavailable");
      }
    });

    const catalog = await service.getCatalog();
    expect(catalog.providers[3]?.models).toEqual([
      {
        modelId: "default",
        modelLabel: "default",
        allowedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        defaultThinkingLevel: "xhigh"
      }
    ]);
    expect(catalog.warnings?.join(" ")).toContain("fallback model catalog");
  });
});

describe("parseCodexModelListData", () => {
  it("parses mixed codex payload shapes and ignores malformed entries", () => {
    const parsed = parseCodexModelListData({
      data: [
        {
          id: "codex-camel",
          supportedReasoningEfforts: [{ reasoningEffort: "minimal" }, { reasoning_effort: "high" }],
          defaultReasoningEffort: "high"
        },
        {
          model: "codex-snake",
          supported_reasoning_efforts: ["none", "medium"],
          default_reasoning_effort: "medium"
        },
        {
          id: "codex-default-only",
          defaultReasoningEffort: "low"
        },
        {
          id: "codex-invalid",
          supportedReasoningEfforts: ["unknown"]
        },
        {
          id: "CODEX-CAMEL",
          supportedReasoningEfforts: ["xhigh"]
        }
      ]
    });

    expect(parsed).toEqual([
      {
        modelId: "codex-camel",
        modelLabel: "codex-camel",
        allowedThinkingLevels: ["minimal", "high"],
        defaultThinkingLevel: "high"
      },
      {
        modelId: "codex-default-only",
        modelLabel: "codex-default-only",
        allowedThinkingLevels: ["low"],
        defaultThinkingLevel: "low"
      },
      {
        modelId: "codex-snake",
        modelLabel: "codex-snake",
        allowedThinkingLevels: ["off", "medium"],
        defaultThinkingLevel: "medium"
      }
    ]);
  });
});
