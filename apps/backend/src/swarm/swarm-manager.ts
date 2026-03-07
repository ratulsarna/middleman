import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServerEvent } from "@nexus/protocol";

import {
  loadArchetypePromptRegistry,
  normalizeArchetypeId,
  type ArchetypePromptRegistry
} from "./archetypes/archetype-prompt-registry.js";
import { ConversationProjector } from "./conversation-projector.js";
import { PersistenceService } from "./persistence-service.js";
import { RuntimeFactory } from "./runtime-factory.js";
import { SecretsEnvService } from "./secrets-env-service.js";
import { prependMandatoryManagerOperationalPreamble } from "./manager-mandatory-preamble.js";
import {
  listDirectories,
  normalizeAllowlistRoots,
  validateDirectory as validateDirectoryInput,
  validateDirectoryPath,
  type DirectoryListingResult,
  type DirectoryValidationResult
} from "./cwd-policy.js";
import { pickDirectory as pickNativeDirectory } from "./directory-picker.js";
import {
  isConversationBinaryAttachment,
  isConversationImageAttachment,
  isConversationTextAttachment
} from "./conversation-validators.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
} from "./message-utils.js";
import {
  DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS,
  DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS
} from "./model-preset-config.js";
import {
  DEFAULT_SWARM_MODEL_PRESET,
  inferSwarmModelPresetFromDescriptor,
  parseSwarmModelPreset,
  resolveModelDescriptorFromPreset
} from "./model-presets.js";
import {
  isNonRunningAgentStatus,
  normalizeAgentStatus,
  transitionAgentStatus,
  type AgentStatusInput
} from "./agent-state-machine.js";
import type {
  RuntimeImageAttachment,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  SwarmAgentRuntime
} from "./runtime-types.js";
import type { SwarmToolHost } from "./swarm-tools.js";
import { THINKING_LEVELS } from "./types.js";
import type {
  AgentMessageEvent,
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  AgentStatusEvent,
  AgentsSnapshotEvent,
  AgentsStoreFile,
  ConversationAttachment,
  ConversationBinaryAttachment,
  ConversationEntryEvent,
  ConversationMessageEvent,
  ConversationTextAttachment,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SettingsAuthProvider,
  SpawnAgentInput,
  SwarmConfig,
  SwarmModelPresetDefinitions,
  SwarmModelPreset,
  ThinkingLevel
} from "./types.js";

function buildWorkerSystemPrompt(managerId: string | undefined): string {
  const managerLine = managerId
    ? `Your manager is "${managerId}". To communicate with them (results, questions, clarifications, status updates, or anything else), call the send_message_to_agent tool with targetAgentId="${managerId}". Text output alone does not reach the manager.`
    : `To communicate with the manager (results, questions, clarifications, status updates, or anything else), call the send_message_to_agent tool. Text output alone does not reach the manager.`;

  return `# Runtime context — you are a WORKER in a multi-agent swarm

You were spawned by a manager agent to carry out a specific task. You are NOT running as a standalone assistant — you are part of a coordinated swarm where a manager delegates work to workers like you.

## How communication works
- Your text output is visible to the user for transparency, but the user's main conversation is with the manager, not with you directly. Do not talk to the user directly unless the user talks to you.
- ${managerLine}
- You can call list_agents to discover other agents in the swarm.

## Messages you receive
- Messages prefixed with "SYSTEM:" are internal control messages from the swarm runtime.
- Task instructions come from the manager agent who spawned you.`;
}
const MANAGER_ARCHETYPE_ID = "manager";
const MERGER_ARCHETYPE_ID = "merger";
const INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: ";
const CROSS_MANAGER_RATE_WINDOW_MS = 60_000;
const CROSS_MANAGER_RATE_LIMIT = 20;
// Retain recent non-web activity while preserving the full user-facing web transcript.
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;
const VALID_THINKING_LEVEL_VALUES = new Set<string>(THINKING_LEVELS);

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyArchetypePromptRegistry(): ArchetypePromptRegistry {
  return {
    resolvePrompt: () => undefined,
    listArchetypeIds: () => []
  };
}

function cloneContextUsage(contextUsage: AgentContextUsage | undefined): AgentContextUsage | undefined {
  if (!contextUsage) {
    return undefined;
  }

  return {
    tokens: contextUsage.tokens,
    contextWindow: contextUsage.contextWindow,
    percent: contextUsage.percent
  };
}

function cloneDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    model: { ...descriptor.model },
    spawnDefaultModel: descriptor.spawnDefaultModel
      ? { ...descriptor.spawnDefaultModel }
      : undefined,
    contextUsage: cloneContextUsage(descriptor.contextUsage)
  };
}

function normalizeContextUsage(contextUsage: AgentContextUsage | undefined): AgentContextUsage | undefined {
  if (!contextUsage) {
    return undefined;
  }

  if (
    typeof contextUsage.tokens !== "number" ||
    !Number.isFinite(contextUsage.tokens) ||
    contextUsage.tokens < 0
  ) {
    return undefined;
  }

  if (
    typeof contextUsage.contextWindow !== "number" ||
    !Number.isFinite(contextUsage.contextWindow) ||
    contextUsage.contextWindow <= 0
  ) {
    return undefined;
  }

  if (typeof contextUsage.percent !== "number" || !Number.isFinite(contextUsage.percent)) {
    return undefined;
  }

  return {
    tokens: Math.round(contextUsage.tokens),
    contextWindow: Math.max(1, Math.round(contextUsage.contextWindow)),
    percent: Math.max(0, Math.min(100, contextUsage.percent))
  };
}

function areContextUsagesEqual(
  left: AgentContextUsage | undefined,
  right: AgentContextUsage | undefined
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.tokens === right.tokens &&
    left.contextWindow === right.contextWindow &&
    left.percent === right.percent
  );
}

export class SwarmManager extends EventEmitter implements SwarmToolHost {
  private readonly config: SwarmConfig;
  private readonly now: () => string;
  private readonly defaultModelPreset: SwarmModelPreset;
  private readonly modelPresetDefinitions: typeof DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS;

  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly runtimes = new Map<string, SwarmAgentRuntime>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly crossManagerMessageLog = new Map<string, number[]>();
  private readonly conversationProjector: ConversationProjector;
  private readonly persistenceService: PersistenceService;
  private readonly runtimeFactory: RuntimeFactory;
  private readonly secretsEnvService: SecretsEnvService;

  private archetypePromptRegistry: ArchetypePromptRegistry = createEmptyArchetypePromptRegistry();

