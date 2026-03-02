import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { RuntimeErrorEvent, SwarmRuntimeCallbacks } from "../swarm/runtime-types.js";
import type { AgentDescriptor } from "../swarm/types.js";

const sdkMockState = vi.hoisted(() => ({
  queryCalls: [] as Array<{ prompt: string; options?: Record<string, unknown> }>,
  streams: [] as Array<unknown[]>,
  mcpServerCalls: [] as Array<{ name: string; tools?: Array<{ inputSchema?: unknown }> }>
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

    let isClosed = false;

    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) {
          if (isClosed) {
            return;
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
        isClosed = true;
      },
      close() {
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
    sdkMockState.mcpServerCalls = [];
    vi.clearAllMocks();
  });

  it("persists session id and resumes deliveries across runtime restarts", async () => {
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

    await runtimeAfterRestart.terminate({ abort: true });
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
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-oauth-token");
    expect(env?.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("claude-refresh-token");
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

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

    expect(sdkMockState.queryCalls).toHaveLength(1);
    expect(sdkMockState.queryCalls[0]?.options?.resume).toBe("stale-session");
    expect(runtimeErrors[0]?.details?.retriable).toBe(true);

    await runtime.terminate({ abort: true });
  });
});
