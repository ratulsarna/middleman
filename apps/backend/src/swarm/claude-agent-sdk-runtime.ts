import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createSdkMcpServer,
  query,
  type ThinkingConfig,
  type SettingSource,
  type Query,
  type SDKAssistantMessage,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultError,
  type SDKResultMessage
} from "@anthropic-ai/claude-agent-sdk";
import { refreshAnthropicToken } from "@mariozechner/pi-ai/dist/utils/oauth/anthropic.js";
import { AuthStorage, SessionManager, type AuthCredential, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { z, type ZodType } from "zod";
import { DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS } from "./model-preset-config.js";
import { transitionAgentStatus } from "./agent-state-machine.js";
import {
  normalizeRuntimeError,
  normalizeRuntimeUserMessage
} from "./runtime-utils.js";
import { persistSessionManagerCustomEntryIfNeeded } from "./session-manager-custom-entry-persistence.js";
import type {
  RuntimeErrorEvent,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
  SwarmAgentRuntime,
  SwarmRuntimeCallbacks
} from "./runtime-types.js";
import type {
  AgentContextUsage,
  ClaudeReasoningEffort,
  ClaudeThinkingMode,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt,
  ThinkingLevel
} from "./types.js";

const AUTH_REQUIRED_ERROR_CODE = "CLAUDE_AGENT_SDK_AUTH_REQUIRED";
const RESUME_RECOVERY_ERROR_CODE = "CLAUDE_AGENT_SDK_RESUME_RECOVERY";
const TOOL_MCP_SERVER_NAME = "swarm-tools";
const CLAUDE_RUNTIME_STATE_ENTRY_TYPE = "swarm_claude_agent_sdk_runtime_state";
const CLAUDE_RUNTIME_STATE_FILE_SUFFIX = ".claude-runtime-state.json";
const CLAUDE_EFFORT_RANK: Record<ClaudeReasoningEffort, number> = {
  low: 1,
  medium: 2,
  high: 3,
  max: 4
};
const CLAUDE_FALLBACK_SUPPORTED_EFFORTS: ClaudeReasoningEffort[] = ["low", "medium", "high"];

interface PendingDelivery {
  deliveryId: string;
  message: RuntimeUserMessage;
}

interface ActiveToolProgress {
  toolName: string;
}

interface AuthTokenResolution {
  token: string;
  refreshToken?: string;
}

interface ClaudeRuntimeState {
  sessionId: string;
}

interface ClaudeSettingsPolicy {
  primarySources: SettingSource[];
  fallbackSources: SettingSource[];
  enableFallbackOnReadError: boolean;
}

interface ClaudeRequestedReasoningConfig {
  thinking: ClaudeThinkingMode;
  effort?: ClaudeReasoningEffort;
}

interface ClaudeResolvedReasoningConfig {
  requestedThinking: ClaudeThinkingMode;
  effectiveThinking: ClaudeThinkingMode;
  thinkingConfig: ThinkingConfig;
  requestedEffort?: ClaudeReasoningEffort;
  effectiveEffort?: ClaudeReasoningEffort;
}

interface ClaudeExecutionErrorDetails extends Record<string, unknown> {
  runtime: "claude-agent-sdk";
  outcome: string;
  deliveryId: string;
  promptPreview: string;
  usedResume: boolean;
  attemptedResumeId?: string;
  sessionIdAtStart?: string;
  sessionIdAtEnd?: string;
  assistantMessages: number;
  assistantErrorCount: number;
  toolProgressEvents: number;
  toolSummaryEvents: number;
  authStatusEvents: number;
  resultMessages: number;
  resultSubtype?: string;
  lastAssistantError?: string;
  lastAssistantErrorMessage?: string;
  lastAuthStatusError?: string;
  stderrSummary?: string;
  normalizedMessage?: string;
}

export class ClaudeAgentSdkRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;

  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private readonly systemPrompt: string;
  private readonly authStorage: AuthStorage;
  private readonly sessionManager: SessionManager;
  private readonly runtimeEnv: Record<string, string | undefined>;
  private readonly settingsPolicy: ClaudeSettingsPolicy;
  private readonly thinkingLevelToConfig: Record<ThinkingLevel, ClaudeRequestedReasoningConfig>;
  private readonly sdkMcpServer: ReturnType<typeof createSdkMcpServer>;
  private readonly runtimeStateFile: string;

  private status: AgentStatus;
  private contextUsage: AgentContextUsage | undefined;
  private pendingDeliveries: PendingDelivery[] = [];
  private processingLoop: Promise<void> | undefined;
  private currentQuery: Query | undefined;
  private currentAbortController: AbortController | undefined;
  private activeToolsById = new Map<string, ActiveToolProgress>();
  private readonly resumeRecoveryAttemptedDeliveryIds = new Set<string>();
  private readonly settingsFallbackAttemptedDeliveryIds = new Set<string>();
  private readonly fallbackSettingsDeliveryIds = new Set<string>();
  private isTerminating = false;
  private isStopping = false;
  private sessionId: string | undefined;

  private constructor(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt: string;
    tools: ToolDefinition[];
    authFile: string;
    runtimeEnv?: Record<string, string | undefined>;
    settingsPolicy?: Partial<ClaudeSettingsPolicy>;
    thinkingLevelToConfig?: Record<ThinkingLevel, ClaudeRequestedReasoningConfig>;
  }) {
    this.descriptor = options.descriptor;
    this.callbacks = options.callbacks;
    this.now = options.now ?? (() => new Date().toISOString());
    this.systemPrompt = options.systemPrompt;
    this.status = options.descriptor.status;
    this.authStorage = AuthStorage.create(options.authFile);
    this.sessionManager = SessionManager.open(options.descriptor.sessionFile);
    this.runtimeStateFile = `${options.descriptor.sessionFile}${CLAUDE_RUNTIME_STATE_FILE_SUFFIX}`;
    this.sessionId = this.readPersistedRuntimeState()?.sessionId;
    this.runtimeEnv = {
      ...options.runtimeEnv
    };
    this.settingsPolicy = normalizeSettingsPolicy(options.settingsPolicy);
    this.thinkingLevelToConfig = {
      ...(options.thinkingLevelToConfig ?? DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS.claudeAgentSdk)
    };

    this.sdkMcpServer = createSdkMcpServer({
      name: TOOL_MCP_SERVER_NAME,
      tools: options.tools.map((toolDefinition) => ({
        name: toolDefinition.name,
        description: toolDefinition.description,
        inputSchema: typeBoxSchemaToZodObject(toolDefinition.parameters) as any,
        handler: async (args: unknown) => {
          try {
            const result = await toolDefinition.execute(
              randomUUID(),
              args as any,
              undefined,
              undefined,
              undefined as any
            );

            return {
              content: result.content as any,
              structuredContent: {
                details: result.details
              },
              isError: false
            } as any;
          } catch (error) {
            const normalized = normalizeRuntimeError(error);
            return {
              content: [
                {
                  type: "text",
                  text: normalized.message
                }
              ],
              isError: true
            } as any;
          }
        }
      })) as any
    });
  }

  static async create(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt: string;
    tools: ToolDefinition[];
    authFile: string;
    runtimeEnv?: Record<string, string | undefined>;
    settingsPolicy?: Partial<ClaudeSettingsPolicy>;
    thinkingLevelToConfig?: Record<ThinkingLevel, ClaudeRequestedReasoningConfig>;
  }): Promise<ClaudeAgentSdkRuntime> {
    const runtime = new ClaudeAgentSdkRuntime(options);

    await runtime.resolveAuthToken();

    return runtime;
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

    const deliveryId = randomUUID();
    const message = normalizeRuntimeUserMessage(input);
    const acceptedMode = this.isBusy() ? "followUp" : "prompt";

    this.pendingDeliveries.push({
      deliveryId,
      message
    });

    this.startProcessingLoopIfNeeded();
    await this.emitStatus();

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId,
      acceptedMode
    };
  }

  async terminate(options?: { abort?: boolean }): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    this.isTerminating = true;
    const shouldAbort = options?.abort ?? true;

    if (shouldAbort) {
      this.isStopping = true;
      await this.interruptCurrentQuery();
    }

    this.pendingDeliveries = [];
    this.processingLoop = undefined;
    this.activeToolsById.clear();
    this.settingsFallbackAttemptedDeliveryIds.clear();
    this.fallbackSettingsDeliveryIds.clear();

    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();
    this.contextUsage = undefined;
    await this.emitStatus();

    this.isStopping = false;
  }

  async stopInFlight(options?: { abort?: boolean }): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    const shouldAbort = options?.abort ?? true;
    this.isStopping = true;

    if (shouldAbort) {
      await this.interruptCurrentQuery();
    }

    this.pendingDeliveries = [];
    this.activeToolsById.clear();
    this.settingsFallbackAttemptedDeliveryIds.clear();
    this.fallbackSettingsDeliveryIds.clear();

    await this.updateStatus("idle");
    this.isStopping = false;
  }

  async compact(): Promise<unknown> {
    this.ensureNotTerminated();
    throw new Error(`Agent ${this.descriptor.agentId} does not support manual compaction`);
  }

  async getClaudeOutputStyleMetadata(): Promise<{
    selectedStyle: string | null;
    availableStyles: string[];
  }> {
    this.ensureNotTerminated();

    const auth = await this.resolveAuthToken();
    let settingSources = [...this.settingsPolicy.primarySources];
    try {
      this.validateProjectSettingsReadableOrThrow(settingSources);
    } catch (error) {
      if (
        this.settingsPolicy.enableFallbackOnReadError &&
        this.settingsPolicy.fallbackSources.length > 0
      ) {
        settingSources = [...this.settingsPolicy.fallbackSources];
      } else {
        throw error;
      }
    }

    const abortController = new AbortController();
    const queryControl = this.createClaudeQuery({
      prompt: "Nexus output style metadata probe.",
      settingSources,
      auth,
      abortController,
      attemptedResumeId: undefined,
      reasoning: {
        requestedThinking: "disabled",
        effectiveThinking: "disabled",
        thinkingConfig: { type: "disabled" },
        requestedEffort: undefined,
        effectiveEffort: undefined
      },
      onStderr: () => {}
    });

    try {
      const initializationResult = await queryControl.initializationResult();
      return {
        selectedStyle: normalizeOutputStyleMetadataValue(initializationResult.output_style),
        availableStyles: normalizeOutputStyleMetadataList(initializationResult.available_output_styles)
      };
    } finally {
      abortController.abort();
      try {
        await queryControl.interrupt();
      } catch {
        // Best-effort cleanup for metadata probe query.
      }
    }
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

  private isBusy(): boolean {
    return this.currentQuery !== undefined || this.processingLoop !== undefined;
  }

  private startProcessingLoopIfNeeded(): void {
    if (this.processingLoop) {
      return;
    }

    this.processingLoop = this.processPendingDeliveries()
      .catch((error) => {
        this.logRuntimeError("runtime_exit", error, {
          stage: "process_pending_deliveries"
        });
      })
      .finally(() => {
        this.processingLoop = undefined;
      });
  }

  private async processPendingDeliveries(): Promise<void> {
    while (!this.isTerminating && this.pendingDeliveries.length > 0) {
      const next = this.pendingDeliveries.shift();
      if (!next) {
        continue;
      }

      try {
        await this.executeDelivery(next);
        this.resumeRecoveryAttemptedDeliveryIds.delete(next.deliveryId);
        this.settingsFallbackAttemptedDeliveryIds.delete(next.deliveryId);
        this.fallbackSettingsDeliveryIds.delete(next.deliveryId);
      } catch (error) {
        if (this.status === "terminated" || this.isStopping || isAbortError(error)) {
          break;
        }

        if (
          isResumeRecoveryError(error) &&
          !this.resumeRecoveryAttemptedDeliveryIds.has(next.deliveryId)
        ) {
          this.resumeRecoveryAttemptedDeliveryIds.add(next.deliveryId);
          this.pendingDeliveries.unshift(next);
          this.clearPersistedRuntimeState();
          await this.updateStatus("idle");
          continue;
        }
        this.resumeRecoveryAttemptedDeliveryIds.delete(next.deliveryId);

        if (
          this.settingsPolicy.enableFallbackOnReadError &&
          !this.settingsFallbackAttemptedDeliveryIds.has(next.deliveryId)
        ) {
          const settingsReadFailureReason = this.classifySettingsReadFailureReason(error);
          if (settingsReadFailureReason) {
            this.settingsFallbackAttemptedDeliveryIds.add(next.deliveryId);
            this.fallbackSettingsDeliveryIds.add(next.deliveryId);
            this.logSettingsFallbackWarning(next.deliveryId, settingsReadFailureReason);
            this.pendingDeliveries.unshift(next);
            await this.updateStatus("idle");
            continue;
          }
        }
        this.settingsFallbackAttemptedDeliveryIds.delete(next.deliveryId);
        this.fallbackSettingsDeliveryIds.delete(next.deliveryId);

        const message = errorToMessage(error);

        const droppedPendingCount = this.pendingDeliveries.length;
        this.pendingDeliveries = [];

        const isAuthRequired = isAuthRequiredError(error);
        const isAuthFailure = isAuthRequired || this.isAuthFailureMessage(message);
        const errorDetails = readErrorDetails(error);
        const normalizedMessage = isAuthRequired
          ? message
          : isAuthFailure
            ? buildAuthReconnectMessage(message)
            : message;

        await this.callbacks.onRuntimeError?.(this.descriptor.agentId, {
          phase: "prompt_start",
          message: normalizedMessage,
          details: {
            ...(errorDetails ?? {}),
            droppedPendingCount,
            retriable: !isAuthFailure,
            reconnectRequired: isAuthFailure
          }
        });

        await this.updateStatus("idle");
        break;
      }
    }

    if (this.status !== "terminated") {
      await this.updateStatus("idle");
    }
  }

  private async executeDelivery(delivery: PendingDelivery): Promise<void> {
    this.ensureNotTerminated();

    const auth = await this.resolveAuthToken();
    const prompt = this.toPromptText(delivery.message);
    const settingSources = this.resolveSettingSources(delivery.deliveryId);
    this.validateProjectSettingsReadableOrThrow(settingSources);
    const abortController = new AbortController();
    const sessionIdAtStart = this.sessionId;
    const attemptedResumeId = sessionIdAtStart;
    const usedResume = typeof attemptedResumeId === "string" && attemptedResumeId.length > 0;
    const requestedReasoning = this.resolveRequestedReasoningConfig();

    this.currentAbortController = abortController;
    const stderrChunks: string[] = [];
    let sawAssistantOrToolActivity = false;
    let assistantMessageCount = 0;
    let assistantErrorCount = 0;
    let toolProgressEventCount = 0;
    let toolSummaryEventCount = 0;
    let authStatusEventCount = 0;
    let resultMessageCount = 0;
    const effectiveReasoning = this.resolveEffectiveReasoningConfig(requestedReasoning);

    this.currentQuery = this.createClaudeQuery({
      prompt,
      settingSources,
      auth,
      abortController,
      attemptedResumeId,
      reasoning: effectiveReasoning,
      onStderr: (trimmed) => {
        if (stderrChunks.length < 5) {
          stderrChunks.push(trimmed);
        }
      }
    });

    this.logQueryAttempt(delivery.deliveryId, settingSources, effectiveReasoning, attemptedResumeId);

    let resultMessage: SDKResultMessage | undefined;
    let lastAssistantError: SDKAssistantMessageError | undefined;
    let lastAssistantErrorMessage: string | undefined;
    let lastAuthStatusError: string | undefined;
    let streamTerminalError: unknown;

    const buildErrorDetails = (outcome: string, extras?: Record<string, unknown>): ClaudeExecutionErrorDetails =>
      ({
        runtime: "claude-agent-sdk",
        outcome,
        deliveryId: delivery.deliveryId,
        promptPreview: previewText(prompt, 240),
        usedResume,
        ...(attemptedResumeId ? { attemptedResumeId } : {}),
        ...(sessionIdAtStart ? { sessionIdAtStart } : {}),
        ...(this.sessionId ? { sessionIdAtEnd: this.sessionId } : {}),
        assistantMessages: assistantMessageCount,
        assistantErrorCount,
        toolProgressEvents: toolProgressEventCount,
        toolSummaryEvents: toolSummaryEventCount,
        authStatusEvents: authStatusEventCount,
        resultMessages: resultMessageCount,
        ...(resultMessage ? { resultSubtype: resultMessage.subtype } : {}),
        ...(lastAssistantError ? { lastAssistantError } : {}),
        ...(lastAssistantErrorMessage ? { lastAssistantErrorMessage } : {}),
        ...(lastAuthStatusError ? { lastAuthStatusError } : {}),
        ...(summarizeSdkStderr(stderrChunks) ? { stderrSummary: summarizeSdkStderr(stderrChunks) } : {}),
        ...(extras ?? {})
      });

    await this.updateStatus("streaming");

    await this.callbacks.onSessionEvent?.(this.descriptor.agentId, {
      type: "agent_start"
    });
    await this.callbacks.onSessionEvent?.(this.descriptor.agentId, {
      type: "turn_start"
    });

    try {
      for await (const sdkMessage of this.currentQuery) {
        this.captureSessionId((sdkMessage as { session_id?: unknown }).session_id);

        if (sdkMessage.type === "assistant") {
          assistantMessageCount += 1;
          sawAssistantOrToolActivity = true;
          if (sdkMessage.error) {
            lastAssistantError = sdkMessage.error;
            lastAssistantErrorMessage =
              extractAssistantErrorMessage(sdkMessage) ?? sdkAssistantErrorToMessage(sdkMessage.error);
            assistantErrorCount += 1;
          }

          await this.emitAssistantMessageEvents(sdkMessage);
          continue;
        }

        if (sdkMessage.type === "tool_progress") {
          toolProgressEventCount += 1;
          sawAssistantOrToolActivity = true;
          await this.emitToolProgressEvents(sdkMessage);
          continue;
        }

        if (sdkMessage.type === "tool_use_summary") {
          toolSummaryEventCount += 1;
          sawAssistantOrToolActivity = true;
          await this.emitToolSummaryEvents(sdkMessage);
          continue;
        }

        if (sdkMessage.type === "auth_status") {
          authStatusEventCount += 1;
          if (typeof sdkMessage.error === "string" && sdkMessage.error.trim().length > 0) {
            lastAuthStatusError = sdkMessage.error.trim();
          }
          continue;
        }

        if (sdkMessage.type === "result") {
          resultMessageCount += 1;
          resultMessage = sdkMessage;
          this.updateContextUsageFromResult(sdkMessage);
          continue;
        }
      }
    } catch (error) {
      const message = errorToMessage(error);
      const maybeResultResumeFailureMessage =
        resultMessage && resultMessage.subtype !== "success"
          ? summarizeResultError(toResultError(resultMessage))
          : undefined;
      if (
        usedResume &&
        !sawAssistantOrToolActivity &&
        (this.isResumeFailureMessage(message) ||
          (typeof maybeResultResumeFailureMessage === "string" &&
            this.isResumeFailureMessage(maybeResultResumeFailureMessage)))
      ) {
        const resumeFailureMessage =
          maybeResultResumeFailureMessage && this.isResumeFailureMessage(maybeResultResumeFailureMessage)
            ? maybeResultResumeFailureMessage
            : message;
        throw attachErrorDetails(
          createResumeRecoveryError(resumeFailureMessage, attemptedResumeId),
          buildErrorDetails("resume_recovery", {
            normalizedMessage: resumeFailureMessage
          })
        );
      }

      if (lastAssistantError === "authentication_failed") {
        const authFailureMessage = lastAssistantErrorMessage ?? lastAuthStatusError ?? message;
        throw attachErrorDetails(
          createAuthRequiredError(authFailureMessage),
          buildErrorDetails("query_exception_auth", {
            normalizedMessage: authFailureMessage
          })
        );
      }

      if (resultMessage) {
        streamTerminalError = error;
      } else {
        throw attachErrorDetails(
          error,
          buildErrorDetails("query_exception", {
            normalizedMessage: message
          })
        );
      }
    } finally {
      await this.completeActiveToolCalls();
      this.currentQuery?.close();
      this.currentQuery = undefined;
      this.currentAbortController = undefined;
    }

    await this.callbacks.onSessionEvent?.(this.descriptor.agentId, {
      type: "turn_end",
      toolResults: []
    });
    await this.callbacks.onSessionEvent?.(this.descriptor.agentId, {
      type: "agent_end"
    });

    if (!resultMessage) {
      const stderrSummary = summarizeSdkStderr(stderrChunks);
      const normalizedMessage =
        (typeof lastAuthStatusError === "string" && lastAuthStatusError.length > 0
          ? lastAuthStatusError
          : undefined) ??
        (typeof lastAssistantErrorMessage === "string" && lastAssistantErrorMessage.length > 0
          ? lastAssistantErrorMessage
          : undefined) ??
        (lastAssistantError ? sdkAssistantErrorToMessage(lastAssistantError) : undefined) ??
        (streamTerminalError ? errorToMessage(streamTerminalError) : undefined) ??
        stderrSummary ??
        "Claude Agent SDK exited without returning a result.";
      const errorDetails = buildErrorDetails(streamTerminalError ? "stream_terminal_error" : "missing_result", {
        normalizedMessage
      });

      if (
        lastAssistantError === "authentication_failed" ||
        this.isAuthFailureMessage(normalizedMessage)
      ) {
        throw attachErrorDetails(createAuthRequiredError(normalizedMessage), errorDetails);
      }

      if (
        usedResume &&
        !sawAssistantOrToolActivity &&
        this.isResumeFailureMessage(normalizedMessage)
      ) {
        throw attachErrorDetails(createResumeRecoveryError(normalizedMessage, attemptedResumeId), errorDetails);
      }

      throw attachErrorDetails(new Error(normalizedMessage), errorDetails);
    }

    if (resultMessage.subtype === "success") {
      if (resultMessage.is_error === true) {
        const flaggedErrorMessage =
          (typeof lastAuthStatusError === "string" && lastAuthStatusError.length > 0
            ? lastAuthStatusError
            : undefined) ??
          (typeof lastAssistantErrorMessage === "string" && lastAssistantErrorMessage.length > 0
            ? lastAssistantErrorMessage
            : undefined) ??
          (streamTerminalError ? errorToMessage(streamTerminalError) : undefined) ??
          "Claude Agent SDK reported a success result flagged as error.";
        const errorDetails = buildErrorDetails("success_flagged_error", {
          normalizedMessage: flaggedErrorMessage
        });

        if (
          lastAssistantError === "authentication_failed" ||
          this.isAuthFailureMessage(flaggedErrorMessage)
        ) {
          throw attachErrorDetails(createAuthRequiredError(flaggedErrorMessage), errorDetails);
        }

        throw attachErrorDetails(new Error(flaggedErrorMessage), errorDetails);
      }

      return;
    }

    const runtimeError = toResultError(resultMessage);
    const resultErrorMessage = summarizeResultError(runtimeError);
    const normalizedMessage =
      typeof lastAuthStatusError === "string" && lastAuthStatusError.length > 0
        ? lastAuthStatusError
        : resultErrorMessage;
    const errorDetails = buildErrorDetails("result_error", {
      normalizedMessage
    });

    if (
      usedResume &&
      !sawAssistantOrToolActivity &&
      this.isResumeFailureMessage(normalizedMessage)
    ) {
      throw attachErrorDetails(createResumeRecoveryError(normalizedMessage, attemptedResumeId), errorDetails);
    }

    const isAuthFailure =
      lastAssistantError === "authentication_failed" || this.isAuthFailureMessage(normalizedMessage);

    if (isAuthFailure) {
      throw attachErrorDetails(createAuthRequiredError(normalizedMessage), errorDetails);
    }

    throw attachErrorDetails(new Error(normalizedMessage), errorDetails);
  }

  private toPromptText(message: RuntimeUserMessage): string {
    if (!message.images || message.images.length === 0) {
      return message.text;
    }

    const imageNotice = `[${message.images.length} image attachment${message.images.length === 1 ? "" : "s"} omitted for claude-agent-sdk runtime.]`;
    if (!message.text.trim()) {
      return imageNotice;
    }

    return `${message.text}\n\n${imageNotice}`;
  }

  private readPersistedRuntimeState(): ClaudeRuntimeState | undefined {
    const fromFile = this.readPersistedRuntimeStateFromFile();
    if (fromFile) {
      if (fromFile.sessionId === null) {
        return undefined;
      }

      if (typeof fromFile.sessionId === "string" && fromFile.sessionId.trim().length > 0) {
        return {
          sessionId: fromFile.sessionId.trim()
        };
      }
    }

    const entries = this.getCustomEntries(CLAUDE_RUNTIME_STATE_ENTRY_TYPE);

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const maybe = entries[index] as { sessionId?: unknown } | undefined;
      if (!maybe || !("sessionId" in maybe)) {
        continue;
      }

      if (maybe.sessionId === null) {
        return undefined;
      }

      if (typeof maybe.sessionId !== "string" || maybe.sessionId.trim().length === 0) {
        continue;
      }

      return {
        sessionId: maybe.sessionId.trim()
      };
    }

    return undefined;
  }

  private persistRuntimeState(): void {
    if (!this.sessionId) {
      return;
    }

    this.writePersistedRuntimeStateFileSafe({
      sessionId: this.sessionId
    });
    this.appendCustomRuntimeStateEntrySafe({
      sessionId: this.sessionId
    });
  }

  private clearPersistedRuntimeState(): void {
    this.sessionId = undefined;
    this.writePersistedRuntimeStateFileSafe({
      sessionId: null
    });
    this.appendCustomRuntimeStateEntrySafe({
      sessionId: null
    });
  }

  private captureSessionId(value: unknown): void {
    if (typeof value !== "string") {
      return;
    }

    const normalized = value.trim();
    if (!normalized || normalized === this.sessionId) {
      return;
    }

    this.sessionId = normalized;
    this.persistRuntimeState();
  }

  private async resolveAuthToken(): Promise<AuthTokenResolution> {
    const credential = this.authStorage.get("claude-agent-sdk");

    if (!credential) {
      throw createAuthRequiredError("Missing claude-agent-sdk credentials.");
    }

    if (credential.type !== "oauth") {
      throw createAuthRequiredError("claude-agent-sdk requires OAuth credentials.");
    }

    const token = extractAuthToken(credential);
    if (!token) {
      throw createAuthRequiredError("Missing claude-agent-sdk OAuth access token.");
    }

    const refreshToken = extractRefreshToken(credential);
    const expiresMs = resolveCredentialExpiryMs(credential);
    if (expiresMs === undefined || expiresMs > Date.now()) {
      return {
        token,
        refreshToken
      };
    }

    if (!refreshToken) {
      throw createAuthRequiredError("claude-agent-sdk OAuth token expired.");
    }

    let refreshedCredential: AuthCredential;
    try {
      const refreshed = await refreshAnthropicToken(refreshToken);
      const nextRefreshToken = normalizeToken(refreshed.refresh) ?? refreshToken;
      refreshedCredential = {
        ...(credential as Record<string, unknown>),
        type: "oauth",
        access: refreshed.access,
        key: refreshed.access,
        refresh: nextRefreshToken,
        expires: refreshed.expires
      } as AuthCredential;
      this.authStorage.set("claude-agent-sdk", refreshedCredential);
    } catch (error) {
      const reason = errorToMessage(error);
      throw createAuthRequiredError(`claude-agent-sdk OAuth token expired and refresh failed: ${reason}`);
    }

    const refreshedToken = extractAuthToken(refreshedCredential);
    if (!refreshedToken) {
      throw createAuthRequiredError("Missing claude-agent-sdk OAuth access token.");
    }

    return {
      token: refreshedToken,
      refreshToken: extractRefreshToken(refreshedCredential)
    };
  }

  private buildRuntimeEnv(auth: AuthTokenResolution): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.runtimeEnv,
      CLAUDE_CODE_OAUTH_TOKEN: auth.token,
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: auth.refreshToken,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined
    };

    return env;
  }

  private createClaudeQuery(options: {
    prompt: string;
    settingSources: SettingSource[];
    auth: AuthTokenResolution;
    abortController: AbortController;
    attemptedResumeId?: string;
    reasoning: ClaudeResolvedReasoningConfig;
    onStderr: (trimmed: string) => void;
  }): Query {
    return query({
      prompt: options.prompt,
      options: {
        cwd: this.descriptor.cwd,
        model: this.descriptor.model.modelId,
        systemPrompt: this.systemPrompt,
        settingSources: options.settingSources,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: false,
        mcpServers: {
          [TOOL_MCP_SERVER_NAME]: this.sdkMcpServer
        },
        env: this.buildRuntimeEnv(options.auth),
        abortController: options.abortController,
        thinking: options.reasoning.thinkingConfig,
        ...(options.reasoning.effectiveEffort
          ? {
              effort: options.reasoning.effectiveEffort
            }
          : {}),
        // Avoid surfacing raw SDK stderr lines directly to user-visible runtime errors.
        stderr: (data) => {
          const trimmed = data.trim();
          if (!trimmed) {
            return;
          }

          options.onStderr(trimmed);
        },
        ...(options.attemptedResumeId
          ? {
              resume: options.attemptedResumeId
            }
          : {})
      }
    });
  }

  private resolveRequestedReasoningConfig(): ClaudeRequestedReasoningConfig {
    const thinkingLevel = normalizeThinkingLevel(this.descriptor.model.thinkingLevel);
    const mapped = this.thinkingLevelToConfig[thinkingLevel] ?? this.thinkingLevelToConfig.medium;
    return {
      thinking: mapped.thinking,
      effort: mapped.effort
    };
  }

  private resolveEffectiveReasoningConfig(requested: ClaudeRequestedReasoningConfig): ClaudeResolvedReasoningConfig {
    const effectiveThinking = requested.thinking;
    const thinkingConfig: ThinkingConfig =
      effectiveThinking === "disabled"
        ? { type: "disabled" }
        : effectiveThinking === "adaptive"
          ? { type: "adaptive" }
          : { type: "enabled" };

    if (effectiveThinking === "disabled") {
      return {
        requestedThinking: requested.thinking,
        effectiveThinking,
        thinkingConfig,
        requestedEffort: requested.effort,
        effectiveEffort: undefined
      };
    }

    const effortCapabilities = CLAUDE_FALLBACK_SUPPORTED_EFFORTS;
    const effectiveEffort = requested.effort
      ? clampClaudeEffortToSupportedFloor(requested.effort, effortCapabilities)
      : undefined;

    return {
      requestedThinking: requested.thinking,
      effectiveThinking,
      thinkingConfig,
      requestedEffort: requested.effort,
      effectiveEffort
    };
  }

  private resolveSettingSources(deliveryId: string): SettingSource[] {
    if (this.fallbackSettingsDeliveryIds.has(deliveryId)) {
      return [...this.settingsPolicy.fallbackSources];
    }

    return [...this.settingsPolicy.primarySources];
  }

  private classifySettingsReadFailureReason(error: unknown): string | undefined {
    if (isAuthRequiredError(error) || isResumeRecoveryError(error)) {
      return undefined;
    }

    const candidates: string[] = [];
    const pushCandidate = (value: unknown) => {
      if (typeof value !== "string") {
        return;
      }

      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }

      if (!candidates.includes(trimmed)) {
        candidates.push(trimmed);
      }
    };

    pushCandidate(errorToMessage(error));

    const details = readErrorDetails(error);
    if (details?.settingsReadFailure === true) {
      const detailedReason = details?.settingsReadFailureReason;
      if (typeof detailedReason === "string" && detailedReason.trim().length > 0) {
        return detailedReason.trim();
      }
    }
    pushCandidate(details?.normalizedMessage);
    pushCandidate(details?.stderrSummary);
    pushCandidate(details?.lastAssistantErrorMessage);
    pushCandidate(details?.lastAuthStatusError);

    for (const candidate of candidates) {
      if (looksLikeSettingsReadFailure(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private logSettingsFallbackWarning(deliveryId: string, reason: string): void {
    console.warn(`[swarm][${this.now()}] runtime:warning`, {
      runtime: "claude-agent-sdk",
      event: "settings_load_fallback",
      agentId: this.descriptor.agentId,
      deliveryId,
      attemptedSources: [...this.settingsPolicy.primarySources],
      fallbackSources: [...this.settingsPolicy.fallbackSources],
      reason
    });
  }

  private logQueryAttempt(
    deliveryId: string,
    settingSources: SettingSource[],
    reasoning: ClaudeResolvedReasoningConfig,
    attemptedResumeId: string | undefined
  ): void {
    console.info(`[swarm][${this.now()}] runtime:query_attempt`, {
      runtime: "claude-agent-sdk",
      event: "query_attempt",
      agentId: this.descriptor.agentId,
      deliveryId,
      model: this.descriptor.model.modelId,
      settingSources,
      resume: attemptedResumeId,
      thinkingOption: reasoning.thinkingConfig,
      effortOption: reasoning.effectiveEffort,
      requestedThinking: reasoning.requestedThinking,
      effectiveThinking: reasoning.effectiveThinking,
      requestedEffort: reasoning.requestedEffort,
      effectiveEffort: reasoning.effectiveEffort,
      effortClamped:
        typeof reasoning.requestedEffort === "string" &&
        typeof reasoning.effectiveEffort === "string" &&
        reasoning.requestedEffort !== reasoning.effectiveEffort
    });
  }

  private validateProjectSettingsReadableOrThrow(settingSources: SettingSource[]): void {
    if (!settingSources.includes("project")) {
      return;
    }

    const settingsPath = `${this.descriptor.cwd}/.claude/settings.json`;
    if (!existsSync(settingsPath)) {
      return;
    }

    let raw: string;
    try {
      raw = readFileSync(settingsPath, "utf8");
    } catch (error) {
      const reason = `Failed to read project settings file at ${settingsPath}: ${errorToMessage(error)}`;
      throw attachErrorDetails(new Error(reason), {
        settingsReadFailure: true,
        settingsReadFailureReason: reason,
        settingsPath
      });
    }

    try {
      JSON.parse(raw);
    } catch (error) {
      const reason = `Failed to parse project settings file at ${settingsPath}: ${errorToMessage(error)}`;
      throw attachErrorDetails(new Error(reason), {
        settingsReadFailure: true,
        settingsReadFailureReason: reason,
        settingsPath
      });
    }
  }

  private readPersistedRuntimeStateFromFile(): { sessionId?: unknown } | undefined {
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

    if (!parsed || typeof parsed !== "object" || !("sessionId" in parsed)) {
      return undefined;
    }

    return parsed as { sessionId?: unknown };
  }

  private writePersistedRuntimeStateFile(state: { sessionId: string | null }): void {
    mkdirSync(dirname(this.runtimeStateFile), { recursive: true });
    writeFileSync(this.runtimeStateFile, `${JSON.stringify(state)}\n`, "utf8");
  }

  private writePersistedRuntimeStateFileSafe(state: { sessionId: string | null }): void {
    try {
      this.writePersistedRuntimeStateFile(state);
    } catch (error) {
      this.logRuntimeError("runtime_exit", error, {
        stage: "persist_runtime_state_file",
        sessionFile: this.descriptor.sessionFile
      });
    }
  }

  private appendCustomRuntimeStateEntrySafe(state: { sessionId: string | null }): void {
    try {
      this.appendCustomEntry(CLAUDE_RUNTIME_STATE_ENTRY_TYPE, state);
    } catch (error) {
      this.logRuntimeError("runtime_exit", error, {
        stage: "persist_runtime_state_custom_entry",
        sessionFile: this.descriptor.sessionFile
      });
    }
  }

  private isResumeFailureMessage(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const resumeFailurePatterns = [
      /\bresume\b.*\b(failed|invalid|unknown|not found|error)\b/,
      /\bfailed to resume\b/,
      /\binvalid resume\b/,
      /\bsession\b.*\b(not found|unknown|invalid|expired)\b/,
      /\bconversation\b.*\b(not found|unknown)\b/,
      /\bno conversation found\b/
    ];

    return resumeFailurePatterns.some((pattern) => pattern.test(normalized));
  }

  private isAuthFailureMessage(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const authFailurePatterns = [
      /\bauthentication[_ ]failed\b/,
      /\bunauthorized\b/,
      /\binvalid[_ ]api[_ ]key\b/,
      /\binvalid api key\b/,
      /\binvalid access token\b/,
      /\binvalid token\b/,
      /\btoken expired\b/,
      /\baccess token\b.*\bexpired\b/,
      /\boauth\b.*\bexpired\b/,
      /\blogin required\b/
    ];

    return authFailurePatterns.some((pattern) => pattern.test(normalized));
  }

  private async emitAssistantMessageEvents(message: SDKAssistantMessage): Promise<void> {
    const content = toRuntimeMessageContent(message.message?.content);
    const stopReason = readStopReason(message.message) ?? (message.error ? "error" : undefined);
    const sessionMessage: {
      role: "assistant";
      content: ReturnType<typeof toRuntimeMessageContent>;
      stopReason?: string;
      errorMessage?: string;
    } = {
      role: "assistant",
      content,
      ...(stopReason ? { stopReason } : {})
    };
    if (message.error) {
      sessionMessage.errorMessage = sdkAssistantErrorToMessage(message.error);
    }

    await this.callbacks.onSessionEvent?.(this.descriptor.agentId, {
      type: "message_start",
      message: sessionMessage
    });

    await this.callbacks.onSessionEvent?.(this.descriptor.agentId, {
      type: "message_end",
      message: sessionMessage
    });
  }

  private async emitToolProgressEvents(message: Extract<SDKMessage, { type: "tool_progress" }>): Promise<void> {
    if (!this.activeToolsById.has(message.tool_use_id)) {
      this.activeToolsById.set(message.tool_use_id, {
        toolName: message.tool_name
      });

      await this.callbacks.onSessionEvent?.(this.descriptor.agentId, {
        type: "tool_execution_start",
        toolName: message.tool_name,
        toolCallId: message.tool_use_id,
        args: {}
      });
    }

    await this.callbacks.onSessionEvent?.(this.descriptor.agentId, {
      type: "tool_execution_update",
      toolName: message.tool_name,
      toolCallId: message.tool_use_id,
      partialResult: {
        elapsedTimeSeconds: message.elapsed_time_seconds,
        taskId: message.task_id
      }
    });
  }

  private async emitToolSummaryEvents(message: Extract<SDKMessage, { type: "tool_use_summary" }>): Promise<void> {
    for (const toolCallId of message.preceding_tool_use_ids) {
      const active = this.activeToolsById.get(toolCallId);
      const toolName = active?.toolName ?? "tool";

      await this.callbacks.onSessionEvent?.(this.descriptor.agentId, {
        type: "tool_execution_end",
        toolName,
        toolCallId,
        result: {
          summary: message.summary
        },
        isError: false
      });

      this.activeToolsById.delete(toolCallId);
    }
  }

  private async completeActiveToolCalls(): Promise<void> {
    if (this.activeToolsById.size === 0) {
      return;
    }

    for (const [toolCallId, active] of this.activeToolsById.entries()) {
      await this.callbacks.onSessionEvent?.(this.descriptor.agentId, {
        type: "tool_execution_end",
        toolName: active.toolName,
        toolCallId,
        result: {
          summary: "Tool execution completed"
        },
        isError: false
      });
    }

    this.activeToolsById.clear();
  }

  private updateContextUsageFromResult(message: SDKResultMessage): void {
    const usage = message.usage;
    const inputTokens = asNonNegativeInteger(usage?.input_tokens);
    const outputTokens = asNonNegativeInteger(usage?.output_tokens);
    const cacheReadTokens = asNonNegativeInteger(usage?.cache_read_input_tokens);
    const cacheCreationTokens = asNonNegativeInteger(usage?.cache_creation_input_tokens);

    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

    const firstModelUsage = Object.values(message.modelUsage ?? {})[0];
    const contextWindow = asNonNegativeInteger(firstModelUsage?.contextWindow);

    if (!Number.isFinite(totalTokens) || totalTokens < 0 || contextWindow <= 0) {
      return;
    }

    const percent = Math.max(0, Math.min(100, (totalTokens / contextWindow) * 100));
    this.contextUsage = {
      tokens: totalTokens,
      contextWindow,
      percent
    };
  }

  private async updateStatus(next: AgentStatus): Promise<void> {
    if (this.status === "terminated" && next !== "terminated") {
      return;
    }

    this.status = transitionAgentStatus(this.status, next);
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();

    await this.emitStatus();
  }

  private async emitStatus(): Promise<void> {
    await this.callbacks.onStatusChange(
      this.descriptor.agentId,
      this.status,
      this.pendingDeliveries.length,
      this.contextUsage
    );
  }

  private async interruptCurrentQuery(): Promise<void> {
    const activeQuery = this.currentQuery;
    if (!activeQuery) {
      return;
    }

    try {
      await activeQuery.interrupt();
    } catch {
      // Best effort interrupt.
    }

    try {
      activeQuery.close();
    } catch {
      // Best effort close.
    }

    this.currentAbortController?.abort();
  }

  private ensureNotTerminated(): void {
    if (this.status === "terminated") {
      throw new Error(`Agent ${this.descriptor.agentId} is terminated`);
    }
  }

  private logRuntimeError(phase: RuntimeErrorEvent["phase"], error: unknown, details?: Record<string, unknown>): void {
    const normalized = normalizeRuntimeError(error);
    console.error(`[swarm][${this.now()}] runtime:error`, {
      runtime: "claude-agent-sdk",
      agentId: this.descriptor.agentId,
      phase,
      message: normalized.message,
      stack: normalized.stack,
      details
    });

    void this.callbacks.onRuntimeError?.(this.descriptor.agentId, {
      phase,
      message: normalized.message,
      stack: normalized.stack,
      details
    });
  }
}

function typeBoxSchemaToZodObject(schema: unknown): z.ZodObject<Record<string, ZodType>> {
  const converted = typeBoxSchemaToZod(schema);
  if (converted instanceof z.ZodObject) {
    return converted;
  }

  return z.object({}).passthrough();
}

function typeBoxSchemaToZod(schema: unknown): ZodType {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return z.any();
  }

  const record = schema as Record<string, unknown>;

  if ("const" in record) {
    const literal = record.const;
    if (
      typeof literal === "string" ||
      typeof literal === "number" ||
      typeof literal === "boolean" ||
      literal === null
    ) {
      return withDescription(z.literal(literal), record.description);
    }
  }

  if (Array.isArray(record.anyOf)) {
    const members = record.anyOf.map((entry) => typeBoxSchemaToZod(entry));
    if (members.length === 0) {
      return z.any();
    }
    if (members.length === 1) {
      return members[0];
    }

    return withDescription(
      z.union([members[0], members[1], ...members.slice(2)] as [ZodType, ZodType, ...ZodType[]]),
      record.description
    );
  }

  const typeValue = record.type;
  if (typeValue === "string") {
    return withDescription(z.string(), record.description);
  }

  if (typeValue === "number") {
    return withDescription(z.number(), record.description);
  }

  if (typeValue === "integer") {
    return withDescription(z.number().int(), record.description);
  }

  if (typeValue === "boolean") {
    return withDescription(z.boolean(), record.description);
  }

  if (typeValue === "null") {
    return withDescription(z.null(), record.description);
  }

  if (typeValue === "array") {
    const itemSchema = typeBoxSchemaToZod(record.items);
    let arraySchema = z.array(itemSchema);
    const minItems = asNonNegativeInteger(record.minItems);
    const maxItems = asNonNegativeInteger(record.maxItems);
    if (minItems !== undefined) {
      arraySchema = arraySchema.min(minItems);
    }
    if (maxItems !== undefined) {
      arraySchema = arraySchema.max(maxItems);
    }
    return withDescription(arraySchema, record.description);
  }

  if (typeValue === "object" || "properties" in record) {
    const properties = toStringRecord(record.properties);
    const requiredFields = new Set<string>(toStringArray(record.required));
    const shape: Record<string, ZodType> = {};

    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      let fieldSchema = typeBoxSchemaToZod(propertySchema);
      if (!requiredFields.has(propertyName)) {
        fieldSchema = fieldSchema.optional();
      }
      shape[propertyName] = fieldSchema;
    }

    let objectSchema = z.object(shape);
    const additionalProperties = record.additionalProperties;
    if (additionalProperties === true) {
      objectSchema = objectSchema.passthrough();
    } else if (additionalProperties && typeof additionalProperties === "object") {
      objectSchema = objectSchema.catchall(typeBoxSchemaToZod(additionalProperties));
    } else {
      objectSchema = objectSchema.strict();
    }

    return withDescription(objectSchema, record.description);
  }

  return withDescription(z.any(), record.description);
}