  constructor(config: SwarmConfig, options?: { now?: () => string }) {
    super();

    this.modelPresetDefinitions = config.modelPresetDefinitions ?? DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS;
    this.defaultModelPreset =
      inferSwarmModelPresetFromDescriptor(config.defaultModel, {
        presetDefinitions: this.modelPresetDefinitions
      }) ?? DEFAULT_SWARM_MODEL_PRESET;
    this.config = {
      ...config,
      modelPresetDefinitions: this.modelPresetDefinitions,
      providerThinkingLevelMappings:
        config.providerThinkingLevelMappings ?? DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS,
      defaultModel: resolveModelDescriptorFromPreset(this.defaultModelPreset, {
        presetDefinitions: this.modelPresetDefinitions
      })
    };
    this.now = options?.now ?? nowIso;
    this.persistenceService = new PersistenceService({
      config: this.config,
      descriptors: this.descriptors,
      sortedDescriptors: () => this.sortedDescriptors(),
      validateAgentDescriptor,
      extractDescriptorAgentId,
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.conversationProjector = new ConversationProjector({
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      conversationEntriesByAgentId: this.conversationEntriesByAgentId,
      now: this.now,
      emitServerEvent: (eventName, payload) => {
        this.emit(eventName, payload);
      },
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.secretsEnvService = new SecretsEnvService({
      config: this.config
    });
    this.runtimeFactory = new RuntimeFactory({
      host: this,
      config: this.config,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      getSwarmContextFiles: async (cwd) => this.getSwarmContextFiles(cwd),
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.handleRuntimeStatus(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.handleRuntimeSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.handleRuntimeAgentEnd(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.handleRuntimeError(agentId, error);
        }
      }
    });
    this.setMaxListeners(SWARM_MANAGER_MAX_EVENT_LISTENERS);
  }

  async boot(): Promise<void> {
    this.logDebug("boot:start", {
      host: this.config.host,
      port: this.config.port,
      authFile: this.config.paths.authFile,
      managerId: this.config.managerId
    });

    await this.ensureDirectories();

    try {
      this.config.defaultCwd = await this.resolveAndValidateCwd(this.config.defaultCwd);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Invalid default working directory: ${error.message}`);
      }
      throw error;
    }

    this.archetypePromptRegistry = await loadArchetypePromptRegistry({
      repoOverridesDir: this.config.paths.repoArchetypesDir
    });

    const loaded = await this.loadStore();
    for (const descriptor of loaded.agents) {
      this.descriptors.set(descriptor.agentId, descriptor);
    }
    this.normalizeStreamingStatusesForBoot();

    await this.saveStore();

    this.loadConversationHistoriesFromStore();
    await this.restoreRuntimesForBoot();

    const managerDescriptor = this.getBootLogManagerDescriptor();
    this.emitAgentsSnapshot();

    this.logDebug("boot:ready", {
      managerId: managerDescriptor?.agentId,
      managerStatus: managerDescriptor?.status,
      model: managerDescriptor?.model,
      cwd: managerDescriptor?.cwd,
      managerAgentDir: this.config.paths.managerAgentDir,
      managerSystemPromptSource: managerDescriptor ? `archetype:${MANAGER_ARCHETYPE_ID}` : undefined,
      loadedArchetypeIds: this.archetypePromptRegistry.listArchetypeIds(),
      restoredAgentIds: Array.from(this.runtimes.keys())
    });
  }

  listAgents(): AgentDescriptor[] {
    return this.sortedDescriptors().map((descriptor) => cloneDescriptor(descriptor));
  }

  getConversationHistory(agentId?: string): ConversationEntryEvent[] {
    const resolvedAgentId = normalizeOptionalAgentId(agentId) ?? this.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return [];
    }

    return this.conversationProjector.getConversationHistory(resolvedAgentId);
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    const manager = this.assertManager(callerAgentId, "spawn agents");

    const requestedAgentId = input.agentId?.trim();
    if (!requestedAgentId) {
      throw new Error("spawn_agent requires a non-empty agentId");
    }

    const agentId = this.generateUniqueAgentId(requestedAgentId);
    const createdAt = this.now();

    const fallback = manager.spawnDefaultModel ?? manager.model;
    const model = this.resolveSpawnModel(input, fallback);
    const archetypeId = this.resolveSpawnWorkerArchetypeId(input, agentId);

    const descriptor: AgentDescriptor = {
      agentId,
      displayName: agentId,
      role: "worker",
      managerId: manager.agentId,
      archetypeId,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: input.cwd ? await this.resolveAndValidateCwd(input.cwd) : manager.cwd,
      model,
      sessionFile: join(this.config.paths.sessionsDir, `${agentId}.jsonl`)
    };

    this.descriptors.set(agentId, descriptor);
    await this.saveStore();

    this.logDebug("agent:spawn", {
      callerAgentId,
      agentId,
      managerId: descriptor.managerId,
      displayName: descriptor.displayName,
      archetypeId: descriptor.archetypeId,
      model: descriptor.model,
      cwd: descriptor.cwd
    });

    const explicitSystemPrompt = input.systemPrompt?.trim();
    const runtimeSystemPrompt =
      explicitSystemPrompt && explicitSystemPrompt.length > 0
        ? explicitSystemPrompt
        : this.resolveSystemPromptForDescriptor(descriptor);

    const runtime = await this.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
    this.runtimes.set(agentId, runtime);

    const contextUsage = runtime.getContextUsage();
    descriptor.contextUsage = contextUsage;

    this.emitStatus(agentId, descriptor.status, runtime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();

    if (input.initialMessage && input.initialMessage.trim().length > 0) {
      await this.sendMessage(callerAgentId, agentId, input.initialMessage, "auto", { origin: "internal" });
    }

    return cloneDescriptor(descriptor);
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    const manager = this.assertManager(callerAgentId, "kill agents");

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown agent: ${targetAgentId}`);
    }
    if (target.role === "manager") {
      throw new Error("Manager cannot be killed");
    }

    if (target.managerId !== manager.agentId) {
      throw new Error(`Only owning manager can kill agent ${targetAgentId}`);
    }

    await this.terminateDescriptor(target, { abort: true, emitStatus: false });
    await this.saveStore();

    this.logDebug("agent:kill", {
      callerAgentId,
      targetAgentId,
      managerId: manager.agentId
    });

    this.emitStatus(targetAgentId, target.status, 0);
    this.emitAgentsSnapshot();
  }

  async stopAllAgents(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
    terminatedWorkerIds: string[];
    managerTerminated: boolean;
  }> {
    const manager = this.assertManager(callerAgentId, "stop all agents");

    const target = this.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    if (target.agentId !== manager.agentId) {
      throw new Error(`Only selected manager can stop all agents for ${targetManagerId}`);
    }

    const stoppedWorkerIds: string[] = [];

    for (const descriptor of Array.from(this.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      if (isNonRunningAgentStatus(descriptor.status)) {
        continue;
      }

      const runtime = this.runtimes.get(descriptor.agentId);
      if (runtime) {
        await runtime.stopInFlight({ abort: true });
      } else {
        descriptor.status = transitionAgentStatus(descriptor.status, "idle");
        descriptor.updatedAt = this.now();
        this.descriptors.set(descriptor.agentId, descriptor);
        this.emitStatus(descriptor.agentId, descriptor.status, 0, descriptor.contextUsage);
      }

      stoppedWorkerIds.push(descriptor.agentId);
    }

    let managerStopped = false;
    if (!isNonRunningAgentStatus(target.status)) {
      const managerRuntime = this.runtimes.get(target.agentId);
      if (managerRuntime) {
        await managerRuntime.stopInFlight({ abort: true });
      } else {
        target.status = transitionAgentStatus(target.status, "idle");
        target.updatedAt = this.now();
        this.descriptors.set(target.agentId, target);
        this.emitStatus(target.agentId, target.status, 0, target.contextUsage);
      }

      managerStopped = true;
    }

    await this.saveStore();
    this.emitAgentsSnapshot();

    this.logDebug("manager:stop_all", {
      callerAgentId,
      targetManagerId,
      stoppedWorkerIds,
      managerStopped
    });

    return {
      managerId: targetManagerId,
      stoppedWorkerIds,
      managerStopped,
      // Backward compatibility for older clients still expecting terminated-oriented fields.
      terminatedWorkerIds: stoppedWorkerIds,
      managerTerminated: managerStopped
    };
  }

  async createManager(
    callerAgentId: string,
    input: {
      name: string;
      cwd: string;
      model?: SwarmModelPreset;
      provider?: string;
      modelId?: string;
      thinkingLevel?: ThinkingLevel;
    }
  ): Promise<AgentDescriptor> {
    const callerDescriptor = this.descriptors.get(callerAgentId);
    if (!callerDescriptor || callerDescriptor.role !== "manager") {
      const canBootstrap = !this.hasRunningManagers();
      if (!canBootstrap) {
        throw new Error("Only manager can create managers");
      }
    } else if (isNonRunningAgentStatus(callerDescriptor.status)) {
      throw new Error(`Manager is not running: ${callerAgentId}`);
    }

    const requestedName = input.name?.trim();
    if (!requestedName) {
      throw new Error("create_manager requires a non-empty name");
    }

    const requestedModelPreset = parseSwarmModelPreset(input.model, "create_manager.model");
    const requestedProvider = parseOptionalNonEmptyString(input.provider, "create_manager.provider");
    const requestedModelId = parseOptionalNonEmptyString(input.modelId, "create_manager.modelId");
    const requestedThinkingLevel = parseThinkingLevel(input.thinkingLevel, "create_manager.thinkingLevel");
    const hasExplicitDescriptorField = input.provider !== undefined || input.modelId !== undefined;
    const hasExplicitModelCreate = requestedProvider !== undefined || requestedModelId !== undefined;

    if (requestedModelPreset && hasExplicitDescriptorField) {
      throw new Error(
        "create_manager.model cannot be combined with create_manager.provider or create_manager.modelId"
      );
    }
    if (hasExplicitDescriptorField && !hasExplicitModelCreate) {
      throw new Error(
        "create_manager.provider and create_manager.modelId are required together for explicit model creation"
      );
    }
    if (requestedThinkingLevel && !hasExplicitModelCreate) {
      throw new Error(
        "create_manager.thinkingLevel is only supported with create_manager.provider and create_manager.modelId"
      );
    }
    if (hasExplicitModelCreate && (!requestedProvider || !requestedModelId)) {
      throw new Error(
        "create_manager.provider and create_manager.modelId are required together for explicit model creation"
      );
    }

    let nextModel: AgentModelDescriptor;
    if (requestedModelPreset) {
      nextModel = resolveModelDescriptorFromPreset(requestedModelPreset, {
        presetDefinitions: this.modelPresetDefinitions
      });
    } else if (hasExplicitModelCreate) {
      nextModel = normalizeManagedModelDescriptor(
        {
          provider: requestedProvider!,
          modelId: requestedModelId!,
          thinkingLevel: requestedThinkingLevel
        },
        { presetDefinitions: this.modelPresetDefinitions }
      );
    } else {
      nextModel = this.resolveDefaultModelDescriptor();
    }

    const managerId = this.generateUniqueManagerId(requestedName);
    const createdAt = this.now();
    const cwd = await this.resolveAndValidateCwd(input.cwd);

    const descriptor: AgentDescriptor = {
      agentId: managerId,
      displayName: managerId,
      role: "manager",
      managerId,
      archetypeId: MANAGER_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd,
      model: nextModel,
      sessionFile: join(this.config.paths.sessionsDir, `${managerId}.jsonl`)
    };

    this.descriptors.set(descriptor.agentId, descriptor);

    let runtime: SwarmAgentRuntime;
    try {
      runtime = await this.createRuntimeForDescriptor(
        descriptor,
        this.resolveSystemPromptForDescriptor(descriptor)
      );
    } catch (error) {
      this.descriptors.delete(descriptor.agentId);
      throw error;
    }

    this.runtimes.set(managerId, runtime);
    await this.saveStore();

    const contextUsage = runtime.getContextUsage();
    descriptor.contextUsage = contextUsage;

    this.emitStatus(managerId, descriptor.status, runtime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();

    this.logDebug("manager:create", {
      callerAgentId,
      managerId,
      cwd: descriptor.cwd
    });

    return cloneDescriptor(descriptor);
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    this.assertManager(callerAgentId, "delete managers");

    const target = this.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    const terminatedWorkerIds: string[] = [];

    for (const descriptor of Array.from(this.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }
      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      terminatedWorkerIds.push(descriptor.agentId);
      await this.terminateDescriptor(descriptor, { abort: true, emitStatus: true });
      this.descriptors.delete(descriptor.agentId);
      this.conversationProjector.deleteConversationHistory(descriptor.agentId);
    }

    await this.terminateDescriptor(target, { abort: true, emitStatus: true });
    this.descriptors.delete(targetManagerId);
    this.conversationProjector.deleteConversationHistory(targetManagerId);
    this.clearCrossManagerRateLimitForManager(targetManagerId);

    await this.saveStore();
    this.emitAgentsSnapshot();

    this.logDebug("manager:delete", {
      callerAgentId,
      targetManagerId,
      terminatedWorkerIds
    });

    return { managerId: targetManagerId, terminatedWorkerIds };
  }

  async updateManager(
    callerAgentId: string,
    input: {
      managerId: string;
      model?: SwarmModelPreset;
      provider?: string;
      modelId?: string;
      thinkingLevel?: ThinkingLevel;
      promptOverride?: string;
      spawnDefaultProvider?: string;
      spawnDefaultModelId?: string;
      spawnDefaultThinkingLevel?: ThinkingLevel;
      clearSpawnDefault?: boolean;
    }
  ): Promise<{ manager: AgentDescriptor; resetApplied: boolean }> {
    this.assertManager(callerAgentId, "update managers");
    const target = this.getRequiredManagerDescriptor(input.managerId);

    const currentPromptOverride = normalizePromptOverride(target.promptOverride);
    const requestedModelPreset = parseSwarmModelPreset(input.model, "update_manager.model");
    const requestedProvider = parseOptionalNonEmptyString(input.provider, "update_manager.provider");
    const requestedModelId = parseOptionalNonEmptyString(input.modelId, "update_manager.modelId");
    const requestedThinkingLevel = parseThinkingLevel(input.thinkingLevel, "update_manager.thinkingLevel");
    const hasPromptOverridePatch = input.promptOverride !== undefined;
    const hasExplicitDescriptorField = input.provider !== undefined || input.modelId !== undefined;
    const hasExplicitModelUpdate = requestedProvider !== undefined || requestedModelId !== undefined;

    if (requestedModelPreset && hasExplicitDescriptorField) {
      throw new Error(
        "update_manager.model cannot be combined with update_manager.provider or update_manager.modelId"
      );
    }
    if (hasExplicitDescriptorField && !hasExplicitModelUpdate) {
      throw new Error(
        "update_manager.provider and update_manager.modelId are required together for explicit model updates"
      );
    }
    if (hasExplicitModelUpdate && (!requestedProvider || !requestedModelId)) {
      throw new Error(
        "update_manager.provider and update_manager.modelId are required together for explicit model updates"
      );
    }

    let nextModel: AgentModelDescriptor = target.model;
    if (requestedModelPreset) {
      nextModel = resolveModelDescriptorFromPreset(requestedModelPreset, {
        presetDefinitions: this.modelPresetDefinitions
      });
    }
    if (hasExplicitModelUpdate) {
      nextModel = normalizeManagedModelDescriptor(
        {
          provider: requestedProvider!,
          modelId: requestedModelId!,
          thinkingLevel: requestedThinkingLevel ?? nextModel.thinkingLevel
        },
        { presetDefinitions: this.modelPresetDefinitions }
      );
    } else if (requestedThinkingLevel) {
      nextModel = {
        ...nextModel,
        thinkingLevel: requestedThinkingLevel
      };
    }

    const nextPromptOverride = hasPromptOverridePatch
      ? normalizePromptOverride(input.promptOverride)
      : currentPromptOverride;

    // --- Spawn default validation ---
    const hasSpawnDefaultDescriptorField =
      input.spawnDefaultProvider !== undefined || input.spawnDefaultModelId !== undefined;
    const requestedSpawnDefaultProvider =
      parseOptionalNonEmptyString(input.spawnDefaultProvider, "update_manager.spawnDefaultProvider");
    const requestedSpawnDefaultModelId =
      parseOptionalNonEmptyString(input.spawnDefaultModelId, "update_manager.spawnDefaultModelId");
    const requestedSpawnDefaultThinkingLevel =
      parseThinkingLevel(input.spawnDefaultThinkingLevel, "update_manager.spawnDefaultThinkingLevel");
    const hasExplicitSpawnDefault =
      requestedSpawnDefaultProvider !== undefined || requestedSpawnDefaultModelId !== undefined;

    if (input.clearSpawnDefault && hasSpawnDefaultDescriptorField) {
      throw new Error(
        "update_manager.clearSpawnDefault cannot be combined with update_manager.spawnDefaultProvider or update_manager.spawnDefaultModelId"
      );
    }
    if (hasSpawnDefaultDescriptorField && !hasExplicitSpawnDefault) {
      throw new Error(
        "update_manager.spawnDefaultProvider and update_manager.spawnDefaultModelId are required together"
      );
    }
    if (hasExplicitSpawnDefault && (!requestedSpawnDefaultProvider || !requestedSpawnDefaultModelId)) {
      throw new Error(
        "update_manager.spawnDefaultProvider and update_manager.spawnDefaultModelId are required together"
      );
    }
    if (requestedSpawnDefaultThinkingLevel && !hasExplicitSpawnDefault) {
      throw new Error(
        "update_manager.spawnDefaultThinkingLevel requires update_manager.spawnDefaultProvider and update_manager.spawnDefaultModelId"
      );
    }

    // --- Spawn default application ---
    let nextSpawnDefaultModel = target.spawnDefaultModel;
    let spawnDefaultChanged = false;

    if (input.clearSpawnDefault) {
      if (target.spawnDefaultModel !== undefined) {
        nextSpawnDefaultModel = undefined;
        spawnDefaultChanged = true;
      }
    } else if (hasExplicitSpawnDefault) {
      nextSpawnDefaultModel = normalizeManagedModelDescriptor(
        {
          provider: requestedSpawnDefaultProvider!,
          modelId: requestedSpawnDefaultModelId!,
          thinkingLevel: requestedSpawnDefaultThinkingLevel
        },
        { presetDefinitions: this.modelPresetDefinitions }
      );
      const currentSdm = target.spawnDefaultModel;
      spawnDefaultChanged = !currentSdm ||
        currentSdm.provider !== nextSpawnDefaultModel.provider ||
        currentSdm.modelId !== nextSpawnDefaultModel.modelId ||
        currentSdm.thinkingLevel !== nextSpawnDefaultModel.thinkingLevel;
    }

    const providerChanged = target.model.provider !== nextModel.provider;
    const modelIdChanged = target.model.modelId !== nextModel.modelId;
    const thinkingLevelChanged = target.model.thinkingLevel !== nextModel.thinkingLevel;
    const modelChanged = providerChanged || modelIdChanged || thinkingLevelChanged;
    const promptOverrideChanged = currentPromptOverride !== nextPromptOverride;
    // Provider and prompt changes require a fresh runtime, but same-provider
    // model/thinking updates can reuse the existing provider session/thread.
    const shouldReset = providerChanged || promptOverrideChanged;
    const hasAnyChange = modelChanged || promptOverrideChanged || spawnDefaultChanged;

    if (!hasAnyChange) {
      this.logDebug("manager:update:no_effective_change", {
        callerAgentId,
        managerId: target.agentId
      });

      return {
        manager: cloneDescriptor(target),
        resetApplied: false
      };
    }

    target.model = nextModel;
    if (nextPromptOverride) {
      target.promptOverride = nextPromptOverride;
    } else {
      delete target.promptOverride;
    }

    if (spawnDefaultChanged) {
      if (nextSpawnDefaultModel) {
        target.spawnDefaultModel = nextSpawnDefaultModel;
      } else {
        delete target.spawnDefaultModel;
      }
    }

    target.updatedAt = this.now();
    this.descriptors.set(target.agentId, target);
    await this.saveStore();

    this.logDebug("manager:update:applied", {
      callerAgentId,
      managerId: target.agentId,
      modelChanged,
      providerChanged,
      modelIdChanged,
      thinkingLevelChanged,
      promptOverrideChanged,
      spawnDefaultChanged
    });

    if (shouldReset) {
      await this.resetManagerSession(target.agentId, "api_reset");
    }

    const updated = this.getRequiredManagerDescriptor(target.agentId);
    return {
      manager: cloneDescriptor(updated),
      resetApplied: shouldReset
    };
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return undefined;
    }

    return cloneDescriptor(descriptor);
  }

  async listDirectories(path?: string): Promise<DirectoryListingResult> {
    return listDirectories(path, this.getCwdPolicy());
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return validateDirectoryInput(path, this.getCwdPolicy());
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    const pickedPath = await pickNativeDirectory({
      defaultPath,
      prompt: "Select a manager working directory"
    });

    if (!pickedPath) {
      return null;
    }

    return validateDirectoryPath(pickedPath, this.getCwdPolicy());
  }

  private resolveActivityManagerContextIds(...agents: AgentDescriptor[]): string[] {
    const managerContextIds = new Set<string>();

    for (const descriptor of agents) {
      if (descriptor.role === "manager") {
        managerContextIds.add(descriptor.agentId);
        continue;
      }

      const managerId = descriptor.managerId.trim();
      if (managerId.length > 0) {
        managerContextIds.add(managerId);
      }
    }

    return Array.from(managerContextIds);
  }

  private evictStaleCrossManagerTimestamps(timestamps: number[]): void {
    const cutoff = Date.now() - CROSS_MANAGER_RATE_WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
  }

  private checkCrossManagerRateLimit(fromManagerId: string, toManagerId: string): void {
    const pairKey = `${fromManagerId}->${toManagerId}`;
    const timestamps = this.crossManagerMessageLog.get(pairKey);
    if (!timestamps) {
      return;
    }

    this.evictStaleCrossManagerTimestamps(timestamps);

    if (timestamps.length >= CROSS_MANAGER_RATE_LIMIT) {
      throw new Error(
        `Cross-manager message rate limit exceeded: ${fromManagerId} -> ${toManagerId} ` +
        `(${CROSS_MANAGER_RATE_LIMIT} messages per ${CROSS_MANAGER_RATE_WINDOW_MS / 1000}s window). ` +
        `This may indicate a messaging loop.`
      );
    }
  }

  private recordCrossManagerMessage(fromManagerId: string, toManagerId: string): void {
    const pairKey = `${fromManagerId}->${toManagerId}`;
    let timestamps = this.crossManagerMessageLog.get(pairKey);
    if (!timestamps) {
      timestamps = [];
      this.crossManagerMessageLog.set(pairKey, timestamps);
    }
    timestamps.push(Date.now());
  }

  private clearCrossManagerRateLimitForManager(managerId: string): void {
    for (const key of this.crossManagerMessageLog.keys()) {
      if (key.startsWith(`${managerId}->`) || key.endsWith(`->${managerId}`)) {
        this.crossManagerMessageLog.delete(key);
      }
    }
  }

  async sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode = "auto",
    options?: { origin?: "user" | "internal"; attachments?: ConversationAttachment[] }
  ): Promise<SendMessageReceipt> {
    const hasAttachments = (options?.attachments?.length ?? 0) > 0;
    if ((!message || message.trim().length === 0) && !hasAttachments) {
      throw new Error("Message text cannot be empty");
    }

    const sender = this.descriptors.get(fromAgentId);
    if (!sender || isNonRunningAgentStatus(sender.status)) {
      throw new Error(`Unknown or unavailable sender agent: ${fromAgentId}`);
    }

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (isNonRunningAgentStatus(target.status)) {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    // Guard: managers may only message their own workers, but may freely message other managers.
    if (sender.role === "manager" && target.role === "worker" && target.managerId !== sender.agentId) {
      throw new Error(`Manager ${sender.agentId} does not own worker ${targetAgentId}`);
    }

    const isCrossManager = sender.role === "manager" && target.role === "manager" && sender.agentId !== target.agentId;
    if (isCrossManager) {
      this.checkCrossManagerRateLimit(sender.agentId, targetAgentId);
    }

    const managerContextIds = this.resolveActivityManagerContextIds(sender, target);
    const runtime = await this.getOrCreateRuntimeForDescriptor(target);
    const requestedDelivery = this.normalizeRequestedDeliveryForTarget(target, delivery);

    const origin = options?.origin ?? "internal";
    const attachments = normalizeConversationAttachments(options?.attachments);
    const modelMessage = await this.prepareModelInboundMessage(
      targetAgentId,
      {
        text: message,
        attachments
      },
      origin
    );
    const receipt = await runtime.sendMessage(modelMessage, requestedDelivery);

    if (isCrossManager) {
      this.recordCrossManagerMessage(sender.agentId, targetAgentId);
    }

    this.logDebug("agent:send_message", {
      fromAgentId,
      targetAgentId,
      origin,
      requestedDelivery,
      acceptedMode: receipt.acceptedMode,
      textPreview: previewForLog(message),
      attachmentCount: attachments.length,
      modelTextPreview: previewForLog(extractRuntimeMessageText(modelMessage))
    });

    if (origin !== "user" && fromAgentId !== targetAgentId) {
      const coveredIds = new Set(managerContextIds);
      const ts = this.now();

      for (const managerContextId of managerContextIds) {
        this.emitAgentMessage({
          type: "agent_message",
          agentId: managerContextId,
          timestamp: ts,
          source: "agent_to_agent",
          fromAgentId,
          toAgentId: targetAgentId,
          text: message,
          requestedDelivery,
          acceptedMode: receipt.acceptedMode,
          attachmentCount: attachments.length > 0 ? attachments.length : undefined
        });
      }

      for (const participantId of [fromAgentId, targetAgentId]) {
        if (!coveredIds.has(participantId)) {
          this.emitAgentMessage({
            type: "agent_message",
            agentId: participantId,
            timestamp: ts,
            source: "agent_to_agent",
            fromAgentId,
            toAgentId: targetAgentId,
            text: message,
            requestedDelivery,
            acceptedMode: receipt.acceptedMode,
            attachmentCount: attachments.length > 0 ? attachments.length : undefined
          });
        }
      }
    }

    return receipt;
  }

  private normalizeRequestedDeliveryForTarget(
    target: AgentDescriptor,
    delivery: RequestedDeliveryMode
  ): RequestedDeliveryMode {
    const provider = target.model.provider.trim().toLowerCase();
    if (provider === "claude-agent-sdk" && delivery === "steer") {
      return "followUp";
    }

    return delivery;
  }

  private async prepareModelInboundMessage(
    targetAgentId: string,
    input: { text: string; attachments: ConversationAttachment[] },
    origin: "user" | "internal"
  ): Promise<string | RuntimeUserMessage> {
    let text = input.text;

    if (origin !== "user") {
      if (text.trim().length > 0 && !/^system:/i.test(text.trimStart())) {
        text = `${INTERNAL_MODEL_MESSAGE_PREFIX}${text}`;
      }
    }

    const runtimeAttachments = await this.prepareRuntimeAttachments(targetAgentId, input.attachments);

    if (runtimeAttachments.attachmentMessage.length > 0) {
      text = text.trim().length > 0 ? `${text}\n\n${runtimeAttachments.attachmentMessage}` : runtimeAttachments.attachmentMessage;
    }

    if (runtimeAttachments.images.length === 0) {
      return text;
    }

    return {
      text,
      images: runtimeAttachments.images
    };
  }

  private async prepareRuntimeAttachments(
    targetAgentId: string,
    attachments: ConversationAttachment[]
  ): Promise<{ images: RuntimeImageAttachment[]; attachmentMessage: string }> {
    if (attachments.length === 0) {
      return {
        images: [],
        attachmentMessage: ""
      };
    }

    const images = toRuntimeImageAttachments(attachments);
    const fileMessages: string[] = [];
    const attachmentPathMessages: string[] = [];
    let binaryAttachmentDir: string | undefined;

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const persistedPath = normalizeOptionalAttachmentPath(attachment.filePath);

      if (persistedPath) {
        attachmentPathMessages.push(`[Attached file saved to: ${persistedPath}]`);
      }

      if (isConversationImageAttachment(attachment)) {
        continue;
      }

      if (isConversationTextAttachment(attachment)) {
        fileMessages.push(formatTextAttachmentForPrompt(attachment, index + 1));
        continue;
      }

      if (isConversationBinaryAttachment(attachment)) {
        let storedPath = persistedPath;
        if (!storedPath) {
          const directory = binaryAttachmentDir ?? (await this.createBinaryAttachmentDir(targetAgentId));
          binaryAttachmentDir = directory;
          storedPath = await this.writeBinaryAttachmentToDisk(directory, attachment, index + 1);
        }
        fileMessages.push(formatBinaryAttachmentForPrompt(attachment, storedPath, index + 1));
      }
    }

    if (fileMessages.length === 0 && attachmentPathMessages.length === 0) {
      return {
        images,
        attachmentMessage: ""
      };
    }

    const attachmentMessageSections: string[] = [];
    if (fileMessages.length > 0) {
      attachmentMessageSections.push("The user attached the following files:", "", ...fileMessages);
    }
    if (attachmentPathMessages.length > 0) {
      if (attachmentMessageSections.length > 0) {
        attachmentMessageSections.push("");
      }
      attachmentMessageSections.push(...attachmentPathMessages);
    }

    return {
      images,
      attachmentMessage: attachmentMessageSections.join("\n")
    };
  }

  private async createBinaryAttachmentDir(targetAgentId: string): Promise<string> {
    const agentSegment = sanitizePathSegment(targetAgentId, "agent");
    const batchId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const directory = join(this.config.paths.dataDir, "attachments", agentSegment, batchId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async writeBinaryAttachmentToDisk(
    directory: string,
    attachment: ConversationBinaryAttachment,
    attachmentIndex: number
  ): Promise<string> {
    const safeName = sanitizeAttachmentFileName(attachment.fileName, `attachment-${attachmentIndex}.bin`);
    const filePath = join(directory, `${String(attachmentIndex).padStart(2, "0")}-${safeName}`);
    const buffer = Buffer.from(attachment.data, "base64");
    await writeFile(filePath, buffer);
    return filePath;
  }

  async publishToUser(
    agentId: string,
    text: string,
    source: "speak_to_user" | "system" = "speak_to_user",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext }> {
    let resolvedTargetContext: MessageSourceContext;

    if (source === "speak_to_user") {
      this.assertManager(agentId, "speak to user");
      resolvedTargetContext = this.resolveReplyTargetContext(targetContext);
    } else {
      resolvedTargetContext = normalizeMessageSourceContext(targetContext ?? { channel: "web" });
    }

    const payload: ConversationMessageEvent = {
      type: "conversation_message",
      agentId,
      role: source === "system" ? "system" : "assistant",
      text,
      timestamp: this.now(),
      source,
      sourceContext: resolvedTargetContext
    };

    this.emitConversationMessage(payload);
    this.logDebug("manager:publish_to_user", {
      source,
      agentId,
      targetContext: resolvedTargetContext,
      textPreview: previewForLog(text)
    });

    return {
      targetContext: resolvedTargetContext
    };
  }

  async compactAgentContext(
    agentId: string,
    options?: {
      customInstructions?: string;
      sourceContext?: MessageSourceContext;
      trigger?: "api" | "slash_command";
    }
  ): Promise<unknown> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Target agent is not running: ${agentId}`);
    }

    if (descriptor.role !== "manager" && !isClaudeAgentSdkProvider(descriptor.model.provider)) {
      throw new Error(`Compaction is only supported for manager agents: ${agentId}`);
    }

    const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const customInstructions = options?.customInstructions?.trim() || undefined;

    this.logDebug("manager:compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? "")
    });

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: descriptor.role === "manager"
        ? "Compacting manager context..."
        : `Compacting ${descriptor.displayName ?? "agent"} context...`,
      timestamp: this.now(),
      source: "system",
      sourceContext
    });

    try {
      const result = await runtime.compact(customInstructions);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: "Compaction complete.",
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api"
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: `Compaction failed: ${message}`,
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message
      });

      throw error;
    }
  }

  async handleUserMessage(
    text: string,
    options?: {
      targetAgentId?: string;
      delivery?: RequestedDeliveryMode;
      attachments?: ConversationAttachment[];
      sourceContext?: MessageSourceContext;
    }
  ): Promise<void> {
    const trimmed = text.trim();
    const attachments = normalizeConversationAttachments(options?.attachments);
    if (!trimmed && attachments.length === 0) return;

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });

    const targetAgentId = options?.targetAgentId ?? this.resolvePreferredManagerId();
    if (!targetAgentId) {
      throw new Error("No manager is available. Create a manager first.");
    }
    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (isNonRunningAgentStatus(target.status)) {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    const compactCommand =
      target.role === "manager" && attachments.length === 0 ? parseCompactSlashCommand(trimmed) : undefined;
    if (compactCommand) {
      this.logDebug("manager:user_message_compact_command", {
        targetAgentId: target.agentId,
        sourceContext,
        customInstructionsPreview: previewForLog(compactCommand.customInstructions ?? "")
      });
      await this.compactAgentContext(target.agentId, {
        customInstructions: compactCommand.customInstructions,
        sourceContext,
        trigger: "slash_command"
      });
      return;
    }

    const managerContextId = target.role === "manager" ? target.agentId : target.managerId;
    const receivedAt = this.now();

    this.logDebug("manager:user_message_received", {
      targetAgentId,
      managerContextId,
      sourceContext,
      textPreview: previewForLog(trimmed),
      attachmentCount: attachments.length
    });

    const userEvent: ConversationMessageEvent = {
      type: "conversation_message",
      agentId: targetAgentId,
      role: "user",
      text: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: receivedAt,
      source: "user_input",
      sourceContext
    };
    this.emitConversationMessage(userEvent);

    if (target.role !== "manager") {
      const requestedDelivery = options?.delivery ?? "auto";
      let receipt: SendMessageReceipt;
      try {
        receipt = await this.sendMessage(managerContextId, targetAgentId, trimmed, requestedDelivery, {
          origin: "user",
          attachments
        });
      } catch (error) {
        this.logDebug("manager:user_message_dispatch_error", {
          managerContextId,
          targetAgentId,
          targetRole: target.role,
          requestedDelivery,
          sourceContext,
          textPreview: previewForLog(trimmed),
          attachmentCount: attachments.length,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }

      this.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId,
        targetRole: target.role,
        requestedDelivery,
        acceptedMode: receipt.acceptedMode,
        sourceContext,
        attachmentCount: attachments.length
      });

      return;
    }

    const requestedDelivery = this.normalizeRequestedDeliveryForTarget(target, "steer");

    let managerRuntime: SwarmAgentRuntime;
    try {
      managerRuntime = await this.getOrCreateRuntimeForDescriptor(target);
    } catch (error) {
      this.logDebug("manager:user_message_dispatch_error", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery,
        sourceContext,
        textPreview: previewForLog(trimmed),
        attachmentCount: attachments.length,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }

    const managerVisibleMessage = formatInboundUserMessageForManager(trimmed, sourceContext);

    // Prefer steer for manager-bound user messages; runtimes that don't support it are downgraded.
    const runtimeMessage = await this.prepareModelInboundMessage(
      managerContextId,
      {
        text: managerVisibleMessage,
        attachments
      },
      "user"
    );

    this.logDebug("manager:user_message_dispatch_start", {
      managerContextId,
      targetAgentId: managerContextId,
      targetRole: target.role,
      requestedDelivery,
      sourceContext,
      textPreview: previewForLog(trimmed),
      attachmentCount: attachments.length,
      runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
      runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0)
    });

    try {
      const receipt = await managerRuntime.sendMessage(runtimeMessage, requestedDelivery);
      this.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery,
        acceptedMode: receipt.acceptedMode,
        sourceContext,
        attachmentCount: attachments.length
      });
    } catch (error) {
      this.logDebug("manager:user_message_dispatch_error", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery,
        sourceContext,
        textPreview: previewForLog(trimmed),
        attachmentCount: attachments.length,
        runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
        runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0),
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  async resetManagerSession(
    managerIdOrReason: string | "user_new_command" | "api_reset" = "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): Promise<void> {
    const parsed = this.parseResetManagerSessionArgs(managerIdOrReason, maybeReason);
    const managerId = parsed.managerId;
    const reason = parsed.reason;
    const managerDescriptor = this.getRequiredManagerDescriptor(managerId);

    this.logDebug("manager:reset:start", {
      managerId,
      reason,
      sessionFile: managerDescriptor.sessionFile
    });

    const existingRuntime = this.runtimes.get(managerId);
    if (existingRuntime) {
      await existingRuntime.terminate({ abort: true });
      this.runtimes.delete(managerId);
    }

    this.conversationProjector.resetConversationHistory(managerId);
    await this.deleteManagerSessionFile(managerDescriptor.sessionFile);

    managerDescriptor.status = transitionAgentStatus(managerDescriptor.status, "idle");
    managerDescriptor.contextUsage = undefined;
    managerDescriptor.updatedAt = this.now();
    this.descriptors.set(managerId, managerDescriptor);
    await this.saveStore();

    const managerRuntime = await this.createRuntimeForDescriptor(
      managerDescriptor,
      this.resolveSystemPromptForDescriptor(managerDescriptor)
    );
    this.runtimes.set(managerId, managerRuntime);

    const contextUsage = managerRuntime.getContextUsage();
    managerDescriptor.contextUsage = contextUsage;

    this.emitConversationReset(managerId, reason);
    this.emitStatus(managerId, managerDescriptor.status, managerRuntime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();

    this.logDebug("manager:reset:ready", {
      managerId,
      reason,
      sessionFile: managerDescriptor.sessionFile
    });
  }

  getConfig(): SwarmConfig {
    return this.config;
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    return this.secretsEnvService.listSettingsAuth();
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    await this.secretsEnvService.updateSettingsAuth(values);
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    await this.secretsEnvService.deleteSettingsAuth(provider);
  }

  async getClaudeManagerOutputStyleMetadata(
    managerId: string
  ): Promise<{ selectedStyle: string | null; availableStyles: string[] }> {
    const managerDescriptor = this.getRequiredManagerDescriptor(managerId);
    if (!isClaudeAgentSdkProvider(managerDescriptor.model.provider)) {
      throw new Error(`Manager ${managerId} is not using claude-agent-sdk`);
    }

    const runtime = await this.getOrCreateRuntimeForDescriptor(managerDescriptor);
    if (typeof runtime.getClaudeOutputStyleMetadata !== "function") {
      throw new Error(`Claude metadata runtime is unavailable for manager ${managerId}`);
    }

    return runtime.getClaudeOutputStyleMetadata();
  }

  private emitConversationMessage(event: ConversationMessageEvent): void {
    this.conversationProjector.emitConversationMessage(event);
  }

  private emitAgentMessage(event: AgentMessageEvent): void {
    this.conversationProjector.emitAgentMessage(event);
  }

  private emitConversationReset(agentId: string, reason: "user_new_command" | "api_reset"): void {
    this.conversationProjector.emitConversationReset(agentId, reason);
  }

  private logDebug(message: string, details?: unknown): void {
    if (!this.config.debug) return;

    const prefix = `[swarm][${this.now()}] ${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }
    console.log(prefix, details);
  }

  private getConfiguredManagerId(): string | undefined {
    return normalizeOptionalAgentId(this.config.managerId);
  }

  private resolvePreferredManagerId(options?: { includeStoppedOnRestart?: boolean }): string | undefined {
    const includeStoppedOnRestart = options?.includeStoppedOnRestart ?? false;
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.descriptors.get(configuredManagerId);
      if (configuredManager && this.isAvailableManagerDescriptor(configuredManager, includeStoppedOnRestart)) {
        return configuredManagerId;
      }
    }

    const firstManager = Array.from(this.descriptors.values())
      .filter((descriptor) => this.isAvailableManagerDescriptor(descriptor, includeStoppedOnRestart))
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }
        return left.agentId.localeCompare(right.agentId);
      })[0];

    return firstManager?.agentId;
  }

