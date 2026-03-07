import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { CodexJsonRpcClient, type JsonRpcNotificationMessage, type JsonRpcRequestMessage } from "./codex-jsonrpc-client.js";
import {
  createCodexToolBridge,
  type CodexDynamicToolCallResponse,
  type CodexToolBridge
} from "./codex-tool-bridge.js";
import {
  buildRuntimeMessageKey,
  consumePendingDeliveryByMessageKey,
  extractMessageKeyFromRuntimeContent,
  normalizeRuntimeError,
  normalizeRuntimeImageAttachments,
  normalizeRuntimeUserMessage,
  previewForLog
} from "./runtime-utils.js";
import { transitionAgentStatus } from "./agent-state-machine.js";
import { DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS } from "./model-preset-config.js";
import { persistSessionManagerCustomEntryIfNeeded } from "./session-manager-custom-entry-persistence.js";
import type {
  RuntimeImageAttachment,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
  SwarmAgentRuntime,
  SwarmRuntimeCallbacks
} from "./runtime-types.js";
import type {
  AgentContextUsage,
  CodexReasoningEffort,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt,
  ThinkingLevel
} from "./types.js";

const CODEX_RUNTIME_STATE_ENTRY_TYPE = "swarm_codex_runtime_state";
const CODEX_RUNTIME_STATE_FILE_SUFFIX = ".codex-runtime-state.json";
const CODEX_SANDBOX_MODE = "danger-full-access";

interface CodexRuntimeState {
  threadId: string;
}

interface CodexSandboxSettings {
  sandboxMode: typeof CODEX_SANDBOX_MODE;
  threadConfig: {
    sandbox_mode: typeof CODEX_SANDBOX_MODE;
  };
  turnSandboxPolicy: {
    type: "dangerFullAccess";
  };
}

interface PendingDelivery {
  deliveryId: string;
  messageKey: string;
}

interface QueuedSteer {
  deliveryId: string;
  message: RuntimeUserMessage;
}

interface ModelCapabilities {
  supportedEfforts: CodexReasoningEffort[];
}

const CODEX_EFFORT_RANK: Record<CodexReasoningEffort, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5
};

