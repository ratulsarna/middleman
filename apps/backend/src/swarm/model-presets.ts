import { DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS } from "./model-preset-config.js";
import type {
  AgentModelDescriptor,
  SwarmModelPreset,
  SwarmModelPresetDefinitions
} from "./types.js";
import { SWARM_MODEL_PRESETS } from "./types.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";

interface ModelPresetOptions {
  presetDefinitions?: SwarmModelPresetDefinitions;
}

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

function resolvePresetDefinitions(options?: ModelPresetOptions): SwarmModelPresetDefinitions {
  return options?.presetDefinitions ?? DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS;
}

function normalizeModelIdentity(
  identity: Pick<AgentModelDescriptor, "provider" | "modelId">
): {
  provider: string;
  modelId: string;
} | undefined {
  const provider =
    typeof identity.provider === "string" ? identity.provider.trim().toLowerCase() : "";
  const modelId =
    typeof identity.modelId === "string" ? identity.modelId.trim().toLowerCase() : "";
  if (!provider || !modelId) {
    return undefined;
  }

  return {
    provider,
    modelId
  };
}

function modelIdentityMatches(
  left: Pick<AgentModelDescriptor, "provider" | "modelId">,
  right: Pick<AgentModelDescriptor, "provider" | "modelId">
): boolean {
  const normalizedLeft = normalizeModelIdentity(left);
  const normalizedRight = normalizeModelIdentity(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft.provider === normalizedRight.provider && normalizedLeft.modelId === normalizedRight.modelId
  );
}

export function resolveModelDescriptorFromPreset(
  preset: SwarmModelPreset,
  options?: ModelPresetOptions
): AgentModelDescriptor {
  const definition = resolvePresetDefinitions(options)[preset];
  return {
    provider: definition.descriptor.provider,
    modelId: definition.descriptor.modelId,
    thinkingLevel: definition.descriptor.thinkingLevel
  };
}

export function inferSwarmModelPresetFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
  options?: ModelPresetOptions
): SwarmModelPreset | undefined {
  if (!descriptor) {
    return undefined;
  }

  const presetDefinitions = resolvePresetDefinitions(options);

  for (const preset of SWARM_MODEL_PRESETS) {
    const definition = presetDefinitions[preset];
    if (modelIdentityMatches(descriptor, definition.descriptor)) {
      return preset;
    }

    const aliases = definition.aliases ?? [];
    if (aliases.some((alias) => modelIdentityMatches(descriptor, alias))) {
      return preset;
    }
  }

  return undefined;
}

export function normalizeSwarmModelDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
  options?: ModelPresetOptions
): AgentModelDescriptor {
  const preset = inferSwarmModelPresetFromDescriptor(descriptor, options);
  if (!preset) {
    const provider =
      typeof descriptor?.provider === "string" ? descriptor.provider.trim() || "<missing>" : "<missing>";
    const modelId =
      typeof descriptor?.modelId === "string" ? descriptor.modelId.trim() || "<missing>" : "<missing>";
    throw new Error(
      `Unsupported model descriptor ${provider}/${modelId}. ` +
        `Use one of ${describeSwarmModelPresets()} or recreate the agent.`
    );
  }

  return resolveModelDescriptorFromPreset(preset, options);
}
