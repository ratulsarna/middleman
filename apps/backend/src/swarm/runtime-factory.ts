import { resolve } from "node:path";
import { ClaudeAgentSdkRuntime } from "./claude-agent-sdk-runtime.js";
import { readClaudeOutputStyleLenient } from "./claude-output-style-settings.js";
import { CodexAgentRuntime } from "./codex-agent-runtime.js";
import { MANDATORY_MANAGER_OPERATIONAL_PREAMBLE } from "./manager-mandatory-preamble.js";
import { DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS } from "./model-preset-config.js";
import type { RuntimeErrorEvent, RuntimeSessionEvent, SwarmAgentRuntime } from "./runtime-types.js";
import { buildSwarmTools, type SwarmToolHost } from "./swarm-tools.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  SwarmConfig
} from "./types.js";

const CLAUDE_PROJECT_AND_LOCAL_SETTINGS_POLICY = Object.freeze({
  primarySources: ["local", "project"] as const,
  fallbackSources: [] as const,
  enableFallbackOnReadError: true
});

interface RuntimeFactoryDependencies {
  host: SwarmToolHost;
  config: SwarmConfig;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  getSwarmContextFiles: (cwd: string) => Promise<Array<{ path: string; content: string }>>;
  callbacks: {
    onStatusChange: (
      agentId: string,
      status: AgentStatus,
      pendingCount: number,
      contextUsage?: AgentContextUsage
    ) => Promise<void>;
    onSessionEvent: (agentId: string, event: RuntimeSessionEvent) => Promise<void>;
    onAgentEnd: (agentId: string) => Promise<void>;
    onRuntimeError: (agentId: string, error: RuntimeErrorEvent) => Promise<void>;
  };
}

export class RuntimeFactory {
  constructor(private readonly deps: RuntimeFactoryDependencies) {}

  async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    if (isClaudeAgentSdkModelDescriptor(descriptor.model)) {
      return this.createClaudeAgentSdkRuntimeForDescriptor(descriptor, systemPrompt);
    }

    if (isCodexAppServerModelDescriptor(descriptor.model)) {
      return this.createCodexRuntimeForDescriptor(descriptor, systemPrompt);
    }

    throw new Error(
      `Unsupported provider "${descriptor.model.provider}". ` +
        `Only "claude-agent-sdk" and "openai-codex-app-server" are supported.`
    );
  }

  private async createCodexRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = buildSwarmTools(this.deps.host, descriptor);
    const swarmContextFiles = await this.deps.getSwarmContextFiles(descriptor.cwd);

    const codexSystemPrompt = this.buildRuntimeSystemPrompt(systemPrompt, {
      swarmContextFiles
    });

    this.deps.logDebug("runtime:create:start", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd
    });

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.deps.callbacks.onStatusChange(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.deps.callbacks.onSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.deps.callbacks.onAgentEnd(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.deps.callbacks.onRuntimeError(agentId, error);
        }
      },
      now: this.deps.now,
      systemPrompt: codexSystemPrompt,
      tools: swarmTools,
      runtimeEnv: {
        SWARM_DATA_DIR: this.deps.config.paths.dataDir
      },
      thinkingLevelToEffort:
        this.deps.config.providerThinkingLevelMappings?.codexAppServer ??
        DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS.codexAppServer
    });

    this.deps.logDebug("runtime:create:ready", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      systemPromptPreview: previewForLog(codexSystemPrompt, 240)
    });

    return runtime;
  }

  private async createClaudeAgentSdkRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = buildSwarmTools(this.deps.host, descriptor);
    const swarmContextFiles = await this.deps.getSwarmContextFiles(descriptor.cwd);
    const managerHasSelectedOutputStyle = await this.readManagerClaudeOutputStyleSelection(descriptor);
    const claudeSystemPrompt = this.buildRuntimeSystemPrompt(
      managerHasSelectedOutputStyle ? MANDATORY_MANAGER_OPERATIONAL_PREAMBLE : systemPrompt,
      {
        swarmContextFiles
      }
    );

    this.deps.logDebug("runtime:create:start", {
      runtime: "claude-agent-sdk",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd,
      managerHasSelectedOutputStyle: descriptor.role === "manager" ? managerHasSelectedOutputStyle : undefined
    });

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.deps.callbacks.onStatusChange(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.deps.callbacks.onSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.deps.callbacks.onAgentEnd(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.deps.callbacks.onRuntimeError(agentId, error);
        }
      },
      now: this.deps.now,
      systemPrompt: claudeSystemPrompt,
      useClaudeCodeSystemPromptPreset: !managerHasSelectedOutputStyle,
      tools: swarmTools,
      authFile: this.deps.config.paths.authFile,
      runtimeEnv: {
        SWARM_DATA_DIR: this.deps.config.paths.dataDir,
        CLAUDE_CONFIG_DIR: resolve(this.deps.config.paths.dataDir, "claude-code")
      },
      thinkingLevelToConfig:
        this.deps.config.providerThinkingLevelMappings?.claudeAgentSdk ??
        DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS.claudeAgentSdk,
      settingsPolicy: {
        primarySources: [...CLAUDE_PROJECT_AND_LOCAL_SETTINGS_POLICY.primarySources],
        fallbackSources: [...CLAUDE_PROJECT_AND_LOCAL_SETTINGS_POLICY.fallbackSources],
        enableFallbackOnReadError: CLAUDE_PROJECT_AND_LOCAL_SETTINGS_POLICY.enableFallbackOnReadError
      }
    });

    this.deps.logDebug("runtime:create:ready", {
      runtime: "claude-agent-sdk",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      systemPromptPreview: previewForLog(claudeSystemPrompt, 240)
    });

    return runtime;
  }

  private buildRuntimeSystemPrompt(
    baseSystemPrompt: string,
    options: {
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): string {
    const sections: string[] = [];

    const trimmedBase = baseSystemPrompt.trim();
    if (trimmedBase.length > 0) {
      sections.push(trimmedBase);
    }

    for (const contextFile of options.swarmContextFiles) {
      const content = contextFile.content.trim();
      if (!content) {
        continue;
      }

      sections.push(
        [
          `Repository swarm policy (${contextFile.path}):`,
          "----- BEGIN SWARM CONTEXT -----",
          content,
          "----- END SWARM CONTEXT -----"
        ].join("\n")
      );
    }

    return sections.join("\n\n");
  }

  private async readManagerClaudeOutputStyleSelection(descriptor: AgentDescriptor): Promise<boolean> {
    if (descriptor.role !== "manager") {
      return false;
    }

    const settingsResult = await readClaudeOutputStyleLenient(descriptor.cwd);
    if (settingsResult.warning) {
      this.deps.logDebug("runtime:warning", {
        runtime: "claude-agent-sdk",
        event: "output_style_settings_read_warning",
        agentId: descriptor.agentId,
        warning: settingsResult.warning
      });
    }

    return Boolean(settingsResult.outputStyle);
  }
}

function isCodexAppServerModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "openai-codex-app-server";
}

function isClaudeAgentSdkModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "claude-agent-sdk";
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