function withDescription<T extends ZodType>(schema: T, description: unknown): T {
  if (typeof description === "string" && description.trim().length > 0) {
    return schema.describe(description.trim()) as T;
  }
  return schema;
}

function toStringRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function toRuntimeMessageContent(content: unknown): Array<{ type: "text" | "image"; text?: string; mimeType?: string; data?: string }> {
  if (!Array.isArray(content)) {
    return [];
  }

  const normalized: Array<{ type: "text" | "image"; text?: string; mimeType?: string; data?: string }> = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const type = (item as { type?: unknown }).type;
    if (type === "text") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string") {
        normalized.push({
          type: "text",
          text
        });
      }
      continue;
    }

    if (type === "image") {
      const source = (item as { source?: unknown }).source as
        | { type?: unknown; media_type?: unknown; data?: unknown }
        | undefined;

      if (
        source &&
        source.type === "base64" &&
        typeof source.media_type === "string" &&
        typeof source.data === "string"
      ) {
        normalized.push({
          type: "image",
          mimeType: source.media_type,
          data: source.data
        });
      }
    }
  }

  return normalized;
}

function clampClaudeEffortToSupportedFloor(
  requestedEffort: ClaudeReasoningEffort,
  supportedEfforts: ClaudeReasoningEffort[]
): ClaudeReasoningEffort {
  if (supportedEfforts.length === 0) {
    return requestedEffort;
  }

  const requestedRank = CLAUDE_EFFORT_RANK[requestedEffort];
  let floorEffort: ClaudeReasoningEffort | undefined;

  for (const effort of supportedEfforts) {
    if (CLAUDE_EFFORT_RANK[effort] > requestedRank) {
      break;
    }
    floorEffort = effort;
  }

  return floorEffort ?? supportedEfforts[0];
}

