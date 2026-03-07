import type {
  ProviderThinkingLevelMappings,
  SwarmModelPresetDefinitions
} from "./types.js";

export const DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS: SwarmModelPresetDefinitions = {
  "codex-app": {
    descriptor: {
      provider: "openai-codex-app-server",
      modelId: "default",
      thinkingLevel: "xhigh"
    },
    aliases: [
      { provider: "openai-codex-app-server", modelId: "codex-app" },
      { provider: "openai-codex-app-server", modelId: "codex-app-server" }
    ]
  },
  "claude-agent-sdk": {
    descriptor: {
      provider: "claude-agent-sdk",
      modelId: "claude-opus-4-6",
      thinkingLevel: "xhigh"
    }
  }
};

export const DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS: ProviderThinkingLevelMappings = {
  codexAppServer: {
    off: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh"
  },
  claudeAgentSdk: {
    off: { thinking: "disabled" },
    minimal: { thinking: "enabled", effort: "low" },
    low: { thinking: "enabled", effort: "low" },
    medium: { thinking: "enabled", effort: "medium" },
    high: { thinking: "enabled", effort: "high" },
    xhigh: { thinking: "enabled", effort: "max" }
  },
};

