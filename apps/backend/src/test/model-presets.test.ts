import { describe, expect, it } from "vitest";
import { DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS } from "../swarm/model-preset-config.js";
import type { SwarmModelPresetDefinitions } from "../swarm/types.js";
import {
  inferSwarmModelPresetFromDescriptor,
  normalizeSwarmModelDescriptor,
  resolveModelDescriptorFromPreset
} from "../swarm/model-presets.js";

describe("model-presets", () => {
  it("maps legacy codex-app descriptor aliases to codex-app", () => {
    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: "openai-codex-app-server",
        modelId: "codex-app"
      })
    ).toBe("codex-app");

    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: "openai-codex-app-server",
        modelId: "codex-app-server"
      })
    ).toBe("codex-app");
  });

  it("normalizes legacy aliases to canonical descriptors", () => {
    expect(
      normalizeSwarmModelDescriptor({
        provider: "openai-codex-app-server",
        modelId: "codex-app"
      })
    ).toEqual({
      provider: "openai-codex-app-server",
      modelId: "default",
      thinkingLevel: "xhigh"
    });
  });

  it("supports config-driven descriptor overrides for canonical presets", () => {
    const customPresetDefinitions: SwarmModelPresetDefinitions = {
      ...DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS,
      "codex-app": {
        descriptor: {
          provider: "openai-codex-app-server",
          modelId: "custom-model",
          thinkingLevel: "high"
        }
      }
    };

    expect(
      resolveModelDescriptorFromPreset("codex-app", {
        presetDefinitions: customPresetDefinitions
      })
    ).toEqual({
      provider: "openai-codex-app-server",
      modelId: "custom-model",
      thinkingLevel: "high"
    });

    expect(
      inferSwarmModelPresetFromDescriptor(
        {
          provider: "openai-codex-app-server",
          modelId: "custom-model"
        },
        {
          presetDefinitions: customPresetDefinitions
        }
      )
    ).toBe("codex-app");
  });

  it("handles malformed descriptor fields without throwing raw type errors", () => {
    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: undefined as unknown as string,
        modelId: "default"
      })
    ).toBeUndefined();

    expect(() =>
      normalizeSwarmModelDescriptor({
        provider: undefined as unknown as string,
        modelId: "default"
      })
    ).toThrow("Unsupported model descriptor");

    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: 123 as unknown as string,
        modelId: "default"
      })
    ).toBeUndefined();

    expect(() =>
      normalizeSwarmModelDescriptor({
        provider: 123 as unknown as string,
        modelId: "default"
      })
    ).toThrow("Unsupported model descriptor");

    expect(() =>
      normalizeSwarmModelDescriptor({
        provider: "openai-codex-app-server",
        modelId: { bad: true } as unknown as string
      })
    ).toThrow("Unsupported model descriptor");
  });
});