  private isAvailableManagerDescriptor(
    descriptor: AgentDescriptor,
    includeStoppedOnRestart: boolean
  ): boolean {
    if (descriptor.role !== "manager") {
      return false;
    }

    if (descriptor.status === "terminated" || descriptor.status === "error") {
      return false;
    }

    if (!includeStoppedOnRestart && descriptor.status === "stopped") {
      return false;
    }

    return true;
  }

  private sortedDescriptors(): AgentDescriptor[] {
    const configuredManagerId = this.getConfiguredManagerId();
    return Array.from(this.descriptors.values()).sort((a, b) => {
      if (configuredManagerId) {
        if (a.agentId === configuredManagerId) return -1;
        if (b.agentId === configuredManagerId) return 1;
      }

      if (a.role === "manager" && b.role !== "manager") return -1;
      if (b.role === "manager" && a.role !== "manager") return 1;

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.agentId.localeCompare(b.agentId);
    });
  }

  private normalizeStreamingStatusesForBoot(): void {
    const normalizedAgentIds: string[] = [];

    for (const descriptor of this.descriptors.values()) {
      if (descriptor.status !== "streaming") {
        continue;
      }

      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
      descriptor.updatedAt = this.now();
      this.descriptors.set(descriptor.agentId, descriptor);
      normalizedAgentIds.push(descriptor.agentId);
    }

    if (normalizedAgentIds.length > 0) {
      this.logDebug("boot:normalize_streaming_statuses", { normalizedAgentIds });
    }
  }