function normalizeThinkingLevel(value: string): ThinkingLevel {
  const normalized = value.trim().toLowerCase();
  if (normalized === "x-high") {
    return "xhigh";
  }

  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }

  return "medium";
}

function extractAuthToken(credential: AuthCredential): string | undefined {
  if (credential.type !== "oauth") {
    return undefined;
  }

  const oauthToken = normalizeToken((credential as { access?: unknown }).access);
  if (oauthToken) {
    return oauthToken;
  }

  return normalizeToken((credential as { key?: unknown }).key);
}

function extractRefreshToken(credential: AuthCredential): string | undefined {
  if (credential.type !== "oauth") {
    return undefined;
  }

  return normalizeToken((credential as { refresh?: unknown }).refresh);
}

function resolveCredentialExpiryMs(credential: AuthCredential): number | undefined {
  if (credential.type !== "oauth") {
    return undefined;
  }

  const expiresValue = (credential as { expires?: unknown }).expires;

  if (typeof expiresValue === "number" && Number.isFinite(expiresValue)) {
    return normalizeEpochMs(expiresValue);
  }

  if (typeof expiresValue === "string") {
    const trimmed = expiresValue.trim();
    if (!trimmed) {
      return undefined;
    }

    if (/^\d+$/u.test(trimmed)) {
      const numeric = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(numeric)) {
        return undefined;
      }
      return normalizeEpochMs(numeric);
    }

    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate)) {
      return parsedDate;
    }
  }

  return undefined;
}

