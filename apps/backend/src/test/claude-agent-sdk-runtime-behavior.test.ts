import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import type { RuntimeErrorEvent, SwarmRuntimeCallbacks } from "../swarm/runtime-types.js";
import type { AgentDescriptor } from "../swarm/types.js";

const sdkMockState = vi.hoisted(() => ({
  queryCalls: [] as Array<{ prompt: string; options?: Record<string, unknown> }>,
  streams: [] as Array<unknown[]>
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn(() => ({})),
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
  afterEach(() => {
    sdkMockState.queryCalls = [];
    sdkMockState.streams = [];
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
