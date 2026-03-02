import type { AgentModelDescriptor, SwarmModelPreset } from "./types.js";
import { SWARM_MODEL_PRESETS } from "./types.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";

const MODEL_PRESET_DESCRIPTORS: Record<SwarmModelPreset, AgentModelDescriptor> = {
  "pi-codex": {
    provider: "openai-codex",
    modelId: "gpt-5.3-codex",
    thinkingLevel: "xhigh"
  },
  "pi-opus": {
    // Anthropic OAuth tokens trigger Claude Code auth headers in pi-ai,
    // matching the existing Claude Code integration path.
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    thinkingLevel: "xhigh"
  },
  "codex-app": {
    provider: "openai-codex-app-server",
    modelId: "default",
    thinkingLevel: "xhigh"
  },
  "claude-agent-sdk": {
    provider: "claude-agent-sdk",
    modelId: "claude-opus-4-6",
    thinkingLevel: "xhigh"
  }
};

const VALID_SWARM_MODEL_PRESET_VALUES = new Set<string>(SWARM_MODEL_PRESETS);

export function describeSwarmModelPresets(): string {
  return SWARM_MODEL_PRESETS.join("|");
}

export function isSwarmModelPreset(value: unknown): value is SwarmModelPreset {
  return typeof value === "string" && VALID_SWARM_MODEL_PRESET_VALUES.has(value);
}

export function parseSwarmModelPreset(value: unknown, fieldName: string): SwarmModelPreset | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSwarmModelPreset(value)) {
    throw new Error(`${fieldName} must be one of ${describeSwarmModelPresets()}`);
  }

  return value;
}

export function resolveModelDescriptorFromPreset(preset: SwarmModelPreset): AgentModelDescriptor {
  const descriptor = MODEL_PRESET_DESCRIPTORS[preset];
  return {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    thinkingLevel: descriptor.thinkingLevel
  };
}

export function inferSwarmModelPresetFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined
): SwarmModelPreset | undefined {
  if (!descriptor) {
    return undefined;
  }

  const provider = descriptor.provider?.trim().toLowerCase();
  const modelId = descriptor.modelId?.trim().toLowerCase();

  if (provider === "openai-codex" && modelId === "gpt-5.3-codex") {
    return "pi-codex";
  }

  if (provider === "anthropic" && modelId === "claude-opus-4-6") {
    return "pi-opus";
  }

  // Legacy Anthropic model id alias.
  if (provider === "anthropic" && modelId === "claude-opus-4.6") {
    return "pi-opus";
  }

  if (provider === "openai-codex-app-server" && modelId === "default") {
    return "codex-app";
  }

  // Legacy codex-app model id aliases.
  if (
    provider === "openai-codex-app-server" &&
    (modelId === "codex-app" || modelId === "codex-app-server")
  ) {
    return "codex-app";
  }

  if (provider === "claude-agent-sdk" && modelId === "claude-opus-4-6") {
    return "claude-agent-sdk";
  }

  return undefined;
}

export function normalizeSwarmModelDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined
): AgentModelDescriptor {
  const preset = inferSwarmModelPresetFromDescriptor(descriptor);
  if (!preset) {
    const provider = descriptor?.provider?.trim() || "<missing>";
    const modelId = descriptor?.modelId?.trim() || "<missing>";
    throw new Error(
      `Unsupported model descriptor ${provider}/${modelId}. ` +
        `Use one of ${describeSwarmModelPresets()} or recreate the agent.`
    );
  }

  return resolveModelDescriptorFromPreset(preset);
}