function normalizeEpochMs(value: number): number {
  // Handle credential stores that persist unix seconds instead of milliseconds.
  return value > 0 && value < 1_000_000_000_000 ? value * 1_000 : value;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOutputStyleMetadataValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOutputStyleMetadataList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const styles = new Set<string>();
  for (const candidate of value) {
    const normalized = normalizeOutputStyleMetadataValue(candidate);
    if (normalized) {
      styles.add(normalized);
    }
  }

  return Array.from(styles);
}

function createAuthRequiredError(reason: string): Error {
  const error = new Error(buildAuthReconnectMessage(reason));
  (error as Error & { code?: string }).code = AUTH_REQUIRED_ERROR_CODE;
  return error;
}

function isAuthRequiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return (error as { code?: unknown }).code === AUTH_REQUIRED_ERROR_CODE;
}

function createResumeRecoveryError(reason: string, attemptedResumeId: string): Error {
  const normalizedReason = reason.trim().length > 0 ? reason.trim() : "Claude Agent SDK resume failed.";
  const error = new Error(normalizedReason);
  (
    error as Error & {
      code?: string;
      attemptedResumeId?: string;
    }
  ).code = RESUME_RECOVERY_ERROR_CODE;
  (
    error as Error & {
      code?: string;
      attemptedResumeId?: string;
    }
  ).attemptedResumeId = attemptedResumeId;
  return error;
}