export class CodexAgentRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;

  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private readonly systemPrompt: string;
  private readonly sessionManager: SessionManager;
  private readonly toolBridge: CodexToolBridge;
  private readonly sandboxSettings: CodexSandboxSettings;
  private readonly runtimeStateFile: string;

  private readonly rpc: CodexJsonRpcClient;

  private status: AgentStatus;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private startRequestPending = false;

  private pendingDeliveries: PendingDelivery[] = [];
  private queuedSteers: QueuedSteer[] = [];
  private readonly toolNameByItemId = new Map<string, string>();
  private readonly thinkingLevelToEffort: Record<ThinkingLevel, CodexReasoningEffort>;
  private readonly modelCapabilitiesByKey = new Map<string, ModelCapabilities>();
  private modelCapabilitiesLoaded = false;
  private modelCapabilitiesLoadPromise: Promise<void> | undefined;
  private turnItemCount = 0;
  private contextUsage: AgentContextUsage | undefined;

  private constructor(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt: string;
    tools: ToolDefinition[];
    runtimeEnv?: Record<string, string | undefined>;
    thinkingLevelToEffort?: Record<ThinkingLevel, CodexReasoningEffort>;
  }) {
    this.descriptor = options.descriptor;
    this.callbacks = options.callbacks;
    this.now = options.now ?? (() => new Date().toISOString());
    this.systemPrompt = options.systemPrompt;
    this.status = options.descriptor.status;

    this.sessionManager = SessionManager.open(options.descriptor.sessionFile);
    this.runtimeStateFile = `${options.descriptor.sessionFile}${CODEX_RUNTIME_STATE_FILE_SUFFIX}`;
    this.toolBridge = createCodexToolBridge(options.tools);
    this.sandboxSettings = buildCodexSandboxSettings();
    this.thinkingLevelToEffort = {
      ...(options.thinkingLevelToEffort ?? DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS.codexAppServer)
    };

    const command = process.env.CODEX_BIN?.trim() || "codex";
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env
    };

    for (const [name, value] of Object.entries(options.runtimeEnv ?? {})) {
      if (typeof value === "string" && value.trim().length > 0) {
        runtimeEnv[name] = value;
      } else {
        delete runtimeEnv[name];
      }
    }

    this.rpc = new CodexJsonRpcClient({
      command,
      args: ["app-server", "--listen", "stdio://"],
      spawnOptions: {
        cwd: options.descriptor.cwd,
        env: runtimeEnv
      },
      onNotification: async (notification) => {
        await this.handleNotification(notification);
      },
      onRequest: async (request) => {
        return await this.handleServerRequest(request);
      },
      onExit: (error) => {
        void this.handleProcessExit(error);
      },
      onStderr: (line) => {
        this.logRuntimeInfo("stderr", { line });
      }
    });
  }

  static async create(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt: string;
    tools: ToolDefinition[];
    runtimeEnv?: Record<string, string | undefined>;
    thinkingLevelToEffort?: Record<ThinkingLevel, CodexReasoningEffort>;
  }): Promise<CodexAgentRuntime> {
    const runtime = new CodexAgentRuntime(options);

    try {
      await runtime.initialize();
      return runtime;
    } catch (error) {
      runtime.rpc.dispose();

      const normalized = normalizeCodexStartupError(error);
      runtime.logRuntimeError("startup", normalized, {
        action: "initialize"
      });
      throw normalized;
    }
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getPendingCount(): number {
    return this.pendingDeliveries.length;
  }

  getContextUsage(): AgentContextUsage | undefined {
    return this.contextUsage;
  }

  async sendMessage(
    input: RuntimeUserMessageInput,
    _requestedMode: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    this.ensureNotTerminated();

    const message = normalizeRuntimeUserMessage(input);
    const deliveryId = randomUUID();

    if (this.activeTurnId || this.startRequestPending) {
      this.queueSteer(deliveryId, message);
      await this.flushSteersIfPossible();
      await this.emitStatus();

      return {
        targetAgentId: this.descriptor.agentId,
        deliveryId,
        acceptedMode: "steer"
      };
    }

    try {
      await this.startTurn(message);
    } catch (error) {
      await this.recoverFromTurnFailure("prompt_start", error, {
        textPreview: previewForLog(message.text),
        imageCount: message.images?.length ?? 0
      });
      throw error;
    }

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId,
      acceptedMode: "prompt"
    };
  }

  async terminate(options?: { abort?: boolean }): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort && this.threadId && this.activeTurnId) {
      try {
        await this.rpc.request("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.activeTurnId
        });
      } catch (error) {
        this.logRuntimeError("interrupt", error, {
          threadId: this.threadId,
          turnId: this.activeTurnId
        });
        // Ignore best-effort interruption errors during shutdown.
      }
    }

    this.rpc.dispose();

    this.pendingDeliveries = [];
    this.queuedSteers = [];
    this.toolNameByItemId.clear();
    this.threadId = undefined;
    this.activeTurnId = undefined;
    this.startRequestPending = false;
    this.contextUsage = undefined;

    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();

    await this.emitStatus();
  }

  async stopInFlight(options?: { abort?: boolean }): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort && this.threadId && this.activeTurnId) {
      try {
        await this.rpc.request("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.activeTurnId
        });
      } catch (error) {
        this.logRuntimeError("interrupt", error, {
          threadId: this.threadId,
          turnId: this.activeTurnId
        });
      }
    }

    this.pendingDeliveries = [];
    this.queuedSteers = [];
    this.startRequestPending = false;
    this.activeTurnId = undefined;

    await this.updateStatus("idle");
  }

  async compact(): Promise<unknown> {
    this.ensureNotTerminated();
    throw new Error(`Agent ${this.descriptor.agentId} does not support manual compaction`);
  }

  getCustomEntries(customType: string): unknown[] {
    const entries = this.sessionManager.getEntries();
    const matches: unknown[] = [];

    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === customType) {
        matches.push(entry.data);
      }
    }

    return matches;
  }

  appendCustomEntry(customType: string, data?: unknown): void {
    this.sessionManager.appendCustomEntry(customType, data);
    persistSessionManagerCustomEntryIfNeeded(this.sessionManager);
  }

  private async initialize(): Promise<void> {
    await this.rpc.request("initialize", {
      clientInfo: {
        name: "swarm",
        title: "Swarm",
        version: "1.0.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.rpc.notify("initialized");

    await this.ensureAuth();
    await this.bootstrapThread();
  }

  private async ensureAuth(): Promise<void> {
    const account = await this.readAccount();
    if (!account.requiresOpenaiAuth || account.account) {
      return;
    }

    const apiKey = process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
    if (apiKey) {
      await this.rpc.request("account/login/start", {
        type: "apiKey",
        apiKey
      });
    }

    const refreshed = await this.readAccount();
    if (!refreshed.requiresOpenaiAuth || refreshed.account) {
      return;
    }

    throw new Error(
      "Codex runtime requires authentication. Run `codex login` or set CODEX_API_KEY in Settings."
    );
  }

  private async readAccount(): Promise<{ requiresOpenaiAuth: boolean; account: unknown }> {
    const result = await this.rpc.request<{
      requiresOpenaiAuth?: unknown;
      account?: unknown;
    }>("account/read", {
      refreshToken: false
    });

    return {
      requiresOpenaiAuth: result.requiresOpenaiAuth === true,
      account: result.account
    };
  }

  private async bootstrapThread(): Promise<void> {
    const persisted = this.readPersistedRuntimeState();
    if (persisted?.threadId) {
      this.logRuntimeInfo("resume_state", {
        outcome: "resume_attempt",
        persistedThreadId: persisted.threadId
      });
      try {
        const resumed = await this.rpc.request<{ thread?: { id?: unknown } }>("thread/resume", {
          threadId: persisted.threadId,
          cwd: this.descriptor.cwd,
          approvalPolicy: "never",
          sandbox: this.sandboxSettings.sandboxMode,
          config: this.sandboxSettings.threadConfig,
          developerInstructions: this.systemPrompt,
          model: this.descriptor.model.modelId
        });

        const resumedThreadId = parseThreadId(resumed.thread?.id);
        if (resumedThreadId) {
          this.threadId = resumedThreadId;
          this.persistRuntimeState();
          this.logRuntimeInfo("resume_state", {
            outcome: "resume_success",
            persistedThreadId: persisted.threadId,
            resumedThreadId
          });
          return;
        }
      } catch (error) {
        this.logRuntimeError("thread_resume", error, {
          threadId: persisted.threadId
        });
        // Fall through to thread/start when resume fails.
      }
    }

    const started = await this.rpc.request<{ thread?: { id?: unknown } }>("thread/start", {
      cwd: this.descriptor.cwd,
      approvalPolicy: "never",
      sandbox: this.sandboxSettings.sandboxMode,
      config: this.sandboxSettings.threadConfig,
      developerInstructions: this.systemPrompt,
      model: this.descriptor.model.modelId,
      dynamicTools: this.toolBridge.dynamicTools
    });

    const startedThreadId = parseThreadId(started.thread?.id);
    if (!startedThreadId) {
      throw new Error("Codex runtime did not return a thread id");
    }

    this.threadId = startedThreadId;
    this.persistRuntimeState();
    this.logRuntimeInfo("resume_state", {
      outcome: persisted?.threadId ? "fresh_start_after_resume_failure" : "fresh_start",
      ...(persisted?.threadId ? { persistedThreadId: persisted.threadId } : {}),
      startedThreadId
    });
  }

  private readPersistedRuntimeState(): CodexRuntimeState | undefined {
    const fromFile = this.readPersistedRuntimeStateFromFile();
    if (fromFile && typeof fromFile.threadId === "string" && fromFile.threadId.trim().length > 0) {
      return {
        threadId: fromFile.threadId.trim()
      };
    }

    const entries = this.getCustomEntries(CODEX_RUNTIME_STATE_ENTRY_TYPE);

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const maybe = entries[index] as { threadId?: unknown } | undefined;
      if (!maybe || typeof maybe.threadId !== "string" || maybe.threadId.trim().length === 0) {
        continue;
      }

      return {
        threadId: maybe.threadId
      };
    }

    return undefined;
  }

  private persistRuntimeState(): void {
    if (!this.threadId) {
      return;
    }

    this.writePersistedRuntimeStateFileSafe({
      threadId: this.threadId
    });
    this.appendCustomEntry(CODEX_RUNTIME_STATE_ENTRY_TYPE, {
      threadId: this.threadId
    });
  }

  private readPersistedRuntimeStateFromFile(): { threadId?: unknown } | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.runtimeStateFile, "utf8");
    } catch {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }

    if (!parsed || typeof parsed !== "object" || !("threadId" in parsed)) {
      return undefined;
    }

    return parsed as { threadId?: unknown };
  }

  private writePersistedRuntimeStateFile(state: { threadId: string }): void {
    mkdirSync(dirname(this.runtimeStateFile), { recursive: true });
    writeFileSync(this.runtimeStateFile, `${JSON.stringify(state)}\n`, "utf8");
  }

  private writePersistedRuntimeStateFileSafe(state: { threadId: string }): void {
    try {
      this.writePersistedRuntimeStateFile(state);
    } catch (error) {
      this.logRuntimeError("startup", error, {
        stage: "persist_runtime_state_file",
        sessionFile: this.descriptor.sessionFile
      });
    }
  }

  private async startTurn(message: RuntimeUserMessage): Promise<void> {
    this.ensureNotTerminated();

    if (!this.threadId) {
      throw new Error("Codex runtime thread is not initialized");
    }

    this.startRequestPending = true;

    try {
      const requestedEffort = this.resolveRequestedEffort();
      const effectiveEffort = await this.resolveEffectiveEffort(this.descriptor.model.modelId, requestedEffort);
      const response = await this.rpc.request<{ turn?: { id?: unknown } }>("turn/start", {
        threadId: this.threadId,
        cwd: this.descriptor.cwd,
        sandboxPolicy: this.sandboxSettings.turnSandboxPolicy,
        model: this.descriptor.model.modelId,
        effort: effectiveEffort,
        input: toCodexInputItems(message)
      });

      this.logRuntimeInfo("turn_start_config", {
        model: this.descriptor.model.modelId,
        requestedEffort,
        effectiveEffort,
        effortClamped: requestedEffort !== effectiveEffort
      });

      const turnId = parseThreadId(response.turn?.id);
      if (turnId) {
        this.activeTurnId = turnId;
      }

      await this.updateStatus("streaming");
      await this.flushSteersIfPossible();
    } finally {
      this.startRequestPending = false;
    }
  }

  private resolveRequestedEffort(): CodexReasoningEffort {
    const thinkingLevel = normalizeThinkingLevel(this.descriptor.model.thinkingLevel);
    return this.thinkingLevelToEffort[thinkingLevel] ?? this.thinkingLevelToEffort.medium;
  }

  private async resolveEffectiveEffort(
    modelId: string,
    requestedEffort: CodexReasoningEffort
  ): Promise<CodexReasoningEffort> {
    const capabilities = await this.getModelCapabilities(modelId);
    if (!capabilities || capabilities.supportedEfforts.length === 0) {
      return requestedEffort;
    }

    return clampEffortToSupportedFloor(requestedEffort, capabilities.supportedEfforts);
  }

  private async getModelCapabilities(modelId: string): Promise<ModelCapabilities | undefined> {
    await this.loadModelCapabilities();
    const normalizedModel = normalizeModelKey(modelId);
    if (!normalizedModel) {
      return undefined;
    }

    return this.modelCapabilitiesByKey.get(normalizedModel);
  }

  private async loadModelCapabilities(): Promise<void> {
    if (this.modelCapabilitiesLoaded) {
      return;
    }

    if (!this.modelCapabilitiesLoadPromise) {
      this.modelCapabilitiesLoadPromise = (async () => {
        try {
          const response = await this.rpc.request<{ data?: unknown }>("model/list", {});
          this.modelCapabilitiesByKey.clear();
          for (const capability of parseModelCapabilities(response?.data)) {
            this.modelCapabilitiesByKey.set(capability.modelKey, {
              supportedEfforts: capability.supportedEfforts
            });
          }
          this.modelCapabilitiesLoaded = true;
        } catch (error) {
          this.logRuntimeError("prompt_start", error, {
            action: "model/list"
          });
        } finally {
          this.modelCapabilitiesLoadPromise = undefined;
        }
      })();
    }

    await this.modelCapabilitiesLoadPromise;
  }

  private queueSteer(deliveryId: string, message: RuntimeUserMessage): void {
    this.queuedSteers.push({
      deliveryId,
      message
    });

    this.pendingDeliveries.push({
      deliveryId,
      messageKey: buildRuntimeMessageKey(message)
    });
  }

  private async flushSteersIfPossible(): Promise<void> {
    if (!this.threadId || !this.activeTurnId) {
      return;
    }

    while (this.queuedSteers.length > 0 && this.activeTurnId) {
      const queued = this.queuedSteers[0];

      try {
        await this.rpc.request("turn/steer", {
          threadId: this.threadId,
          expectedTurnId: this.activeTurnId,
          input: toCodexInputItems(queued.message)
        });

        this.queuedSteers.shift();
      } catch (error) {
        await this.recoverFromTurnFailure("steer_delivery", error, {
          queuedDeliveryId: queued.deliveryId,
          queuedCount: this.queuedSteers.length,
          pendingCount: this.pendingDeliveries.length,
          activeTurnId: this.activeTurnId
        });
        break;
      }
    }
  }

  private async handleNotification(notification: JsonRpcNotificationMessage): Promise<void> {
    switch (notification.method) {
      case "turn/started": {
        const turnId = parseThreadId(
          (notification.params as { turn?: { id?: unknown } } | undefined)?.turn?.id
        );

        if (turnId) {
          this.activeTurnId = turnId;
        }

        this.startRequestPending = false;
        this.turnItemCount = 0;
        await this.emitSessionEvent({ type: "agent_start" });
        await this.emitSessionEvent({ type: "turn_start" });
        await this.updateStatus("streaming");
        await this.flushSteersIfPossible();
        return;
      }

      case "turn/completed": {
        const completedParams = notification.params as {
          lastTurnError?: unknown;
          error?: unknown;
          status?: unknown;
          [key: string]: unknown;
        } | undefined;

        if (completedParams) {
          const turnError = completedParams.lastTurnError ?? completedParams.error;
          if (turnError) {
            this.logRuntimeInfo("turn_completed_error", {
              error: turnError,
              status: completedParams.status
            });
            await this.reportRuntimeError({
              phase: "turn_completed",
              message: typeof turnError === "string"
                ? turnError
                : typeof turnError === "object" && turnError !== null && "message" in turnError
                  ? String((turnError as { message: unknown }).message)
                  : JSON.stringify(turnError),
              details: { status: completedParams.status }
            });
          }
        }

        if (this.turnItemCount === 0) {
          this.logRuntimeInfo("turn_completed_empty", {
            message: "Turn completed with zero items (no text, no tool calls). The model may have failed silently."
          });
          await this.reportRuntimeError({
            phase: "turn_completed",
            message: "Worker turn completed with no output. This usually indicates a model error (invalid model, auth failure, or API error). Check codex stderr logs above for details.",
            details: { turnItemCount: 0 }
          });
        }

        this.startRequestPending = false;
        this.activeTurnId = undefined;
        this.turnItemCount = 0;

        await this.emitSessionEvent({
          type: "turn_end",
          toolResults: []
        });
        await this.emitSessionEvent({ type: "agent_end" });

        if (this.status !== "terminated") {
          await this.updateStatus("idle");
        }

        if (this.callbacks.onAgentEnd) {
          await this.callbacks.onAgentEnd(this.descriptor.agentId);
        }

        return;
      }

      case "thread/tokenUsage/updated": {
        this.updateContextUsageFromNotification(notification.params);
        await this.emitStatus();
        return;
      }

      case "item/started": {
        await this.handleItemEvent("started", notification.params);
        return;
      }

      case "item/completed": {
        await this.handleItemEvent("completed", notification.params);
        return;
      }

      case "item/agentMessage/delta": {
        const params = notification.params as {
          delta?: unknown;
        };

        const delta = typeof params?.delta === "string" ? params.delta : "";
        await this.emitSessionEvent({
          type: "message_update",
          message: {
            role: "assistant",
            content: delta
          }
        });
        return;
      }

      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const params = notification.params as {
          itemId?: unknown;
          delta?: unknown;
        };

        const itemId = typeof params?.itemId === "string" ? params.itemId : "unknown";
        const toolName = this.toolNameByItemId.get(itemId) ?? notification.method;

        await this.emitSessionEvent({
          type: "tool_execution_update",
          toolName,
          toolCallId: itemId,
          partialResult: typeof params?.delta === "string" ? params.delta : ""
        });

        return;
      }

      default:
        return;
    }
  }

  private async handleItemEvent(stage: "started" | "completed", params: unknown): Promise<void> {
    const item = parseThreadItemFromNotification(params);
    if (!item) {
      return;
    }

    if (stage === "started" && item.type !== "userMessage") {
      this.turnItemCount += 1;
    }

    if (item.type === "userMessage") {
      const message = toRuntimeMessageFromUserItem(item.content);

      if (stage === "started") {
        await this.emitSessionEvent({
          type: "message_start",
          message: {
            role: "user",
            content: message
          }
        });

        const key = extractMessageKeyFromRuntimeContent(message);
        if (key) {
          this.consumePendingMessage(key);
          await this.emitStatus();
        }

        return;
      }

      await this.emitSessionEvent({
        type: "message_end",
        message: {
          role: "user",
          content: message
        }
      });

      return;
    }

    if (item.type === "agentMessage") {
      const eventType = stage === "started" ? "message_start" : "message_end";
      await this.emitSessionEvent({
        type: eventType,
        message: {
          role: "assistant",
          content: item.text
        }
      });
      return;
    }

    if (isToolLikeThreadItem(item.type)) {
      if (stage === "started") {
        const toolName = toolNameForThreadItem(item);
        this.toolNameByItemId.set(item.id, toolName);

        await this.emitSessionEvent({
          type: "tool_execution_start",
          toolName,
          toolCallId: item.id,
          args: item
        });
        return;
      }

      const toolName = this.toolNameByItemId.get(item.id) ?? toolNameForThreadItem(item);
      this.toolNameByItemId.delete(item.id);

      await this.emitSessionEvent({
        type: "tool_execution_end",
        toolName,
        toolCallId: item.id,
        result: item,
        isError: threadItemRepresentsError(item)
      });
    }
  }

  private updateContextUsageFromNotification(params: unknown): void {
    const payload = params as {
      threadId?: unknown;
      tokenUsage?: {
        last?: {
          totalTokens?: unknown;
        };
        total?: {
          totalTokens?: unknown;
        };
        modelContextWindow?: unknown;
      };
    } | undefined;

    if (typeof payload?.threadId !== "string" || !this.threadId || payload.threadId !== this.threadId) {
      return;
    }

    // Codex uses last_token_usage for live context window display; total_token_usage is lifetime spend.
    const tokens = asNonNegativeInteger(payload.tokenUsage?.last?.totalTokens);
    const contextWindow = asNonNegativeInteger(payload.tokenUsage?.modelContextWindow);
    if (!Number.isFinite(tokens) || tokens < 0 || contextWindow <= 0) {
      return;
    }

    const percent = Math.max(0, Math.min(100, (tokens / contextWindow) * 100));
    this.contextUsage = {
      tokens,
      contextWindow,
      percent
    };
  }

  private consumePendingMessage(messageKey: string): void {
    consumePendingDeliveryByMessageKey(this.pendingDeliveries, messageKey);
  }

  private async handleServerRequest(request: JsonRpcRequestMessage): Promise<unknown> {
    switch (request.method) {
      case "item/tool/call": {
        const params = request.params as {
          tool?: unknown;
          callId?: unknown;
          arguments?: unknown;
        };

        const tool = typeof params?.tool === "string" ? params.tool : "";
        const callId = typeof params?.callId === "string" ? params.callId : "tool-call";

        await this.emitSessionEvent({
          type: "tool_execution_start",
          toolName: tool,
          toolCallId: callId,
          args: params?.arguments
        });

        let response: CodexDynamicToolCallResponse;
        let isError = false;
        try {
          response = await this.toolBridge.handleToolCall({
            tool,
            callId,
            arguments: params?.arguments
          });
        } catch (error) {
          isError = true;
          const message = error instanceof Error ? error.message : String(error);
          response = {
            success: false,
            contentItems: [{ type: "inputText", text: `Tool ${tool} failed: ${message}` }]
          };
        }

        if (!response.success) {
          isError = true;
        }

        await this.emitSessionEvent({
          type: "tool_execution_end",
          toolName: tool,
          toolCallId: callId,
          result: response,
          isError
        });

        return response;
      }

      case "item/commandExecution/requestApproval":
        return {
          decision: "accept"
        };

      case "item/fileChange/requestApproval":
        return {
          decision: "accept"
        };

      case "item/tool/requestUserInput": {
        const questions =
          (request.params as { questions?: Array<{ id?: unknown }> } | undefined)?.questions ?? [];

        const answers: Record<string, { answers: string[] }> = {};
        for (const question of questions) {
          if (!question || typeof question.id !== "string") {
            continue;
          }

          answers[question.id] = {
            answers: []
          };
        }

        return {
          answers
        };
      }

      default:
        throw new Error(`Unsupported server request: ${request.method}`);
    }
  }

  private async handleProcessExit(error: Error): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    this.logRuntimeError("runtime_exit", error, {
      activeTurnId: this.activeTurnId,
      queuedCount: this.queuedSteers.length,
      pendingCount: this.pendingDeliveries.length
    });
    await this.reportRuntimeError({
      phase: "runtime_exit",
      message: error.message,
      stack: error.stack,
      details: {
        activeTurnId: this.activeTurnId,
        queuedCount: this.queuedSteers.length,
        pendingCount: this.pendingDeliveries.length
      }
    });

    this.pendingDeliveries = [];
    this.queuedSteers = [];
    this.toolNameByItemId.clear();
    this.startRequestPending = false;
    this.activeTurnId = undefined;
    this.threadId = undefined;

    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();

    await this.emitStatus();

    await this.emitSessionEvent({
      type: "tool_execution_end",
      toolName: "codex-app-server",
      toolCallId: "runtime-exit",
      result: error.message,
      isError: true
    });
  }

  private ensureNotTerminated(): void {
    if (this.status === "terminated") {
      throw new Error(`Agent ${this.descriptor.agentId} is terminated`);
    }
  }

  private async updateStatus(status: AgentStatus): Promise<void> {
    if (this.status === status) {
      await this.emitStatus();
      return;
    }

    const nextStatus = transitionAgentStatus(this.status, status);
    this.status = nextStatus;
    this.descriptor.status = nextStatus;
    this.descriptor.updatedAt = this.now();

    await this.emitStatus();
  }

  private async emitStatus(): Promise<void> {
    await this.callbacks.onStatusChange(
      this.descriptor.agentId,
      this.status,
      this.pendingDeliveries.length,
      this.getContextUsage()
    );
  }

  private async emitSessionEvent(event: RuntimeSessionEvent): Promise<void> {
    if (!this.callbacks.onSessionEvent) {
      return;
    }

    await this.callbacks.onSessionEvent(this.descriptor.agentId, event);
  }

  private async recoverFromTurnFailure(
    phase: RuntimeErrorEvent["phase"],
    error: unknown,
    details?: Record<string, unknown>
  ): Promise<void> {
    const normalized = normalizeRuntimeError(error);
    this.logRuntimeError(phase, error, details);
    await this.reportRuntimeError({
      phase,
      message: normalized.message,
      stack: normalized.stack,
      details
    });

    if (this.status === "terminated") {
      return;
    }

    const hadActiveTurn = this.status === "streaming" || Boolean(this.activeTurnId);
    this.startRequestPending = false;
    this.activeTurnId = undefined;
    await this.updateStatus("idle");

    if (hadActiveTurn) {
      await this.emitSessionEvent({
        type: "turn_end",
        toolResults: []
      });
      await this.emitSessionEvent({ type: "agent_end" });

      if (this.callbacks.onAgentEnd) {
        try {
          await this.callbacks.onAgentEnd(this.descriptor.agentId);
        } catch (callbackError) {
          this.logRuntimeError(phase, callbackError, {
            callback: "onAgentEnd"
          });
        }
      }
    }
  }

  private async reportRuntimeError(error: RuntimeErrorEvent): Promise<void> {
    if (!this.callbacks.onRuntimeError) {
      return;
    }

    try {
      await this.callbacks.onRuntimeError(this.descriptor.agentId, error);
    } catch (callbackError) {
      this.logRuntimeError(error.phase, callbackError, {
        callback: "onRuntimeError"
      });
    }
  }

  private logRuntimeError(
    phase: RuntimeErrorEvent["phase"],
    error: unknown,
    details?: Record<string, unknown>
  ): void {
    const normalized = normalizeRuntimeError(error);
    console.error(`[swarm][${this.now()}] runtime:error`, {
      runtime: "codex-app-server",
      agentId: this.descriptor.agentId,
      phase,
      message: normalized.message,
      stack: normalized.stack,
      ...details
    });
  }

  private logRuntimeInfo(event: string, details?: Record<string, unknown>): void {
    console.info(`[swarm][${this.now()}] runtime:info`, {
      runtime: "codex-app-server",
      agentId: this.descriptor.agentId,
      event,
      ...details
    });
  }
}

