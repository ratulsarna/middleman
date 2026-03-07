import { describe, expect, it, vi } from "vitest";

import { ManagerModelCatalogService, parseCodexModelListData } from "../swarm/manager-model-catalog.js";

describe("ManagerModelCatalogService", () => {
  it("builds provider catalogs with claude-agent-sdk and codex-app-server providers", async () => {
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
      "claude-agent-sdk",
      "openai-codex-app-server"
    ]);

    const claudeAgentSdk = catalog.providers[0];
    expect(claudeAgentSdk.surfaces).toEqual(["create_manager", "manager_settings", "spawn_default"]);
    expect(claudeAgentSdk.models).toEqual([
      {
        modelId: "claude-opus-4-6",
        modelLabel: "Claude Opus 4.6",
        allowedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        defaultThinkingLevel: "xhigh"
      }
    ]);

    const codexAppServer = catalog.providers[1];
    expect(codexAppServer.surfaces).toEqual(["create_manager", "manager_settings", "spawn_default"]);
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
    expect(first.providers[1]?.models[0]?.modelId).toBe("codex-live");
    expect(second.providers[1]?.models[0]?.modelId).toBe("codex-live");

    now = new Date("2026-01-01T00:00:30.000Z");
    await service.getCatalog();
    expect(probe).toHaveBeenCalledTimes(1);

    now = new Date("2026-01-01T00:02:00.000Z");
    probe.mockRejectedValueOnce(new Error("probe unavailable"));
    const stale = await service.getCatalog();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(stale.providers[1]?.models[0]?.modelId).toBe("codex-live");
    expect(stale.warnings?.join(" ")).toContain("stale cached");
  });

  it("uses fallback codex model catalog when probe fails without cache", async () => {
    const service = new ManagerModelCatalogService({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      probeCodexModelListData: async () => {
        throw new Error("codex unavailable");
      }
    });

    const catalog = await service.getCatalog();
    expect(catalog.providers[1]?.models).toEqual([
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
