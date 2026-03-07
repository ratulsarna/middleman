import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { RuntimeErrorEvent, RuntimeSessionEvent, SwarmRuntimeCallbacks } from "../swarm/runtime-types.js";
import type { AgentDescriptor } from "../swarm/types.js";

const sdkMockState = vi.hoisted(() => ({
  queryCalls: [] as Array<{ prompt: string; options?: Record<string, unknown> }>,
  streams: [] as Array<unknown[]>,
  initializationResults: [] as unknown[],
  interruptAbortedSignals: [] as boolean[],
  interruptCalls: 0,
  closeCalls: 0,
  interruptThrowsAbortWhenSignalAborted: false,
  mcpServerCalls: [] as Array<{ name: string; tools?: Array<{ inputSchema?: unknown }> }>,
  supportedModelsResponses: [] as unknown[],
  supportedModelsCallCount: 0
}));

const oauthRefreshMockState = vi.hoisted(() => ({
  refreshAnthropicToken: vi.fn()
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((options: { name: string; tools?: Array<{ inputSchema?: unknown }> }) => {
    sdkMockState.mcpServerCalls.push(options);
    return {};
  }),
  query: vi.fn((params: { prompt: string; options?: Record<string, unknown> }) => {
    sdkMockState.queryCalls.push(params);
    const messages = sdkMockState.streams.shift() ?? [];
    const initializationResult = sdkMockState.initializationResults.shift();

    let isClosed = false;

    return {
      async initializationResult() {
        if (
          initializationResult &&
          typeof initializationResult === "object" &&
          "__throw" in (initializationResult as Record<string, unknown>)
        ) {
          throw new Error(String((initializationResult as { __throw: unknown }).__throw));
        }

        return initializationResult ?? {};
      },
      async supportedModels() {
        sdkMockState.supportedModelsCallCount += 1;
        const response = sdkMockState.supportedModelsResponses.shift();
        if (response && typeof response === "object" && "__throw" in (response as Record<string, unknown>)) {
          throw new Error(String((response as { __throw: unknown }).__throw));
        }

        return Array.isArray(response) ? response : [];
      },
      async *[Symbol.asyncIterator]() {
        for (const message of messages) {
          if (isClosed) {
            return;
          }
          if (
            message &&
            typeof message === "object" &&
            "__delay" in (message as Record<string, unknown>) &&
            typeof (message as { __delay?: unknown }).__delay === "number"
          ) {
            await new Promise((resolve) => setTimeout(resolve, (message as { __delay: number }).__delay));
            continue;
          }
          if (
            message &&
            typeof message === "object" &&
            "__stderr" in (message as Record<string, unknown>) &&
            typeof (message as { __stderr?: unknown }).__stderr === "string"
          ) {
            const onStderr = params.options?.stderr as ((data: string) => void) | undefined;
            onStderr?.((message as { __stderr: string }).__stderr);
            continue;
          }
          if (
            message &&
            typeof message === "object" &&
            "__throw" in (message as Record<string, unknown>) &&
            typeof (message as { __throw?: unknown }).__throw === "string"
          ) {
            throw new Error((message as { __throw: string }).__throw);
          }
          yield message;
        }
      },
      async interrupt() {
        sdkMockState.interruptCalls += 1;
        const abortController = params.options?.abortController as AbortController | undefined;
        const aborted = Boolean(abortController?.signal.aborted);
        sdkMockState.interruptAbortedSignals.push(aborted);
        if (sdkMockState.interruptThrowsAbortWhenSignalAborted && aborted) {
          const error = new Error("Operation aborted");
          (error as Error & { name: string }).name = "AbortError";
          throw error;
        }
        isClosed = true;
      },
      close() {
        sdkMockState.closeCalls += 1;
        isClosed = true;
      }
    };
  })
}));

vi.mock("@mariozechner/pi-ai/dist/utils/oauth/anthropic.js", () => ({
  refreshAnthropicToken: (...args: unknown[]) => oauthRefreshMockState.refreshAnthropicToken(...args)
}));

import { ClaudeAgentSdkRuntime } from "../swarm/claude-agent-sdk-runtime.js";

function createDescriptor(rootDir: string): AgentDescriptor {
  const now = "2026-01-01T00:00:00.000Z";

  return {
    agentId: "claude-worker",
    displayName: "Claude Worker",
    role: "worker",
    managerId: "manager",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    cwd: rootDir,
    model: {
      provider: "claude-agent-sdk",
      modelId: "claude-opus-4-6",
      thinkingLevel: "xhigh"
    },
    sessionFile: join(rootDir, "sessions", "claude-worker.jsonl")
  };
}

async function createRuntimeRootDir(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "claude-agent-sdk-runtime-behavior-test-"));
  await mkdir(join(rootDir, "sessions"), { recursive: true });
  await mkdir(join(rootDir, "auth"), { recursive: true });
  return rootDir;
}

function setAuthCredential(authFile: string, provider: string, credential: AuthCredential): void {
  const authStorage = AuthStorage.create(authFile);
  authStorage.set(provider, credential);
}