// Codex app-server defaults new threads to read-only sandboxing.
// We use danger-full-access so agents have unrestricted filesystem access.
function buildCodexSandboxSettings(): CodexSandboxSettings {
  return {
    sandboxMode: CODEX_SANDBOX_MODE,
    threadConfig: {
      sandbox_mode: CODEX_SANDBOX_MODE,
    },
    turnSandboxPolicy: {
      type: "dangerFullAccess",
    }
  };
}

function normalizeCodexStartupError(error: unknown): Error {
  if (isSpawnEnoentError(error)) {
    return new Error(
      "Codex CLI is not installed or not available on PATH. Install codex or choose the claude-agent-sdk preset."
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

function isSpawnEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function parseThreadId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeThinkingLevel(value: string): ThinkingLevel {
  const normalized = value.trim().toLowerCase();
  if (normalized === "x-high" || normalized === "xhigh") {
    return "xhigh";
  }
  if (normalized === "off") {
    return "off";
  }
  if (normalized === "minimal") {
    return "minimal";
  }
  if (normalized === "low") {
    return "low";
  }
  if (normalized === "medium") {
    return "medium";
  }
  if (normalized === "high") {
    return "high";
  }
  return "medium";
}

function normalizeModelKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function parseModelCapabilities(data: unknown): Array<{ modelKey: string; supportedEfforts: CodexReasoningEffort[] }> {
  if (!Array.isArray(data)) {
    return [];
  }

  const capabilities: Array<{ modelKey: string; supportedEfforts: CodexReasoningEffort[] }> = [];

  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const typed = entry as {
      id?: unknown;
      model?: unknown;
      supportedReasoningEfforts?: unknown;
      supported_reasoning_efforts?: unknown;
      defaultReasoningEffort?: unknown;
      default_reasoning_effort?: unknown;
    };

    const modelKeys = [typed.model, typed.id]
      .map((value) => normalizeModelKey(value))
      .filter((value): value is string => Boolean(value));
    if (modelKeys.length === 0) {
      continue;
    }

    const defaultEffort = parseEffort(typed.defaultReasoningEffort ?? typed.default_reasoning_effort);
    const rawSupported = typed.supportedReasoningEfforts ?? typed.supported_reasoning_efforts;
    const supportedEfforts = parseSupportedEfforts(rawSupported, defaultEffort);
    if (supportedEfforts.length === 0) {
      continue;
    }

    for (const modelKey of modelKeys) {
      capabilities.push({
        modelKey,
        supportedEfforts
      });
    }
  }

  return capabilities;
}

function parseSupportedEfforts(
  value: unknown,
  defaultEffort: CodexReasoningEffort | undefined
): CodexReasoningEffort[] {
  const efforts: CodexReasoningEffort[] = [];

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        const parsed = parseEffort(entry);
        if (parsed) {
          efforts.push(parsed);
        }
        continue;
      }

      if (entry && typeof entry === "object") {
        const parsed = parseEffort(
          (entry as { reasoningEffort?: unknown; reasoning_effort?: unknown }).reasoningEffort ??
            (entry as { reasoningEffort?: unknown; reasoning_effort?: unknown }).reasoning_effort
        );
        if (parsed) {
          efforts.push(parsed);
        }
      }
    }
  }

  if (efforts.length === 0 && defaultEffort) {
    efforts.push(defaultEffort);
  }

  const deduped = Array.from(new Set(efforts));
  deduped.sort((left, right) => CODEX_EFFORT_RANK[left] - CODEX_EFFORT_RANK[right]);
  return deduped;
}

