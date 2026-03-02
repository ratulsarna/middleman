import { describe, expect, it } from "vitest";
import {
  inferSwarmModelPresetFromDescriptor,
  normalizeSwarmModelDescriptor
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
});