function getClaudeRuntimeStateFile(sessionFile: string): string {
  return `${sessionFile}.claude-runtime-state.json`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ClaudeAgentSdkRuntime behavior", () => {
  beforeEach(() => {
    oauthRefreshMockState.refreshAnthropicToken.mockReset();
    oauthRefreshMockState.refreshAnthropicToken.mockImplementation(async () => {
      throw new Error("Unexpected OAuth refresh call");
    });
  });

  afterEach(() => {
    sdkMockState.queryCalls = [];
    sdkMockState.streams = [];
    sdkMockState.initializationResults = [];
    sdkMockState.interruptAbortedSignals = [];
    sdkMockState.interruptCalls = 0;
    sdkMockState.closeCalls = 0;
    sdkMockState.interruptThrowsAbortWhenSignalAborted = false;
    sdkMockState.mcpServerCalls = [];
    sdkMockState.supportedModelsResponses = [];
    sdkMockState.supportedModelsCallCount = 0;
    vi.clearAllMocks();
  });

  it("persists session id and resumes deliveries across runtime restarts", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    sdkMockState.streams.push(
      [
        {
          type: "assistant",
          session_id: "session-abc",
          message: { content: [{ type: "text", text: "hello" }] }
        },
        {
          type: "result",
          subtype: "success",
          session_id: "session-abc",
          usage: undefined,
          modelUsage: {}
        }
      ],
      [
        {
          type: "result",
          subtype: "success",
          session_id: "session-abc",
          usage: undefined,
          modelUsage: {}
        }
      ],
      [
        {
          type: "result",
          subtype: "success",
          session_id: "session-abc",
          usage: undefined,
          modelUsage: {}
        }
      ]
    );

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("first");
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    await runtime.sendMessage("second");
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    await runtime.terminate({ abort: true });

    const runtimeAfterRestart = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtimeAfterRestart.sendMessage("third");
    await waitFor(() => runtimeAfterRestart.getPendingCount() === 0 && runtimeAfterRestart.getStatus() === "idle");

    expect(sdkMockState.queryCalls).toHaveLength(3);
    expect(sdkMockState.queryCalls[0]?.options?.resume).toBeUndefined();
    expect(sdkMockState.queryCalls[1]?.options?.resume).toBe("session-abc");
    expect(sdkMockState.queryCalls[2]?.options?.resume).toBe("session-abc");

    const persistedState = JSON.parse(
      await readFile(getClaudeRuntimeStateFile(createDescriptor(rootDir).sessionFile), "utf8")
    ) as { sessionId?: string | null };
    expect(persistedState.sessionId).toBe("session-abc");
    expect(
      infoSpy.mock.calls.some(
        (call) =>
          typeof call[1] === "object" &&
          call[1] &&
          (call[1] as { event?: string; outcome?: string }).event === "resume_state" &&
          (call[1] as { event?: string; outcome?: string }).outcome === "resume_success"
      )
    ).toBe(true);

    await runtimeAfterRestart.terminate({ abort: true });
    infoSpy.mockRestore();
  });

  it("persists custom session entries even before assistant messages exist", async () => {
    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const descriptor = createDescriptor(rootDir);

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    runtime.appendCustomEntry("swarm_conversation_entry", {
      type: "conversation_message",
      agentId: descriptor.agentId,
      role: "user",
      text: "hello",
      timestamp: new Date().toISOString(),
      source: "user_input"
    });

    const sessionFileText = await readFile(descriptor.sessionFile, "utf8");
    expect(sessionFileText).toContain('"customType":"swarm_conversation_entry"');

    await runtime.terminate({ abort: true });
  });

  it("does not force-close a query after successful delivery completion", async () => {
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "success",
        session_id: "session-no-close-success",
        usage: undefined,
        modelUsage: {}
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("no force close");
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    expect(sdkMockState.closeCalls).toBe(0);

    await runtime.terminate({ abort: true });
  });

  it("interrupts and closes active query when stopInFlight aborts", async () => {
    sdkMockState.streams.push([
      {
        __delay: 200
      },
      {
        type: "result",
        subtype: "success",
        session_id: "session-stop-close",
        usage: undefined,
        modelUsage: {}
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("abort now");
    await waitFor(() => sdkMockState.queryCalls.length === 1);
    await runtime.stopInFlight({ abort: true });
    await waitFor(() => runtime.getStatus() === "idle" && runtime.getPendingCount() === 0);

    expect(sdkMockState.interruptCalls).toBeGreaterThanOrEqual(1);
    expect(sdkMockState.closeCalls).toBeGreaterThanOrEqual(1);

    await runtime.terminate({ abort: true });
  });

  it("passes Claude OAuth credentials via Claude Code env vars", async () => {
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "success",
        session_id: "session-env",
        usage: undefined,
        modelUsage: {}
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "claude-refresh-token",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("check auth env");
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    const env = sdkMockState.queryCalls[0]?.options?.env as Record<string, string | undefined> | undefined;
    const settingSources = sdkMockState.queryCalls[0]?.options?.settingSources as string[] | undefined;
    const systemPrompt = sdkMockState.queryCalls[0]?.options?.systemPrompt as
      | { type?: string; preset?: string; append?: string }
      | undefined;
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-oauth-token");
    expect(env?.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("claude-refresh-token");
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(settingSources).toEqual(["project"]);
    expect(systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are a worker"
    });

    await runtime.terminate({ abort: true });
  });

  it("reads output-style metadata without pre-aborting the probe interrupt path", async () => {
    sdkMockState.interruptThrowsAbortWhenSignalAborted = true;
    sdkMockState.initializationResults.push({
      output_style: " concise ",
      available_output_styles: ["concise", "detailed", "", "concise", null]
    });

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "claude-refresh-token",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    const metadata = await runtime.getClaudeOutputStyleMetadata();

    expect(metadata).toEqual({
      selectedStyle: "concise",
      availableStyles: ["concise", "detailed"]
    });
    expect(sdkMockState.queryCalls).toHaveLength(1);
    expect(sdkMockState.queryCalls[0]?.prompt).toBe("Nexus output style metadata probe.");
    expect(sdkMockState.queryCalls[0]?.options?.abortController).toBeUndefined();
    expect(sdkMockState.queryCalls[0]?.options?.mcpServers).toBeUndefined();
    expect(sdkMockState.interruptAbortedSignals).toEqual([false]);

    await runtime.terminate({ abort: true });
  });

  it("returns metadata busy error without starting a probe when runtime is handling a turn", async () => {
    sdkMockState.streams.push([
      {
        __delay: 150
      },
      {
        type: "result",
        subtype: "success",
        session_id: "session-output-style-busy",
        usage: undefined,
        modelUsage: {}
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "claude-refresh-token",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("keep busy");
    await waitFor(() => sdkMockState.queryCalls.length === 1);

    await expect(runtime.getClaudeOutputStyleMetadata()).rejects.toThrow(
      "Claude output-style metadata is unavailable while the runtime is busy."
    );
    expect(sdkMockState.queryCalls).toHaveLength(1);

    await runtime.stopInFlight({ abort: true });
    await waitFor(() => runtime.getStatus() === "idle");
    await runtime.terminate({ abort: true });
  });

  it("single-flights concurrent output-style metadata probes", async () => {
    let resolveInitialization: ((value: { output_style: string; available_output_styles: string[] }) => void) | undefined;
    const deferredInitialization = new Promise<{ output_style: string; available_output_styles: string[] }>((resolve) => {
      resolveInitialization = resolve;
    });
    sdkMockState.initializationResults.push(deferredInitialization);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "claude-refresh-token",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    const firstProbe = runtime.getClaudeOutputStyleMetadata();
    const secondProbe = runtime.getClaudeOutputStyleMetadata();
    await waitFor(() => sdkMockState.queryCalls.length === 1);

    resolveInitialization?.({
      output_style: "concise",
      available_output_styles: ["concise", "technical", ""]
    });

    const [firstResult, secondResult] = await Promise.all([firstProbe, secondProbe]);
    expect(firstResult).toEqual({
      selectedStyle: "concise",
      availableStyles: ["concise", "technical"]
    });
    expect(secondResult).toEqual(firstResult);
    expect(sdkMockState.queryCalls).toHaveLength(1);

    await runtime.terminate({ abort: true });
  });

  it("defers delivery query start while output-style metadata probe is in flight", async () => {
    let resolveInitialization: ((value: { output_style: string; available_output_styles: string[] }) => void) | undefined;
    const deferredInitialization = new Promise<{ output_style: string; available_output_styles: string[] }>((resolve) => {
      resolveInitialization = resolve;
    });
    sdkMockState.initializationResults.push(deferredInitialization);
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "success",
        session_id: "session-after-probe",
        usage: undefined,
        modelUsage: {}
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "claude-refresh-token",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    const probePromise = runtime.getClaudeOutputStyleMetadata();
    await waitFor(() => sdkMockState.queryCalls.length === 1);

    const receipt = await runtime.sendMessage("run after probe");
    expect(receipt.acceptedMode).toBe("followUp");
    expect(sdkMockState.queryCalls).toHaveLength(1);

    resolveInitialization?.({
      output_style: "concise",
      available_output_styles: ["concise"]
    });
    await probePromise;

    await waitFor(() => sdkMockState.queryCalls.length === 2);
    expect(sdkMockState.queryCalls[1]?.prompt).toBe("run after probe");
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    await runtime.terminate({ abort: true });
  });

  it("maps canonical thinking level to deterministic Claude thinking/effort with safe static clamp", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "success",
        session_id: "session-reasoning-floor",
        usage: undefined,
        modelUsage: {}
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "claude-refresh-token",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    try {
      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: {
          onStatusChange: async () => {}
        },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.sendMessage("apply canonical mapping");
      await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

      expect(sdkMockState.supportedModelsCallCount).toBe(0);
      expect(sdkMockState.queryCalls).toHaveLength(1);
      expect(sdkMockState.queryCalls[0]?.options?.thinking).toEqual({ type: "enabled" });
      expect(sdkMockState.queryCalls[0]?.options?.effort).toBe("high");

      const queryAttemptPayload = infoSpy.mock.calls.find(
        (call) =>
          typeof call[1] === "object" &&
          call[1] &&
          (call[1] as { event?: string }).event === "query_attempt"
      )?.[1] as
        | {
            runtime?: string;
            event?: string;
            model?: string;
            settingSources?: string[];
            thinkingOption?: unknown;
            effortOption?: string;
            requestedThinking?: string;
            effectiveThinking?: string;
            requestedEffort?: string;
            effectiveEffort?: string;
            effortClamped?: boolean;
          }
        | undefined;

      expect(queryAttemptPayload?.runtime).toBe("claude-agent-sdk");
      expect(queryAttemptPayload?.event).toBe("query_attempt");
      expect(queryAttemptPayload?.model).toBe("claude-opus-4-6");
      expect(queryAttemptPayload?.settingSources).toEqual(["project"]);
      expect(queryAttemptPayload?.thinkingOption).toEqual({ type: "enabled" });
      expect(queryAttemptPayload?.effortOption).toBe("high");
      expect(queryAttemptPayload?.requestedThinking).toBe("enabled");
      expect(queryAttemptPayload?.effectiveThinking).toBe("enabled");
      expect(queryAttemptPayload?.requestedEffort).toBe("max");
      expect(queryAttemptPayload?.effectiveEffort).toBe("high");
      expect(queryAttemptPayload?.effortClamped).toBe(true);

      await runtime.terminate({ abort: true });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("keeps mapped low effort for minimal thinking level under static clamp bounds", async () => {
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "success",
        session_id: "session-reasoning-min-floor",
        usage: undefined,
        modelUsage: {}
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const descriptor = createDescriptor(rootDir);
    descriptor.model.thinkingLevel = "minimal";

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "claude-refresh-token",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("apply minimum floor");
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    expect(sdkMockState.queryCalls).toHaveLength(1);
    expect(sdkMockState.queryCalls[0]?.options?.effort).toBe("low");
    expect(sdkMockState.queryCalls[0]?.options?.thinking).toEqual({ type: "enabled" });

    await runtime.terminate({ abort: true });
  });

  it("does not probe model capabilities on query path", async () => {
    sdkMockState.supportedModelsResponses.push({
      __throw: "supportedModels unavailable"
    });
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "success",
        session_id: "session-reasoning-fallback",
        usage: undefined,
        modelUsage: {}
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "claude-refresh-token",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("capabilities unavailable fallback");
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    expect(sdkMockState.supportedModelsCallCount).toBe(0);
    expect(sdkMockState.queryCalls).toHaveLength(1);
    expect(sdkMockState.queryCalls[0]?.options?.thinking).toEqual({ type: "enabled" });
    expect(sdkMockState.queryCalls[0]?.options?.effort).toBe("high");

    await runtime.terminate({ abort: true });
  });

  it("disables thinking and omits effort for off thinking level", async () => {
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "success",
        session_id: "session-thinking-off",
        usage: undefined,
        modelUsage: {}
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const descriptor = createDescriptor(rootDir);
    descriptor.model.thinkingLevel = "off";

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "claude-refresh-token",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("thinking off");
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    expect(sdkMockState.queryCalls).toHaveLength(1);
    expect(sdkMockState.queryCalls[0]?.options?.thinking).toEqual({ type: "disabled" });
    expect(sdkMockState.queryCalls[0]?.options?.effort).toBeUndefined();

    await runtime.terminate({ abort: true });
  });

  it("converts TypeBox tool schemas to SDK-compatible zod schemas", async () => {
    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [
        {
          name: "sample_tool",
          label: "Sample Tool",
          description: "A sample tool for schema conversion behavior.",
          parameters: Type.Object({
            targetAgentId: Type.String(),
            delivery: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("followUp")])),
            target: Type.Optional(
              Type.Object({
                channel: Type.Union([Type.Literal("web"), Type.Literal("slack")])
              })
            )
          }),
          execute: async () => ({
            content: [{ type: "text", text: "ok" }],
            details: {}
          })
        }
      ],
      authFile
    });

    const toolSchema = sdkMockState.mcpServerCalls[0]?.tools?.[0]?.inputSchema as
      | { safeParseAsync?: (value: unknown) => Promise<{ success: boolean; data?: unknown }> }
      | undefined;
    expect(typeof toolSchema?.safeParseAsync).toBe("function");

    const parsed = await toolSchema?.safeParseAsync?.({
      targetAgentId: "worker-1",
      delivery: "auto",
      target: { channel: "web" }
    });
    expect(parsed?.success).toBe(true);

    const invalid = await toolSchema?.safeParseAsync?.({
      targetAgentId: 123
    });
    expect(invalid?.success).toBe(false);

    await runtime.terminate({ abort: true });
  });

  it("refreshes expired OAuth credentials before starting a delivery", async () => {
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "success",
        session_id: "session-refresh",
        usage: undefined,
        modelUsage: {}
      }
    ]);
    oauthRefreshMockState.refreshAnthropicToken.mockResolvedValue({
      access: "fresh-oauth-token",
      refresh: "fresh-refresh-token",
      expires: Date.now() + 60_000
    });

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "stale-oauth-token",
      refresh: "refresh-token",
      expires: String(Date.now() - 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("refresh auth");
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    expect(oauthRefreshMockState.refreshAnthropicToken).toHaveBeenCalledTimes(1);
    expect(oauthRefreshMockState.refreshAnthropicToken).toHaveBeenCalledWith("refresh-token");
    const env = sdkMockState.queryCalls[0]?.options?.env as Record<string, string | undefined> | undefined;
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("fresh-oauth-token");
    expect(env?.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("fresh-refresh-token");
    const stored = AuthStorage.create(authFile).get("claude-agent-sdk") as
      | (AuthCredential & { access?: string; refresh?: string })
      | undefined;
    expect(stored?.access).toBe("fresh-oauth-token");
    expect(stored?.refresh).toBe("fresh-refresh-token");

    await runtime.terminate({ abort: true });
  });

  it("does not resume when persisted runtime state uses the null sentinel", async () => {
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "success",
        session_id: "fresh-session",
        usage: undefined,
        modelUsage: {}
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const descriptor = createDescriptor(rootDir);
    await writeFile(
      getClaudeRuntimeStateFile(descriptor.sessionFile),
      `${JSON.stringify({ sessionId: null })}\n`,
      "utf8"
    );

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("start fresh");
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    expect(sdkMockState.queryCalls).toHaveLength(1);
    expect(sdkMockState.queryCalls[0]?.options?.resume).toBeUndefined();

    await runtime.terminate({ abort: true });
  });

  it("treats max_output_tokens errors as retriable runtime failures", async () => {
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "session-xyz",
        usage: undefined,
        modelUsage: {},
        errors: ["max_output_tokens token limit reached"]
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const runtimeErrors: RuntimeErrorEvent[] = [];

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const callbacks: SwarmRuntimeCallbacks = {
      onStatusChange: async () => {},
      onRuntimeError: async (_agentId, error) => {
        runtimeErrors.push(error);
      }
    };

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks,
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("trigger error");
    await waitFor(() => runtimeErrors.length > 0);

    expect(sdkMockState.queryCalls).toHaveLength(1);
    expect(sdkMockState.queryCalls[0]?.options?.settingSources).toEqual(["project"]);

    const lastError = runtimeErrors[runtimeErrors.length - 1];
    expect(lastError?.details?.retriable).toBe(true);
    expect(lastError?.details?.reconnectRequired).toBe(false);
    expect(lastError?.message).not.toContain("Reconnect Claude Agent SDK in Settings and retry.");

    await runtime.terminate({ abort: true });
  });

  it("does not duplicate reconnect guidance for auth-required errors", async () => {
    sdkMockState.streams.push([
      {
        type: "auth_status",
        session_id: "session-auth",
        error: "authentication failed"
      },
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "session-auth",
        usage: undefined,
        modelUsage: {},
        errors: ["authentication failed"]
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const runtimeErrors: RuntimeErrorEvent[] = [];

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const callbacks: SwarmRuntimeCallbacks = {
      onStatusChange: async () => {},
      onRuntimeError: async (_agentId, error) => {
        runtimeErrors.push(error);
      }
    };

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks,
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("trigger auth error");
    await waitFor(() => runtimeErrors.length > 0);

    const reconnectText = "Reconnect Claude Agent SDK in Settings and retry.";
    const message = runtimeErrors[runtimeErrors.length - 1]?.message ?? "";
    const occurrences = message.split(reconnectText).length - 1;
    expect(occurrences).toBe(1);

    await runtime.terminate({ abort: true });
  });

  it("prefers assistant auth errors over trailing process exit failures", async () => {
    sdkMockState.streams.push([
      {
        type: "assistant",
        session_id: "session-auth-trailing-exit",
        error: "authentication_failed",
        message: {
          content: [
            {
              type: "text",
              text: "Your account does not have access to Claude. Please login again."
            }
          ]
        }
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        session_id: "session-auth-trailing-exit",
        usage: undefined,
        modelUsage: {}
      },
      {
        __throw: "Claude Code process exited with code 1"
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const runtimeErrors: RuntimeErrorEvent[] = [];

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const callbacks: SwarmRuntimeCallbacks = {
      onStatusChange: async () => {},
      onRuntimeError: async (_agentId, error) => {
        runtimeErrors.push(error);
      }
    };

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks,
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("trigger trailing process exit");
    await waitFor(() => runtimeErrors.length > 0);

    const lastError = runtimeErrors[runtimeErrors.length - 1];
    expect(lastError?.details?.retriable).toBe(false);
    expect(lastError?.details?.reconnectRequired).toBe(true);
    expect(lastError?.message).toContain("Your account does not have access to Claude.");
    expect(lastError?.message).toContain("Reconnect Claude Agent SDK in Settings and retry.");

    await runtime.terminate({ abort: true });
  });

  it("treats token-expired failures as non-retriable auth-required errors", async () => {
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "session-expired",
        usage: undefined,
        modelUsage: {},
        errors: ["token expired while loading credentials"]
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const runtimeErrors: RuntimeErrorEvent[] = [];

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const callbacks: SwarmRuntimeCallbacks = {
      onStatusChange: async () => {},
      onRuntimeError: async (_agentId, error) => {
        runtimeErrors.push(error);
      }
    };

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks,
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("trigger token expiry");
    await waitFor(() => runtimeErrors.length > 0);

    const lastError = runtimeErrors[runtimeErrors.length - 1];
    expect(lastError?.details?.retriable).toBe(false);
    expect(lastError?.details?.reconnectRequired).toBe(true);
    expect(lastError?.message).toContain("Reconnect Claude Agent SDK in Settings and retry.");

    await runtime.terminate({ abort: true });
  });

  it("surfaces stderr-only startup failures as runtime errors", async () => {
    sdkMockState.streams.push([
      {
        __stderr: "startup failed: missing grant"
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const runtimeErrors: RuntimeErrorEvent[] = [];

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const callbacks: SwarmRuntimeCallbacks = {
      onStatusChange: async () => {},
      onRuntimeError: async (_agentId, error) => {
        runtimeErrors.push(error);
      }
    };

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks,
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("trigger stderr startup failure");
    await waitFor(() => runtimeErrors.length > 0);

    const lastError = runtimeErrors[runtimeErrors.length - 1];
    expect(lastError?.message).toContain("startup failed: missing grant");
    expect(lastError?.details?.retriable).toBe(true);
    expect(lastError?.details?.reconnectRequired).toBe(false);
    expect(lastError?.details?.runtime).toBe("claude-agent-sdk");
    expect(lastError?.details?.outcome).toBe("missing_result");
    expect(lastError?.details?.resultMessages).toBe(0);
    expect(lastError?.details?.stderrSummary).toContain("startup failed: missing grant");
    expect(lastError?.details?.deliveryId).toEqual(expect.any(String));

    await runtime.terminate({ abort: true });
  });

  it("clears stale persisted resume ids and retries once without resume", async () => {
    sdkMockState.streams.push(
      [
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "stale-session",
          usage: undefined,
          modelUsage: {},
          errors: ["resume failed: session not found"]
        },
        {
          __throw: "Claude Code process exited with code 1"
        }
      ],
      [
        {
          type: "assistant",
          session_id: "fresh-session",
          message: { content: [{ type: "text", text: "recovered" }] }
        },
        {
          type: "result",
          subtype: "success",
          session_id: "fresh-session",
          usage: undefined,
          modelUsage: {}
        }
      ]
    );

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const descriptor = createDescriptor(rootDir);
    await writeFile(
      getClaudeRuntimeStateFile(descriptor.sessionFile),
      `${JSON.stringify({ sessionId: "stale-session" })}\n`,
      "utf8"
    );

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("retry stale resume");
    await waitFor(() => sdkMockState.queryCalls.length >= 2);
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");
    expect(sdkMockState.queryCalls).toHaveLength(2);
    expect(sdkMockState.queryCalls[0]?.options?.resume).toBe("stale-session");
    expect(sdkMockState.queryCalls[1]?.options?.resume).toBeUndefined();

    const persisted = runtime.getCustomEntries("swarm_claude_agent_sdk_runtime_state") as Array<{
      sessionId?: string | null;
    }>;
    expect(persisted.some((entry) => entry.sessionId === null)).toBe(true);
    expect(persisted.some((entry) => entry.sessionId === "fresh-session")).toBe(true);

    await runtime.terminate({ abort: true });
  });

  it("treats 'No conversation found with session ID' as a recoverable resume failure", async () => {
    sdkMockState.streams.push(
      [
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "new-session-id-from-failed-resume",
          usage: undefined,
          modelUsage: {},
          errors: ["No conversation found with session ID: missing-session"]
        },
        {
          __throw: "Claude Code process exited with code 1"
        }
      ],
      [
        {
          type: "assistant",
          session_id: "fresh-after-no-conversation",
          message: { content: [{ type: "text", text: "recovered from no-conversation error" }] }
        },
        {
          type: "result",
          subtype: "success",
          session_id: "fresh-after-no-conversation",
          usage: undefined,
          modelUsage: {}
        }
      ]
    );

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const descriptor = createDescriptor(rootDir);
    await writeFile(
      getClaudeRuntimeStateFile(descriptor.sessionFile),
      `${JSON.stringify({ sessionId: "missing-session" })}\n`,
      "utf8"
    );

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {}
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("recover no conversation found");
    await waitFor(() => sdkMockState.queryCalls.length >= 2);
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    expect(sdkMockState.queryCalls).toHaveLength(2);
    expect(sdkMockState.queryCalls[0]?.options?.resume).toBe("missing-session");
    expect(sdkMockState.queryCalls[1]?.options?.resume).toBeUndefined();

    await runtime.terminate({ abort: true });
  });

  it("does not auto-retry resume failures after assistant output has already streamed", async () => {
    sdkMockState.streams.push([
      {
        type: "assistant",
        session_id: "stale-session",
        message: { content: [{ type: "text", text: "partial response" }] }
      },
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "stale-session",
        usage: undefined,
        modelUsage: {},
        errors: ["resume failed: session not found"]
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const descriptor = createDescriptor(rootDir);
    const runtimeErrors: RuntimeErrorEvent[] = [];
    await writeFile(
      getClaudeRuntimeStateFile(descriptor.sessionFile),
      `${JSON.stringify({ sessionId: "stale-session" })}\n`,
      "utf8"
    );

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
        onRuntimeError: async (_agentId, error) => {
          runtimeErrors.push(error);
        }
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("do not retry");
    await waitFor(() => runtimeErrors.length > 0);
    await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

    expect(sdkMockState.queryCalls).toHaveLength(1);
    expect(sdkMockState.queryCalls[0]?.options?.resume).toBe("stale-session");
    expect(runtimeErrors[0]?.details?.retriable).toBe(true);

    await runtime.terminate({ abort: true });
  });

  it("retries once with fallback settings and emits a structured warning for settings read failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      sdkMockState.streams.push(
        [
          {
            type: "result",
            subtype: "error_during_execution",
            session_id: "settings-fail-session",
            usage: undefined,
            modelUsage: {},
            errors: ["Failed to parse .claude/settings.json: Unexpected token } in JSON at position 12"]
          }
        ],
        [
          {
            type: "assistant",
            session_id: "settings-fallback-session",
            message: { content: [{ type: "text", text: "fallback succeeded" }] }
          },
          {
            type: "result",
            subtype: "success",
            session_id: "settings-fallback-session",
            usage: undefined,
            modelUsage: {}
          }
        ]
      );

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");
      const runtimeErrors: RuntimeErrorEvent[] = [];

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: {
          onStatusChange: async () => {},
          onRuntimeError: async (_agentId, error) => {
            runtimeErrors.push(error);
          }
        },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.sendMessage("trigger settings failure fallback");
      await waitFor(() => sdkMockState.queryCalls.length >= 2);
      await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

      expect(sdkMockState.queryCalls).toHaveLength(2);
      expect(sdkMockState.queryCalls[0]?.options?.settingSources).toEqual(["project"]);
      expect(sdkMockState.queryCalls[1]?.options?.settingSources).toEqual([]);
      expect(runtimeErrors).toHaveLength(0);

      expect(warnSpy).toHaveBeenCalled();
      const warningPayload = warnSpy.mock.calls.find((call) =>
        call.some((entry) => typeof entry === "object" && entry && "event" in (entry as Record<string, unknown>))
      )?.[1] as
        | {
            runtime?: string;
            event?: string;
            attemptedSources?: string[];
            fallbackSources?: string[];
            reason?: string;
          }
        | undefined;
      expect(warningPayload?.runtime).toBe("claude-agent-sdk");
      expect(warningPayload?.event).toBe("settings_load_fallback");
      expect(warningPayload?.attemptedSources).toEqual(["project"]);
      expect(warningPayload?.fallbackSources).toEqual([]);
      expect(warningPayload?.reason).toContain(".claude/settings.json");

      const queryAttemptPayloads = infoSpy.mock.calls
        .filter(
          (call) =>
            typeof call[1] === "object" &&
            call[1] &&
            (call[1] as { event?: string }).event === "query_attempt"
        )
        .map((call) => call[1] as { settingSources?: string[]; requestedEffort?: string; effectiveEffort?: string });

      expect(queryAttemptPayloads).toHaveLength(2);
      expect(queryAttemptPayloads[0]?.settingSources).toEqual(["project"]);
      expect(queryAttemptPayloads[1]?.settingSources).toEqual([]);
      expect(queryAttemptPayloads[0]?.requestedEffort).toBe("max");
      expect(queryAttemptPayloads[0]?.effectiveEffort).toBe("high");
      expect(queryAttemptPayloads[1]?.requestedEffort).toBe("max");
      expect(queryAttemptPayloads[1]?.effectiveEffort).toBe("high");

      await runtime.terminate({ abort: true });
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("stops after one fallback retry when the fallback attempt also fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      sdkMockState.streams.push(
        [
          {
            type: "result",
            subtype: "error_during_execution",
            session_id: "settings-fail-first-attempt",
            usage: undefined,
            modelUsage: {},
            errors: ["Failed to parse .claude/settings.json: Unexpected token } in JSON at position 12"]
          }
        ],
        [
          {
            type: "result",
            subtype: "error_during_execution",
            session_id: "settings-fail-fallback-attempt",
            usage: undefined,
            modelUsage: {},
            errors: ["Failed to parse .claude/settings.json: Unexpected token ] in JSON at position 8"]
          }
        ]
      );

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");
      const runtimeErrors: RuntimeErrorEvent[] = [];

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: {
          onStatusChange: async () => {},
          onRuntimeError: async (_agentId, error) => {
            runtimeErrors.push(error);
          }
        },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.sendMessage("trigger double settings failure");
      await waitFor(() => runtimeErrors.length > 0);
      await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

      expect(sdkMockState.queryCalls).toHaveLength(2);
      expect(sdkMockState.queryCalls[0]?.options?.settingSources).toEqual(["project"]);
      expect(sdkMockState.queryCalls[1]?.options?.settingSources).toEqual([]);

      const fallbackWarnings = warnSpy.mock.calls.filter((call) =>
        call.some(
          (entry) =>
            typeof entry === "object" &&
            entry &&
            (entry as { event?: string }).event === "settings_load_fallback"
        )
      );
      expect(fallbackWarnings).toHaveLength(1);
      expect(runtimeErrors).toHaveLength(1);
      expect(runtimeErrors[0]?.message).toContain(".claude/settings.json");

      await runtime.terminate({ abort: true });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back when project settings.json is unreadable or invalid before query starts", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      sdkMockState.streams.push([
        {
          type: "assistant",
          session_id: "settings-preflight-fallback-session",
          message: { content: [{ type: "text", text: "fallback succeeded from preflight" }] }
        },
        {
          type: "result",
          subtype: "success",
          session_id: "settings-preflight-fallback-session",
          usage: undefined,
          modelUsage: {}
        }
      ]);

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");
      await mkdir(join(rootDir, ".claude"), { recursive: true });
      await writeFile(join(rootDir, ".claude", "settings.json"), "{ invalid json }\n", "utf8");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtimeErrors: RuntimeErrorEvent[] = [];
      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: {
          onStatusChange: async () => {},
          onRuntimeError: async (_agentId, error) => {
            runtimeErrors.push(error);
          }
        },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.sendMessage("trigger preflight settings fallback");
      await waitFor(() => runtime.getPendingCount() === 0 && runtime.getStatus() === "idle");

      // Primary attempt fails preflight before query() starts; fallback query runs once with defaults.
      expect(sdkMockState.queryCalls).toHaveLength(1);
      expect(sdkMockState.queryCalls[0]?.options?.settingSources).toEqual([]);
      expect(runtimeErrors).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();

      await runtime.terminate({ abort: true });
      await chmod(join(rootDir, ".claude", "settings.json"), 0o644);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not fallback for non-settings errors that mention CLAUDE.md or JSON", async () => {
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "non-settings-claude-md-session",
        usage: undefined,
        modelUsage: {},
        errors: ["Failed to parse output JSON while summarizing CLAUDE.md section"]
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const runtimeErrors: RuntimeErrorEvent[] = [];

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {},
        onRuntimeError: async (_agentId, error) => {
          runtimeErrors.push(error);
        }
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("trigger non-settings parse failure");
    await waitFor(() => runtimeErrors.length > 0);

    expect(sdkMockState.queryCalls).toHaveLength(1);
    expect(sdkMockState.queryCalls[0]?.options?.settingSources).toEqual(["project"]);
    expect(runtimeErrors[0]?.message).toContain("CLAUDE.md");

    await runtime.terminate({ abort: true });
  });

  it("does not fallback for generic user settings file parse errors unrelated to Claude settings", async () => {
    sdkMockState.streams.push([
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "non-settings-user-settings-session",
        usage: undefined,
        modelUsage: {},
        errors: ["Failed to parse user settings file generated by tool output"]
      }
    ]);

    const rootDir = await createRuntimeRootDir();
    const authFile = join(rootDir, "auth", "auth.json");
    const runtimeErrors: RuntimeErrorEvent[] = [];

    setAuthCredential(authFile, "claude-agent-sdk", {
      type: "oauth",
      access: "claude-oauth-token",
      refresh: "",
      expires: String(Date.now() + 60_000)
    } as unknown as AuthCredential);

    const runtime = await ClaudeAgentSdkRuntime.create({
      descriptor: createDescriptor(rootDir),
      callbacks: {
        onStatusChange: async () => {},
        onRuntimeError: async (_agentId, error) => {
          runtimeErrors.push(error);
        }
      },
      systemPrompt: "You are a worker",
      tools: [],
      authFile
    });

    await runtime.sendMessage("trigger non-settings user-settings failure");
    await waitFor(() => runtimeErrors.length > 0);

    expect(sdkMockState.queryCalls).toHaveLength(1);
    expect(sdkMockState.queryCalls[0]?.options?.settingSources).toEqual(["project"]);
    expect(runtimeErrors[0]?.message).toContain("user settings file");

    await runtime.terminate({ abort: true });
  });

  it("does not fallback when stopInFlight aborts before a settings failure is emitted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      sdkMockState.streams.push([
        {
          __delay: 100
        },
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "aborted-before-settings-error",
          usage: undefined,
          modelUsage: {},
          errors: ["Failed to parse .claude/settings.json: Unexpected token } in JSON at position 1"]
        }
      ]);

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");
      const runtimeErrors: RuntimeErrorEvent[] = [];

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: {
          onStatusChange: async () => {},
          onRuntimeError: async (_agentId, error) => {
            runtimeErrors.push(error);
          }
        },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.sendMessage("abort before settings error arrives");
      await waitFor(() => sdkMockState.queryCalls.length === 1);
      await runtime.stopInFlight({ abort: true });
      await waitFor(() => runtime.getStatus() === "idle" && runtime.getPendingCount() === 0);

      expect(sdkMockState.queryCalls).toHaveLength(1);
      expect(sdkMockState.queryCalls[0]?.options?.settingSources).toEqual(["project"]);
      const fallbackWarnings = warnSpy.mock.calls.filter((call) =>
        call.some(
          (entry) =>
            typeof entry === "object" &&
            entry &&
            (entry as { event?: string }).event === "settings_load_fallback"
        )
      );
      expect(fallbackWarnings).toHaveLength(0);
      expect(runtimeErrors.length).toBeLessThanOrEqual(1);
      if (runtimeErrors.length === 1) {
        expect(runtimeErrors[0]?.message).toContain("without returning a result");
      }

      await runtime.terminate({ abort: true });
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe("compaction", () => {
    it("sends /compact with custom instructions and updates context usage", async () => {
      sdkMockState.streams.push(
        [
          {
            type: "assistant",
            session_id: "session-compact-1",
            message: { content: [{ type: "text", text: "ok" }] }
          },
          {
            type: "result",
            subtype: "success",
            session_id: "session-compact-1",
            usage: { input_tokens: 100_000, output_tokens: 5_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
          }
        ],
        [
          {
            type: "result",
            subtype: "success",
            session_id: "session-compact-1",
            usage: { input_tokens: 10_000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
          }
        ]
      );

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: { onStatusChange: async () => {} },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.sendMessage("hello");
      await waitFor(() => runtime.getStatus() === "idle");

      const usageBefore = runtime.getContextUsage();
      expect(usageBefore).toBeDefined();
      expect(usageBefore!.tokens).toBe(105_000);

      await runtime.compact("summarize key decisions");

      const compactCall = sdkMockState.queryCalls[sdkMockState.queryCalls.length - 1];
      expect(compactCall?.prompt).toBe("/compact summarize key decisions");

      const usageAfter = runtime.getContextUsage();
      expect(usageAfter).toBeDefined();
      expect(usageAfter!.tokens).toBe(10_500);
      expect(usageAfter!.tokens).toBeLessThan(usageBefore!.tokens);
      expect(sdkMockState.closeCalls).toBe(0);

      await runtime.terminate({ abort: true });
    });

    it("sends bare /compact when no custom instructions provided", async () => {
      sdkMockState.streams.push([
        {
          type: "result",
          subtype: "success",
          session_id: "session-compact-bare",
          usage: { input_tokens: 5_000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
        }
      ]);

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: { onStatusChange: async () => {} },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.compact();

      expect(sdkMockState.queryCalls).toHaveLength(1);
      expect(sdkMockState.queryCalls[0]?.prompt).toBe("/compact");

      await runtime.terminate({ abort: true });
    });

    it("throws when compact is called while busy", async () => {
      sdkMockState.streams.push([
        { __delay: 500 },
        {
          type: "result",
          subtype: "success",
          session_id: "session-busy",
          usage: undefined,
          modelUsage: {}
        }
      ]);

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: { onStatusChange: async () => {} },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.sendMessage("hello");
      await waitFor(() => runtime.getStatus() === "streaming");

      await expect(runtime.compact()).rejects.toThrow(/cannot compact while busy/);

      await waitFor(() => runtime.getStatus() === "idle");
      await runtime.terminate({ abort: true });
    });

    it("throws when compact is called on terminated runtime", async () => {
      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: { onStatusChange: async () => {} },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.terminate();

      await expect(runtime.compact()).rejects.toThrow(/terminated/);
    });

    it("rejects second compact call while first is in progress", async () => {
      sdkMockState.streams.push([
        { __delay: 200 },
        {
          type: "result",
          subtype: "success",
          session_id: "session-double",
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
        }
      ]);

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: { onStatusChange: async () => {} },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      const firstCompact = runtime.compact();
      await expect(runtime.compact()).rejects.toThrow(/cannot compact while busy|already compacting/);

      await firstCompact;
      await runtime.terminate({ abort: true });
    });

    it("resets isCompacting flag on failure so runtime remains usable", async () => {
      sdkMockState.streams.push(
        [{ __throw: "compaction failed: context too small" }],
        [
          {
            type: "result",
            subtype: "success",
            session_id: "session-recover",
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
          }
        ]
      );

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: { onStatusChange: async () => {} },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await expect(runtime.compact()).rejects.toThrow(/compaction failed/);

      // Runtime should be usable again — compact() should not leave it in a broken state
      await runtime.compact();
      expect(sdkMockState.queryCalls).toHaveLength(2);

      await runtime.terminate({ abort: true });
    });

    it("emits auto_compaction_start and auto_compaction_end events for SDK auto-compaction during a query", async () => {
      sdkMockState.streams.push([
        {
          type: "assistant",
          session_id: "session-auto-compact",
          message: { content: [{ type: "text", text: "working..." }] }
        },
        {
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "uuid-1",
          session_id: "session-auto-compact"
        },
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 180_000 },
          uuid: "uuid-2",
          session_id: "session-auto-compact"
        },
        {
          type: "assistant",
          session_id: "session-auto-compact",
          message: { content: [{ type: "text", text: "done after compaction" }] }
        },
        {
          type: "result",
          subtype: "success",
          session_id: "session-auto-compact",
          usage: { input_tokens: 50_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
        }
      ]);

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const sessionEvents: RuntimeSessionEvent[] = [];

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: {
          onStatusChange: async () => {},
          onSessionEvent: async (_agentId, event) => {
            sessionEvents.push(event);
          }
        },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.sendMessage("do something big");
      await waitFor(() => runtime.getStatus() === "idle");

      const compactionEvents = sessionEvents.filter(
        (e) => e.type === "auto_compaction_start" || e.type === "auto_compaction_end"
      );

      expect(compactionEvents).toHaveLength(2);
      expect(compactionEvents[0]!.type).toBe("auto_compaction_start");
      expect(compactionEvents[1]!.type).toBe("auto_compaction_end");

      await runtime.terminate({ abort: true });
    });

    it("captures session id from compaction messages", async () => {
      sdkMockState.streams.push(
        [
          {
            type: "assistant",
            session_id: "session-before-compact",
            message: { content: [{ type: "text", text: "ok" }] }
          },
          {
            type: "result",
            subtype: "success",
            session_id: "session-before-compact",
            usage: undefined,
            modelUsage: {}
          }
        ],
        [
          {
            type: "result",
            subtype: "success",
            session_id: "session-after-compact",
            usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
          }
        ],
        [
          {
            type: "result",
            subtype: "success",
            session_id: "session-after-compact",
            usage: undefined,
            modelUsage: {}
          }
        ]
      );

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: { onStatusChange: async () => {} },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.sendMessage("first message");
      await waitFor(() => runtime.getStatus() === "idle");

      // First query should not have resume
      expect(sdkMockState.queryCalls[0]?.options?.resume).toBeUndefined();

      await runtime.compact();

      // Compact query should resume with the first session id
      expect(sdkMockState.queryCalls[1]?.options?.resume).toBe("session-before-compact");

      await runtime.sendMessage("after compact");
      await waitFor(() => runtime.getStatus() === "idle");

      // Next query should use the session id from compaction result
      expect(sdkMockState.queryCalls[2]?.options?.resume).toBe("session-after-compact");

      await runtime.terminate({ abort: true });
    });

    it("drains messages queued during compaction after compaction completes", async () => {
      sdkMockState.streams.push(
        // Stream 1: compaction (with delay so sendMessage runs mid-compact)
        [
          { __delay: 50 },
          {
            type: "result",
            subtype: "success",
            session_id: "session-compact",
            usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
          }
        ],
        // Stream 2: queued message processed after compaction
        [
          {
            type: "assistant",
            session_id: "session-compact",
            message: { content: [{ type: "text", text: "processed after compact" }] }
          },
          {
            type: "result",
            subtype: "success",
            session_id: "session-compact",
            usage: { input_tokens: 600, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
          }
        ]
      );

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: { onStatusChange: async () => {} },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      // Start compaction; while it's running, send a message
      const compactPromise = runtime.compact();
      // Give compaction a moment to set isCompacting and start the query
      await new Promise((resolve) => setTimeout(resolve, 10));
      await runtime.sendMessage("queued during compact");

      await compactPromise;

      // The queued message should be drained after compaction completes
      await waitFor(() => runtime.getStatus() === "idle" && runtime.getPendingCount() === 0);

      expect(sdkMockState.queryCalls).toHaveLength(2);
      expect(sdkMockState.queryCalls[0]?.prompt).toBe("/compact");
      expect(sdkMockState.queryCalls[1]?.prompt).toBe("queued during compact");

      await runtime.terminate({ abort: true });
    });

    it("retries compaction once when resume ID is stale", async () => {
      sdkMockState.streams.push(
        // Stream 1: initial message to set session ID
        [
          {
            type: "result",
            subtype: "success",
            session_id: "stale-session",
            usage: undefined,
            modelUsage: {}
          }
        ],
        // Stream 2: compaction attempt 1 — resume failure
        [{ __throw: "No conversation found with session ID stale-session" }],
        // Stream 3: compaction attempt 2 — succeeds without resume
        [
          {
            type: "result",
            subtype: "success",
            session_id: "new-session",
            usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
          }
        ]
      );

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: { onStatusChange: async () => {} },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      // First message sets session ID
      await runtime.sendMessage("setup");
      await waitFor(() => runtime.getStatus() === "idle");

      // Compact should retry once on stale session ID
      await runtime.compact();

      expect(sdkMockState.queryCalls).toHaveLength(3);
      // First compact attempt uses stale resume
      expect(sdkMockState.queryCalls[1]?.options?.resume).toBe("stale-session");
      // Second compact attempt has no resume (cleared)
      expect(sdkMockState.queryCalls[2]?.options?.resume).toBeUndefined();

      await runtime.terminate({ abort: true });
    });

    it("retries compaction when resume failure is reported via result message errors", async () => {
      sdkMockState.streams.push(
        // Stream 1: initial message to set session ID
        [
          {
            type: "result",
            subtype: "success",
            session_id: "stale-result-session",
            usage: undefined,
            modelUsage: {}
          }
        ],
        // Stream 2: compaction attempt 1 — non-success result with resume failure in errors array
        [
          {
            type: "result",
            subtype: "error_during_execution",
            session_id: "stale-result-session",
            errors: ["No conversation found with session ID stale-result-session"],
            usage: undefined,
            modelUsage: {}
          }
        ],
        // Stream 3: compaction attempt 2 — succeeds without resume
        [
          {
            type: "result",
            subtype: "success",
            session_id: "recovered-session",
            usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            modelUsage: { "claude-opus-4-6": { contextWindow: 200_000 } }
          }
        ]
      );

      const rootDir = await createRuntimeRootDir();
      const authFile = join(rootDir, "auth", "auth.json");

      setAuthCredential(authFile, "claude-agent-sdk", {
        type: "oauth",
        access: "claude-oauth-token",
        refresh: "",
        expires: String(Date.now() + 60_000)
      } as unknown as AuthCredential);

      const runtime = await ClaudeAgentSdkRuntime.create({
        descriptor: createDescriptor(rootDir),
        callbacks: { onStatusChange: async () => {} },
        systemPrompt: "You are a worker",
        tools: [],
        authFile
      });

      await runtime.sendMessage("setup");
      await waitFor(() => runtime.getStatus() === "idle");

      await runtime.compact();

      expect(sdkMockState.queryCalls).toHaveLength(3);
      expect(sdkMockState.queryCalls[1]?.options?.resume).toBe("stale-result-session");
      expect(sdkMockState.queryCalls[2]?.options?.resume).toBeUndefined();

      await runtime.terminate({ abort: true });
    });
  });
});