function parseEffort(value: unknown): CodexReasoningEffort | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "none" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }

  return undefined;
}

function clampEffortToSupportedFloor(
  requestedEffort: CodexReasoningEffort,
  supportedEfforts: CodexReasoningEffort[]
): CodexReasoningEffort {
  if (supportedEfforts.length === 0) {
    return requestedEffort;
  }

  const requestedRank = CODEX_EFFORT_RANK[requestedEffort];
  let floorEffort: CodexReasoningEffort | undefined;

  for (const effort of supportedEfforts) {
    if (CODEX_EFFORT_RANK[effort] > requestedRank) {
      break;
    }
    floorEffort = effort;
  }

  return floorEffort ?? supportedEfforts[0];
}

function parseThreadItemFromNotification(value: unknown):
  | {
      type: string;
      id: string;
      text?: string;
      content?: unknown[];
      [key: string]: unknown;
    }
  | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const item = (value as { item?: unknown }).item;
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const typed = item as {
    type?: unknown;
    id?: unknown;
    text?: unknown;
    content?: unknown;
  };

  if (typeof typed.type !== "string" || typeof typed.id !== "string") {
    return undefined;
  }

  return {
    ...(item as Record<string, unknown>),
    type: typed.type,
    id: typed.id,
    text: typeof typed.text === "string" ? typed.text : undefined,
    content: Array.isArray(typed.content) ? typed.content : undefined
  };
}