  private async restoreRuntimesForBoot(): Promise<void> {
    let shouldPersist = false;
    const configuredManagerId = this.getConfiguredManagerId();

    for (const descriptor of this.sortedDescriptors()) {
      if (!this.shouldRestoreRuntimeForDescriptor(descriptor)) {
        continue;
      }

      try {
        await this.getOrCreateRuntimeForDescriptor(descriptor);
      } catch (error) {
        if (
          descriptor.role === "manager" &&
          configuredManagerId &&
          descriptor.agentId === configuredManagerId
        ) {
          throw error;
        }

        const idleStatus = descriptor.status === "streaming"
          ? transitionAgentStatus(descriptor.status, "idle")
          : descriptor.status;
        descriptor.status = transitionAgentStatus(idleStatus, "stopped");
        descriptor.contextUsage = undefined;
        descriptor.updatedAt = this.now();
        this.descriptors.set(descriptor.agentId, descriptor);
        shouldPersist = true;

        this.emitStatus(descriptor.agentId, descriptor.status, 0);
        this.logDebug("boot:restore_runtime:error", {
          agentId: descriptor.agentId,
          role: descriptor.role,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (shouldPersist) {
      await this.saveStore();
    }

    if (configuredManagerId) {
      const primaryManager = this.descriptors.get(configuredManagerId);
      if (
        primaryManager &&
        primaryManager.role === "manager" &&
        primaryManager.status === "streaming" &&
        !this.runtimes.has(configuredManagerId)
      ) {
        throw new Error("Primary manager runtime is not initialized");
      }
    }
  }

  private shouldRestoreRuntimeForDescriptor(descriptor: AgentDescriptor): boolean {
    return descriptor.status === "streaming";
  }

  private async getOrCreateRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    const existingRuntime = this.runtimes.get(descriptor.agentId);
    if (existingRuntime) {
      return existingRuntime;
    }

    const normalizedModel = this.normalizePersistedModelDescriptor(descriptor.model);
    if (
      descriptor.model.provider !== normalizedModel.provider ||
      descriptor.model.modelId !== normalizedModel.modelId ||
      descriptor.model.thinkingLevel !== normalizedModel.thinkingLevel
    ) {
      descriptor.model = normalizedModel;
      descriptor.updatedAt = this.now();
      this.descriptors.set(descriptor.agentId, descriptor);
    }

    const runtime = await this.createRuntimeForDescriptor(descriptor, this.resolveSystemPromptForDescriptor(descriptor));

    const latestDescriptor = this.descriptors.get(descriptor.agentId);
    if (!latestDescriptor || isNonRunningAgentStatus(latestDescriptor.status)) {
      await runtime.terminate({ abort: true });
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const concurrentRuntime = this.runtimes.get(descriptor.agentId);
    if (concurrentRuntime) {
      await runtime.terminate({ abort: true });
      return concurrentRuntime;
    }

    this.runtimes.set(descriptor.agentId, runtime);
    const contextUsage = runtime.getContextUsage();
    latestDescriptor.contextUsage = contextUsage;
    this.descriptors.set(descriptor.agentId, latestDescriptor);
    this.emitStatus(descriptor.agentId, latestDescriptor.status, runtime.getPendingCount(), contextUsage);
    return runtime;
  }

  private getBootLogManagerDescriptor(): AgentDescriptor | undefined {
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.descriptors.get(configuredManagerId);
      if (configuredManager && configuredManager.role === "manager" && configuredManager.status !== "terminated") {
        return configuredManager;
      }
    }

    return Array.from(this.descriptors.values()).find(
      (descriptor) => descriptor.role === "manager" && descriptor.status !== "terminated"
    );
  }

  private getRequiredManagerDescriptor(managerId: string): AgentDescriptor {
    const descriptor = this.descriptors.get(managerId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Unknown manager: ${managerId}`);
    }

    return descriptor;
  }

  private resolveDefaultModelDescriptor(): AgentModelDescriptor {
    return resolveModelDescriptorFromPreset(this.defaultModelPreset, {
      presetDefinitions: this.modelPresetDefinitions
    });
  }

  private normalizePersistedModelDescriptor(
    descriptor: (Pick<AgentModelDescriptor, "provider" | "modelId"> & { thinkingLevel?: string }) | undefined
  ): AgentModelDescriptor {
    return normalizeManagedModelDescriptor(descriptor, {
      presetDefinitions: this.modelPresetDefinitions
    });
  }

  private resolveSpawnModel(
    input: Pick<SpawnAgentInput, "model" | "provider" | "modelId" | "thinkingLevel">,
    fallback: AgentModelDescriptor
  ): AgentModelDescriptor {
    const requestedModelPreset = parseSwarmModelPreset(input.model, "spawn_agent.model");
    const requestedProvider = parseOptionalNonEmptyString(input.provider, "spawn_agent.provider");
    const requestedModelId = parseOptionalNonEmptyString(input.modelId, "spawn_agent.modelId");
    const requestedThinkingLevel = parseThinkingLevel(input.thinkingLevel, "spawn_agent.thinkingLevel");
    const hasExplicitDescriptorField = input.provider !== undefined || input.modelId !== undefined;
    const hasExplicitModel = requestedProvider !== undefined || requestedModelId !== undefined;

    if (requestedModelPreset && hasExplicitDescriptorField) {
      throw new Error(
        "spawn_agent.model cannot be combined with spawn_agent.provider or spawn_agent.modelId"
      );
    }
    if (hasExplicitDescriptorField && !hasExplicitModel) {
      throw new Error(
        "spawn_agent.provider and spawn_agent.modelId are required together for explicit model selection"
      );
    }
    if (requestedThinkingLevel && !hasExplicitModel) {
      throw new Error(
        "spawn_agent.thinkingLevel is only supported with spawn_agent.provider and spawn_agent.modelId"
      );
    }
    if (hasExplicitModel && (!requestedProvider || !requestedModelId)) {
      throw new Error(
        "spawn_agent.provider and spawn_agent.modelId are required together for explicit model selection"
      );
    }

    if (requestedModelPreset) {
      return resolveModelDescriptorFromPreset(requestedModelPreset, {
        presetDefinitions: this.modelPresetDefinitions
      });
    }
    if (hasExplicitModel) {
      return normalizeManagedModelDescriptor(
        {
          provider: requestedProvider!,
          modelId: requestedModelId!,
          thinkingLevel: requestedThinkingLevel
        },
        { presetDefinitions: this.modelPresetDefinitions }
      );
    }

    return this.normalizePersistedModelDescriptor(fallback);
  }

  private resolveSpawnWorkerArchetypeId(
    input: SpawnAgentInput,
    normalizedAgentId: string
  ): string | undefined {
    if (input.archetypeId !== undefined) {
      const explicit = normalizeArchetypeId(input.archetypeId);
      if (!explicit) {
        throw new Error("spawn_agent archetypeId must include at least one letter or number");
      }
      if (!this.archetypePromptRegistry.resolvePrompt(explicit)) {
        throw new Error(`Unknown archetypeId: ${explicit}`);
      }
      return explicit;
    }

    if (
      normalizedAgentId === MERGER_ARCHETYPE_ID ||
      normalizedAgentId.startsWith(`${MERGER_ARCHETYPE_ID}-`)
    ) {
      return MERGER_ARCHETYPE_ID;
    }

    return undefined;
  }

  private resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      const promptOverride = normalizePromptOverride(descriptor.promptOverride);
      if (promptOverride) {
        return prependMandatoryManagerOperationalPreamble(promptOverride);
      }
      return this.resolveRequiredArchetypePrompt(MANAGER_ARCHETYPE_ID);
    }

    if (descriptor.archetypeId) {
      const archetypePrompt = this.archetypePromptRegistry.resolvePrompt(descriptor.archetypeId);
      if (archetypePrompt) {
        return archetypePrompt;
      }
    }

    return buildWorkerSystemPrompt(descriptor.managerId);
  }

  private resolveRequiredArchetypePrompt(archetypeId: string): string {
    const prompt = this.archetypePromptRegistry.resolvePrompt(archetypeId);
    if (!prompt) {
      throw new Error(`Missing archetype prompt: ${archetypeId}`);
    }
    return prompt;
  }

  private async resolveAndValidateCwd(cwd: string): Promise<string> {
    return validateDirectoryPath(cwd, this.getCwdPolicy());
  }

  private getCwdPolicy(): { rootDir: string; allowlistRoots: string[] } {
    return {
      rootDir: this.config.paths.rootDir,
      allowlistRoots: normalizeAllowlistRoots(this.config.cwdAllowlistRoots)
    };
  }

  private generateUniqueAgentId(source: string): string {
    const base = normalizeAgentId(source);

    if (!base) {
      throw new Error("spawn_agent agentId must include at least one letter or number");
    }

    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId && base === configuredManagerId) {
      throw new Error(`spawn_agent agentId \"${configuredManagerId}\" is reserved`);
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private generateUniqueManagerId(source: string): string {
    const base = normalizeAgentId(source);
    if (!base) {
      throw new Error("create_manager name must include at least one letter or number");
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private assertManager(agentId: string, action: string): AgentDescriptor {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Only manager can ${action}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Manager is not running: ${agentId}`);
    }

    return descriptor;
  }

  private hasRunningManagers(): boolean {
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      if (isNonRunningAgentStatus(descriptor.status)) {
        continue;
      }

      return true;
    }

    return false;
  }

  private resolveReplyTargetContext(explicitTargetContext?: MessageTargetContext): MessageSourceContext {
    if (!explicitTargetContext) {
      return { channel: "web" };
    }

    const normalizedExplicitTarget = normalizeMessageTargetContext(explicitTargetContext);

    if (
      (normalizedExplicitTarget.channel === "slack" ||
        normalizedExplicitTarget.channel === "telegram") &&
      !normalizedExplicitTarget.channelId
    ) {
      throw new Error(
        'speak_to_user target.channelId is required when target.channel is "slack" or "telegram"'
      );
    }

    return normalizeMessageSourceContext(normalizedExplicitTarget);
  }

  private parseResetManagerSessionArgs(
    managerIdOrReason: string | "user_new_command" | "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): { managerId: string; reason: "user_new_command" | "api_reset" } {
    if (managerIdOrReason === "user_new_command" || managerIdOrReason === "api_reset") {
      const managerId = this.resolvePreferredManagerId({ includeStoppedOnRestart: true });
      if (!managerId) {
        throw new Error("No manager is available.");
      }

      return {
        managerId,
        reason: managerIdOrReason
      };
    }

    return {
      managerId: managerIdOrReason,
      reason: maybeReason ?? "api_reset"
    };
  }

  private async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    const runtime = this.runtimes.get(descriptor.agentId);
    if (runtime) {
      await runtime.terminate({ abort: options.abort });
      this.runtimes.delete(descriptor.agentId);
    }

    descriptor.status = transitionAgentStatus(descriptor.status, "terminated");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.now();
    this.descriptors.set(descriptor.agentId, descriptor);

    if (options.emitStatus) {
      this.emitStatus(descriptor.agentId, descriptor.status, 0);
    }
  }

  protected async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
    const contextFiles: Array<{ path: string; content: string }> = [];
    const seenPaths = new Set<string>();
    const rootDir = resolve("/");
    let currentDir = resolve(cwd);

    while (true) {
      const candidatePath = join(currentDir, SWARM_CONTEXT_FILE_NAME);
      if (!seenPaths.has(candidatePath) && existsSync(candidatePath)) {
        try {
          contextFiles.unshift({
            path: candidatePath,
            content: await readFile(candidatePath, "utf8")
          });
          seenPaths.add(candidatePath);
        } catch (error) {
          this.logDebug("runtime:swarm_context:read:error", {
            cwd,
            path: candidatePath,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (currentDir === rootDir) {
        break;
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return contextFiles;
  }

  protected async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    return this.runtimeFactory.createRuntimeForDescriptor(descriptor, systemPrompt);
  }

  private async handleRuntimeStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) return;

    const normalizedContextUsage = normalizeContextUsage(contextUsage);
    let shouldPersist = false;

    if (!areContextUsagesEqual(descriptor.contextUsage, normalizedContextUsage)) {
      descriptor.contextUsage = normalizedContextUsage;
    }

    const nextStatus = transitionAgentStatus(descriptor.status, status);
    if (descriptor.status !== nextStatus) {
      descriptor.status = nextStatus;
      descriptor.updatedAt = this.now();
      shouldPersist = true;
    }

    if (isNonRunningAgentStatus(nextStatus) && descriptor.contextUsage) {
      descriptor.contextUsage = undefined;
      shouldPersist = true;
    }

    this.descriptors.set(agentId, descriptor);

    if (shouldPersist) {
      await this.saveStore();
    }

    this.emitStatus(agentId, status, pendingCount, descriptor.contextUsage);
    this.logDebug("runtime:status", {
      agentId,
      status,
      pendingCount,
      contextUsage: descriptor.contextUsage
    });
  }

  private async handleRuntimeSessionEvent(agentId: string, event: RuntimeSessionEvent): Promise<void> {
    this.captureConversationEventFromRuntime(agentId, event);

    if (!this.config.debug) return;

    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    switch (event.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
        this.logDebug(`manager:event:${event.type}`);
        return;

      case "turn_end":
        this.logDebug("manager:event:turn_end", {
          toolResults: event.toolResults.length
        });
        return;

      case "tool_execution_start":
        this.logDebug("manager:tool:start", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: previewForLog(safeJson(event.args), 240)
        });
        return;

      case "tool_execution_end":
        this.logDebug("manager:tool:end", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: previewForLog(safeJson(event.result), 240)
        });
        return;

      case "message_start":
      case "message_end":
        this.logDebug(`manager:event:${event.type}`, {
          role: extractRole(event.message),
          stopReason: extractMessageStopReason(event.message),
          errorMessage: extractMessageErrorMessage(event.message),
          textPreview: previewForLog(extractMessageText(event.message) ?? "")
        });
        return;

      case "message_update":
      case "tool_execution_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }

  private async handleRuntimeError(agentId: string, error: RuntimeErrorEvent): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    const message = error.message.trim().length > 0 ? error.message.trim() : "Unknown runtime error";
    const attempt = readPositiveIntegerDetail(error.details, "attempt");
    const maxAttempts = readPositiveIntegerDetail(error.details, "maxAttempts");
    const droppedPendingCount = readPositiveIntegerDetail(error.details, "droppedPendingCount");

    this.logDebug("runtime:error", {
      agentId,
      runtime: runtimeLabelForProvider(descriptor.model.provider),
      phase: error.phase,
      message,
      stack: error.stack,
      details: error.details
    });

    const retryLabel =
      attempt && maxAttempts && maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";

    const text =
      error.phase === "compaction"
        ? `⚠️ Compaction error${retryLabel}: ${message}. Continuing without compaction.`
        : droppedPendingCount && droppedPendingCount > 0
          ? `⚠️ Agent error${retryLabel}: ${message}. ${droppedPendingCount} queued message${droppedPendingCount === 1 ? "" : "s"} could not be delivered and were dropped. Please resend.`
          : `⚠️ Agent error${retryLabel}: ${message}. Message may need to be resent.`;

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text,
      timestamp: this.now(),
      source: "system"
    });
  }

  private captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent): void {
    this.conversationProjector.captureConversationEventFromRuntime(agentId, event);
  }

  private emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): void {
    const resolvedContextUsage = normalizeContextUsage(contextUsage ?? this.descriptors.get(agentId)?.contextUsage);
    const payload: AgentStatusEvent = {
      type: "agent_status",
      agentId,
      status,
      pendingCount,
      ...(resolvedContextUsage ? { contextUsage: resolvedContextUsage } : {})
    };

    this.emit("agent_status", payload satisfies ServerEvent);
  }

  private emitAgentsSnapshot(): void {
    const payload: AgentsSnapshotEvent = {
      type: "agents_snapshot",
      agents: this.listAgents()
    };

    this.emit("agents_snapshot", payload satisfies ServerEvent);
  }

  private async handleRuntimeAgentEnd(_agentId: string): Promise<void> {
    // No-op: managers now receive all inbound messages with sourceContext metadata
    // and decide whether to respond without pending-reply bookkeeping.
  }

  private async ensureDirectories(): Promise<void> {
    await this.persistenceService.ensureDirectories();
  }

  private async deleteManagerSessionFile(sessionFile: string): Promise<void> {
    await this.persistenceService.deleteManagerSessionFile(sessionFile);
  }

  private async loadStore(): Promise<AgentsStoreFile> {
    return this.persistenceService.loadStore();
  }

  private loadConversationHistoriesFromStore(): void {
    this.conversationProjector.loadConversationHistoriesFromStore();
  }

  private async saveStore(): Promise<void> {
    await this.persistenceService.saveStore();
  }
}

const VALID_PERSISTED_AGENT_ROLES = new Set(["manager", "worker"]);
const VALID_PERSISTED_AGENT_STATUSES = new Set([
  "idle",
  "streaming",
  "terminated",
  "stopped",
  "error",
  "stopped_on_restart"
]);

function validateAgentDescriptor(value: unknown): AgentDescriptor | string {
  if (!isRecord(value)) {
    return "descriptor must be an object";
  }

  if (!isNonEmptyString(value.agentId)) {
    return "agentId must be a non-empty string";
  }

  if (typeof value.displayName !== "string") {
    return "displayName must be a string";
  }

  if (!isNonEmptyString(value.role) || !VALID_PERSISTED_AGENT_ROLES.has(value.role)) {
    return "role must be one of manager|worker";
  }

  if (!isNonEmptyString(value.managerId)) {
    return "managerId must be a non-empty string";
  }

  if (!isNonEmptyString(value.status) || !VALID_PERSISTED_AGENT_STATUSES.has(value.status)) {
    return "status must be one of idle|streaming|terminated|stopped|error|stopped_on_restart";
  }
  const normalizedStatus = normalizeAgentStatus(value.status as AgentStatusInput);

  if (!isNonEmptyString(value.createdAt)) {
    return "createdAt must be a non-empty string";
  }

  if (!isNonEmptyString(value.updatedAt)) {
    return "updatedAt must be a non-empty string";
  }

  if (!isNonEmptyString(value.cwd)) {
    return "cwd must be a non-empty string";
  }

  if (!isNonEmptyString(value.sessionFile)) {
    return "sessionFile must be a non-empty string";
  }

  const modelError = validateModelDescriptorFields(value.model, "model");
  if (modelError) {
    return modelError;
  }

  if (value.spawnDefaultModel !== undefined) {
    const sdmError = validateModelDescriptorFields(value.spawnDefaultModel, "spawnDefaultModel");
    if (sdmError) {
      return sdmError;
    }
  }

  if (value.archetypeId !== undefined && typeof value.archetypeId !== "string") {
    return "archetypeId must be a string when provided";
  }

  if (value.promptOverride !== undefined && typeof value.promptOverride !== "string") {
    return "promptOverride must be a string when provided";
  }

  const descriptor = value as unknown as AgentDescriptor;
  if (descriptor.status === normalizedStatus) {
    return descriptor;
  }

  return {
    ...descriptor,
    status: normalizedStatus
  };
}

function extractDescriptorAgentId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isNonEmptyString(value.agentId) ? value.agentId.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateModelDescriptorFields(value: unknown, fieldName: string): string | null {
  if (!isRecord(value)) {
    return `${fieldName} must be an object`;
  }
  if (!isNonEmptyString(value.provider)) {
    return `${fieldName}.provider must be a non-empty string`;
  }
  if (!isNonEmptyString(value.modelId)) {
    return `${fieldName}.modelId must be a non-empty string`;
  }
  if (!isNonEmptyString(value.thinkingLevel)) {
    return `${fieldName}.thinkingLevel must be a non-empty string`;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeAgentId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeOptionalAgentId(input: string | undefined): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isClaudeAgentSdkProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "claude-agent-sdk";
}

function parseThinkingLevel(value: unknown, fieldName: string): ThinkingLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !VALID_THINKING_LEVEL_VALUES.has(value)) {
    throw new Error(`${fieldName} must be one of ${THINKING_LEVELS.join("|")}`);
  }

  return value as ThinkingLevel;
}

function parseOptionalNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string when provided`);
  }

  return value.trim();
}

function normalizeManagedModelDescriptor(
  descriptor: (Pick<AgentModelDescriptor, "provider" | "modelId"> & { thinkingLevel?: string }) | undefined,
  options: { presetDefinitions: SwarmModelPresetDefinitions }
): AgentModelDescriptor {
  const provider = typeof descriptor?.provider === "string" ? descriptor.provider.trim() : "";
  const modelId = typeof descriptor?.modelId === "string" ? descriptor.modelId.trim() : "";
  const normalizedProvider = provider || "<missing>";
  const normalizedModelId = modelId || "<missing>";
  if (!provider || !modelId) {
    throw new Error(`Unsupported model descriptor ${normalizedProvider}/${normalizedModelId}`);
  }

  const inferredPreset = inferSwarmModelPresetFromDescriptor(
    {
      provider,
      modelId
    },
    { presetDefinitions: options.presetDefinitions }
  );

  const defaultThinkingLevel = inferredPreset
    ? resolveModelDescriptorFromPreset(inferredPreset, { presetDefinitions: options.presetDefinitions }).thinkingLevel
    : ("xhigh" as ThinkingLevel);
  const resolvedThinkingLevel =
    parseThinkingLevel(descriptor?.thinkingLevel, "model.thinkingLevel") ?? defaultThinkingLevel;

  if (inferredPreset) {
    const canonical = resolveModelDescriptorFromPreset(inferredPreset, {
      presetDefinitions: options.presetDefinitions
    });
    return {
      ...canonical,
      thinkingLevel: resolvedThinkingLevel
    };
  }

  if (!isSupportedExplicitModelDescriptor(provider, modelId)) {
    throw new Error(`Unsupported model descriptor ${provider}/${modelId}`);
  }

  return {
    provider,
    modelId,
    thinkingLevel: resolvedThinkingLevel
  };
}

function isSupportedExplicitModelDescriptor(provider: string, _modelId: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  return normalizedProvider === "openai-codex-app-server" || normalizedProvider === "claude-agent-sdk";
}

function normalizePromptOverride(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readPositiveIntegerDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!details) {
    return undefined;
  }

  const value = details[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function runtimeLabelForProvider(provider: string): "codex-app-server" | "claude-agent-sdk" {
  const normalized = provider.trim().toLowerCase();
  if (normalized.includes("codex-app")) {
    return "codex-app-server";
  }
  return "claude-agent-sdk";
}

function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const normalized: ConversationAttachment[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }

    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const fileName = typeof attachment.fileName === "string" ? attachment.fileName.trim() : "";
    const filePath = typeof attachment.filePath === "string" ? attachment.filePath.trim() : "";

    if (attachment.type === "text") {
      const text = typeof attachment.text === "string" ? attachment.text : "";
      if (!mimeType || text.trim().length === 0) {
        continue;
      }

      normalized.push({
        type: "text",
        mimeType,
        text,
        fileName: fileName || undefined,
        filePath: filePath || undefined
      });
      continue;
    }

    if (attachment.type === "binary") {
      const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
      if (!mimeType || data.length === 0) {
        continue;
      }

      normalized.push({
        type: "binary",
        mimeType,
        data,
        fileName: fileName || undefined,
        filePath: filePath || undefined
      });
      continue;
    }

    const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
    if (!mimeType || !mimeType.startsWith("image/") || !data) {
      continue;
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined,
      filePath: filePath || undefined
    });
  }

  return normalized;
}

function toRuntimeImageAttachments(attachments: ConversationAttachment[]): RuntimeImageAttachment[] {
  const images: RuntimeImageAttachment[] = [];

  for (const attachment of attachments) {
    if (!isConversationImageAttachment(attachment)) {
      continue;
    }

    images.push({
      mimeType: attachment.mimeType,
      data: attachment.data
    });
  }

  return images;
}

function formatTextAttachmentForPrompt(attachment: ConversationTextAttachment, index: number): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.txt`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    "Content:",
    "----- BEGIN FILE -----",
    attachment.text,
    "----- END FILE -----"
  ].join("\n");
}

function formatBinaryAttachmentForPrompt(
  attachment: ConversationBinaryAttachment,
  storedPath: string,
  index: number
): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.bin`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    `Saved to: ${storedPath}`,
    "Use read/bash tools to inspect the file directly from disk."
  ].join("\n");
}

function sanitizeAttachmentFileName(fileName: string | undefined, fallback: string): string {
  const fallbackName = fallback.trim() || "attachment.bin";
  const trimmed = typeof fileName === "string" ? fileName.trim() : "";

  if (!trimmed) {
    return fallbackName;
  }

  const cleaned = trimmed
    .replace(/[\\/]+/g, "-")
    .replace(/[\0-\x1f\x7f]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .slice(0, 120);

  return cleaned || fallbackName;
}

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return cleaned || fallback;
}

function normalizeOptionalAttachmentPath(path: string | undefined): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }

  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractRuntimeMessageText(message: string | RuntimeUserMessage): string {
  if (typeof message === "string") {
    return message;
  }

  return message.text;
}

function formatInboundUserMessageForManager(text: string, sourceContext: MessageSourceContext): string {
  const sourceMetadataLine = `[sourceContext] ${JSON.stringify(sourceContext)}`;
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return sourceMetadataLine;
  }

  return `${sourceMetadataLine}\n\n${trimmed}`;
}

function parseCompactSlashCommand(text: string): { customInstructions?: string } | undefined {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return undefined;
  }

  const customInstructions = match[1]?.trim();
  if (!customInstructions) {
    return {};
  }

  return {
    customInstructions
  };
}

function normalizeMessageTargetContext(input: MessageTargetContext): MessageTargetContext {
  return {
    channel:
      input.channel === "slack" || input.channel === "telegram"
        ? input.channel
        : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId)
  };
}

function normalizeMessageSourceContext(input: MessageSourceContext): MessageSourceContext {
  return {
    channel:
      input.channel === "slack" || input.channel === "telegram"
        ? input.channel
        : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    messageId: normalizeOptionalMetadataValue(input.messageId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId),
    channelType:
      input.channelType === "dm" ||
      input.channelType === "channel" ||
      input.channelType === "group" ||
      input.channelType === "mpim"
        ? input.channelType
        : undefined,
    teamId: normalizeOptionalMetadataValue(input.teamId)
  };
}

function normalizeOptionalMetadataValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