function isResumeRecoveryError(
  error: unknown
): error is Error & { code: typeof RESUME_RECOVERY_ERROR_CODE; attemptedResumeId: string } {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybe = error as {
    code?: unknown;
    attemptedResumeId?: unknown;
  };

  return (
    maybe.code === RESUME_RECOVERY_ERROR_CODE &&
    typeof maybe.attemptedResumeId === "string" &&
    maybe.attemptedResumeId.trim().length > 0
  );
}

function buildAuthReconnectMessage(reason: string): string {
  const normalizedReason = reason.trim().length > 0 ? reason.trim() : "Authentication failed.";
  return `${normalizedReason} Reconnect Claude Agent SDK in Settings and retry.`;
}

function toResultError(message: SDKResultMessage): SDKResultError {
  if (message.subtype === "success") {
    throw new Error("Expected SDK result error but received success result");
  }

  return message;
}

function summarizeResultError(message: SDKResultError): string {
  const explicit = message.errors.find((entry) => typeof entry === "string" && entry.trim().length > 0);
  if (explicit) {
    return explicit.trim();
  }

  switch (message.subtype) {
    case "error_max_turns":
      return "Claude Agent SDK reached max turns before completing the request.";
    case "error_max_budget_usd":
      return "Claude Agent SDK hit max budget before completing the request.";
    case "error_max_structured_output_retries":
      return "Claude Agent SDK failed structured output after max retries.";
    case "error_during_execution":
      return "Claude Agent SDK failed during execution.";
  }
}