function isToolLikeThreadItem(type: string): boolean {
  return (
    type === "commandExecution" ||
    type === "fileChange" ||
    type === "mcpToolCall" ||
    type === "collabAgentToolCall" ||
    type === "webSearch" ||
    type === "imageView"
  );
}

function toolNameForThreadItem(item: { type: string; [key: string]: unknown }): string {
  switch (item.type) {
    case "commandExecution":
      return "command_execution";

    case "fileChange":
      return "file_change";

    case "mcpToolCall": {
      const server = typeof item.server === "string" ? item.server : "unknown";
      const tool = typeof item.tool === "string" ? item.tool : "unknown";
      return `mcp:${server}/${tool}`;
    }

    case "collabAgentToolCall": {
      const tool = typeof item.tool === "string" ? item.tool : "unknown";
      return `collab:${tool}`;
    }

    case "webSearch":
      return "web_search";

    case "imageView":
      return "image_view";

    default:
      return item.type;
  }
}

function threadItemRepresentsError(item: { type: string; [key: string]: unknown }): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange": {
      const status = typeof item.status === "string" ? item.status : "";
      return status === "failed" || status === "declined";
    }

    case "mcpToolCall":
    case "collabAgentToolCall": {
      const status = typeof item.status === "string" ? item.status : "";
      return status === "failed";
    }

    default:
      return false;
  }
}

