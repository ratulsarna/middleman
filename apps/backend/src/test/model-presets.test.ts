import { describe, expect, it } from "vitest";
import { DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS } from "../swarm/model-preset-config.js";
import type { SwarmModelPresetDefinitions } from "../swarm/types.js";
import {
  inferSwarmModelPresetFromDescriptor,
  normalizeSwarmModelDescriptor,
  resolveModelDescriptorFromPreset
} from "../swarm/model-presets.js";

describe("model-presets", () => {
  it("maps legacy anthropic descriptor alias to pi-opus", () => {
    expect(
      inferSwarmModelPresetFromDescriptor({
        provider: "anthropic",
        modelId: "claude-opus-4.6"
      })
    ).toBe("pi-opus");
  });

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
        provider: "anthropic",
        modelId: "claude-opus-4.6"
      })
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      thinkingLevel: "xhigh"
    });

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
      "pi-codex": {
        descriptor: {
          provider: "openai-codex",
          modelId: "gpt-5.4-codex",
          thinkingLevel: "high"
        }
      }
    };

    expect(
      resolveModelDescriptorFromPreset("pi-codex", {
        presetDefinitions: customPresetDefinitions
      })
    ).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.4-codex",
      thinkingLevel: "high"
    });

    expect(
      inferSwarmModelPresetFromDescriptor(
        {
          provider: "openai-codex",
          modelId: "gpt-5.4-codex"
        },
        {
          presetDefinitions: customPresetDefinitions
        }
      )
    ).toBe("pi-codex");
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