function sdkAssistantErrorToMessage(error: SDKAssistantMessageError): string {
  switch (error) {
    case "authentication_failed":
      return "authentication_failed";
    case "billing_error":
      return "billing_error";
    case "rate_limit":
      return "rate_limit";
    case "invalid_request":
      return "invalid_request";
    case "server_error":
      return "server_error";
    case "max_output_tokens":
      return "max_output_tokens";
    case "unknown":
      return "unknown";
  }
}

function extractAssistantErrorMessage(message: SDKAssistantMessage): string | undefined {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textChunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if ((item as { type?: unknown }).type !== "text") {
      continue;
    }

    const text = (item as { text?: unknown }).text;
    if (typeof text !== "string") {
      continue;
    }

    const trimmed = text.trim();
    if (trimmed.length > 0) {
      textChunks.push(trimmed);
    }
  }

  if (textChunks.length === 0) {
    return undefined;
  }

  return textChunks.join(" ");
}

function readStopReason(message: { stop_reason?: unknown } | undefined): string | undefined {
  if (!message) {
    return undefined;
  }

  const stopReason = message.stop_reason;
  return typeof stopReason === "string" && stopReason.trim().length > 0 ? stopReason : undefined;
}

function asNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.round(value);
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function attachErrorDetails(error: unknown, details: Record<string, unknown>): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const existingDetails = readErrorDetails(normalized);
  (normalized as Error & { details?: Record<string, unknown> }).details = {
    ...(existingDetails ?? {}),
    ...details
  };
  return normalized;
}

function readErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const maybe = (error as { details?: unknown }).details;
  if (!maybe || typeof maybe !== "object" || Array.isArray(maybe)) {
    return undefined;
  }

  return maybe as Record<string, unknown>;
}

function previewText(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const name = (error as { name?: unknown }).name;
  if (typeof name !== "string") {
    return false;
  }

  return name === "AbortError";
}

function normalizeSettingsPolicy(policy: Partial<ClaudeSettingsPolicy> | undefined): ClaudeSettingsPolicy {
  const primarySources = normalizeSettingSources(policy?.primarySources, ["project"]);
  const fallbackSources = normalizeSettingSources(policy?.fallbackSources, []);

  return {
    primarySources,
    fallbackSources,
    enableFallbackOnReadError: policy?.enableFallbackOnReadError ?? true
  };
}

function normalizeSettingSources(
  value: readonly SettingSource[] | undefined,
  defaults: SettingSource[]
): SettingSource[] {
  const seen = new Set<SettingSource>();
  const normalized: SettingSource[] = [];

  for (const source of value ?? defaults) {
    if (source !== "user" && source !== "project" && source !== "local") {
      continue;
    }

    if (seen.has(source)) {
      continue;
    }

    seen.add(source);
    normalized.push(source);
  }

  return normalized;
}

function looksLikeSettingsReadFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const explicitSettingsTargetPatterns = [
    /\.claude[\\/](settings(\.local)?\.json)/u,
    /\bclaude\s+settings(\s+file)?\b/u
  ];
  const explicitReadOrParseFailurePatterns = [
    /\b(failed|unable|cannot|can't)\s+to\s+(read|load|parse|decode)\b/u,
    /\b(permission denied|eacces|enoent|invalid json|unexpected token|parse error)\b/u
  ];

  return (
    explicitSettingsTargetPatterns.some((pattern) => pattern.test(normalized)) &&
    explicitReadOrParseFailurePatterns.some((pattern) => pattern.test(normalized))
  );
}

function summarizeSdkStderr(chunks: string[]): string | undefined {
  if (chunks.length === 0) {
    return undefined;
  }

  const firstNonEmptyLine = chunks
    .join("\n")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstNonEmptyLine) {
    return undefined;
  }

  const sanitized = firstNonEmptyLine.replace(/\s+/gu, " ");
  if (sanitized.length <= 180) {
    return sanitized;
  }

  return `${sanitized.slice(0, 180)}...`;
}