function toCodexInputItems(message: RuntimeUserMessage): unknown[] {
  const items: unknown[] = [];
  const text = message.text ?? "";

  if (text.length > 0 || !(message.images && message.images.length > 0)) {
    items.push({
      type: "text",
      text,
      text_elements: []
    });
  }

  for (const image of normalizeRuntimeImageAttachments(message.images)) {
    items.push({
      type: "image",
      url: toDataUrl(image)
    });
  }

  return items;
}

function toRuntimeMessageFromUserItem(content: unknown[] | undefined): unknown {
  if (!content || content.length === 0) {
    return "";
  }

  const textParts: string[] = [];
  const imageParts: RuntimeImageAttachment[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const typed = item as {
      type?: unknown;
      text?: unknown;
      url?: unknown;
    };

    if (typed.type === "text" && typeof typed.text === "string") {
      textParts.push(typed.text);
      continue;
    }

    if (typed.type === "image" && typeof typed.url === "string") {
      const parsed = parseDataUrl(typed.url);
      if (parsed) {
        imageParts.push(parsed);
      }
    }
  }

  const text = textParts.join("\n").trim();

  if (imageParts.length === 0) {
    return text;
  }

  const parts: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [];

  if (text.length > 0) {
    parts.push({
      type: "text",
      text
    });
  }

  for (const image of imageParts) {
    parts.push({
      type: "image",
      mimeType: image.mimeType,
      data: image.data
    });
  }

  return parts;
}

function toDataUrl(image: RuntimeImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function parseDataUrl(value: string): RuntimeImageAttachment | undefined {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(value.trim());
  if (!match) {
    return undefined;
  }

  return {
    mimeType: match[1],
    data: match[2]
  };
}

function asNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : -1;
}
