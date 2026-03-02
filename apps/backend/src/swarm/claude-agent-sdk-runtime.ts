import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createSdkMcpServer,
  query,
  type Query,
  type SDKAssistantMessage,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultError,
  type SDKResultMessage
} from "@anthropic-ai/claude-agent-sdk";
import { AuthStorage, SessionManager, type AuthCredential, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { transitionAgentStatus } from "./agent-state-machine.js";
import {
  normalizeRuntimeError,
  normalizeRuntimeUserMessage
} from "./runtime-utils.js";
import type {
  RuntimeErrorEvent,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
  SwarmAgentRuntime,
  SwarmRuntimeCallbacks
} from "./runtime-types.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "./types.js";

const AUTH_REQUIRED_ERROR_CODE = "CLAUDE_AGENT_SDK_AUTH_REQUIRED";
const RESUME_RECOVERY_ERROR_CODE = "CLAUDE_AGENT_SDK_RESUME_RECOVERY";
const TOOL_MCP_SERVER_NAME = "swarm-tools";
const CLAUDE_RUNTIME_STATE_ENTRY_TYPE = "swarm_claude_agent_sdk_runtime_state";
const CLAUDE_RUNTIME_STATE_FILE_SUFFIX = ".claude-runtime-state.json";

interface PendingDelivery {
  deliveryId: string;
  message: RuntimeUserMessage;
}

interface ActiveToolProgress {
  toolName: string;
}

interface AuthTokenResolution {
  token: string;
}

interface ClaudeRuntimeState {
  sessionId: string;
}

export class ClaudeAgentSdkRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;

  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private readonly systemPrompt: string;
  private readonly authStorage: AuthStorage;
  private readonly sessionManager: SessionManager;
  private readonly runtimeEnv: Record<string, string | undefined>;
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

    this.sdkMcpServer = createSdkMcpServer({
      name: TOOL_MCP_SERVER_NAME,
      tools: options.tools.map((toolDefinition) => ({
        name: toolDefinition.name,
        description: toolDefinition.description,
        inputSchema: toolDefinition.parameters as any,
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
  }): Promise<ClaudeAgentSdkRuntime> {
    const runtime = new ClaudeAgentSdkRuntime(options);

    runtime.resolveAuthToken();

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

    await this.updateStatus("idle");
    this.isStopping = false;
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

        const message = errorToMessage(error);

        const droppedPendingCount = this.pendingDeliveries.length;
        this.pendingDeliveries = [];

        const isAuthRequired = isAuthRequiredError(error);
        const isAuthFailure = isAuthRequired || this.isAuthFailureMessage(message);
        const normalizedMessage = isAuthRequired
          ? message
          : isAuthFailure
            ? buildAuthReconnectMessage(message)
            : message;

        await this.callbacks.onRuntimeError?.(this.descriptor.agentId, {
          phase: "prompt_start",
          message: normalizedMessage,
          details: {
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

    const auth = this.resolveAuthToken();
    const prompt = this.toPromptText(delivery.message);
    const abortController = new AbortController();
    const attemptedResumeId = this.sessionId;
    const usedResume = typeof attemptedResumeId === "string" && attemptedResumeId.length > 0;

    this.currentAbortController = abortController;
    const stderrChunks: string[] = [];
    let sawAssistantOrToolActivity = false;

    this.currentQuery = query({
      prompt,
      options: {
        cwd: this.descriptor.cwd,
        model: this.descriptor.model.modelId,
        systemPrompt: this.systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: false,
        mcpServers: {
          [TOOL_MCP_SERVER_NAME]: this.sdkMcpServer
        },
        env: this.buildRuntimeEnv(auth.token),
        abortController,
        // Avoid surfacing raw SDK stderr lines directly to user-visible runtime errors.
        stderr: (data) => {
          const trimmed = data.trim();
          if (!trimmed) {
            return;
          }

          if (stderrChunks.length < 5) {
            stderrChunks.push(trimmed);
          }
        },
        ...(attemptedResumeId
          ? {
              resume: attemptedResumeId
            }
          : {})
      }
    });

    let resultMessage: SDKResultMessage | undefined;
    let lastAssistantError: SDKAssistantMessageError | undefined;
    let lastAuthStatusError: string | undefined;

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
          sawAssistantOrToolActivity = true;
          if (sdkMessage.error) {
            lastAssistantError = sdkMessage.error;
          }

          await this.emitAssistantMessageEvents(sdkMessage);
          continue;
        }

        if (sdkMessage.type === "tool_progress") {
          sawAssistantOrToolActivity = true;
          await this.emitToolProgressEvents(sdkMessage);
          continue;
        }

        if (sdkMessage.type === "tool_use_summary") {
          sawAssistantOrToolActivity = true;
          await this.emitToolSummaryEvents(sdkMessage);
          continue;
        }

        if (sdkMessage.type === "auth_status") {
          if (typeof sdkMessage.error === "string" && sdkMessage.error.trim().length > 0) {
            lastAuthStatusError = sdkMessage.error.trim();
          }
          continue;
        }

        if (sdkMessage.type === "result") {
          resultMessage = sdkMessage;
          this.updateContextUsageFromResult(sdkMessage);
          continue;
        }
      }
    } catch (error) {
      const message = errorToMessage(error);
      if (
        usedResume &&
        !sawAssistantOrToolActivity &&
        attemptedResumeId === this.sessionId &&
        this.isResumeFailureMessage(message)
      ) {
        throw createResumeRecoveryError(message, attemptedResumeId);
      }

      throw error;
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
        (lastAssistantError ? sdkAssistantErrorToMessage(lastAssistantError) : undefined) ??
        stderrSummary ??
        "Claude Agent SDK exited without returning a result.";

      if (
        lastAssistantError === "authentication_failed" ||
        this.isAuthFailureMessage(normalizedMessage)
      ) {
        throw createAuthRequiredError(normalizedMessage);
      }

      if (
        usedResume &&
        !sawAssistantOrToolActivity &&
        attemptedResumeId === this.sessionId &&
        this.isResumeFailureMessage(normalizedMessage)
      ) {
        throw createResumeRecoveryError(normalizedMessage, attemptedResumeId);
      }

      throw new Error(normalizedMessage);
    }

    if (resultMessage.subtype === "success") {
      return;
    }

    const runtimeError = toResultError(resultMessage);
    const resultErrorMessage = summarizeResultError(runtimeError);
    const normalizedMessage =
      typeof lastAuthStatusError === "string" && lastAuthStatusError.length > 0
        ? lastAuthStatusError
        : resultErrorMessage;

    if (
      usedResume &&
      !sawAssistantOrToolActivity &&
      attemptedResumeId === this.sessionId &&
      this.isResumeFailureMessage(normalizedMessage)
    ) {
      throw createResumeRecoveryError(normalizedMessage, attemptedResumeId);
    }

    const isAuthFailure =
      lastAssistantError === "authentication_failed" || this.isAuthFailureMessage(normalizedMessage);

    if (isAuthFailure) {
      throw createAuthRequiredError(normalizedMessage);
    }

    throw new Error(normalizedMessage);
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

  private resolveAuthToken(): AuthTokenResolution {
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

    const expiresMs = resolveCredentialExpiryMs(credential);
    if (expiresMs !== undefined && expiresMs <= Date.now()) {
      throw createAuthRequiredError("claude-agent-sdk OAuth token expired.");
    }

    return {
      token
    };
  }

  private buildRuntimeEnv(token: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.runtimeEnv,
      ANTHROPIC_API_KEY: token,
      ANTHROPIC_AUTH_TOKEN: token
    };

    return env;
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
      /\bconversation\b.*\b(not found|unknown)\b/
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

    const sessionMessage = {
      role: "assistant" as const,
      content,
      stopReason,
      errorMessage: message.error ? sdkAssistantErrorToMessage(message.error) : undefined
    };

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

    void this.callbacks.onRuntimeError?.(this.descriptor.agentId, {
      phase,
      message: normalized.message,
      stack: normalized.stack,
      details
    });
  }
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
