import { describe, expect, it, beforeEach, vi } from "vitest";
import type { AgentDescriptor, SwarmConfig } from "../swarm/types.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  buildSwarmTools: vi.fn(),
  claudeCreate: vi.fn(),
  codexCreate: vi.fn()
}));

vi.mock("../swarm/swarm-tools.js", () => ({
  buildSwarmTools: runtimeFactoryMocks.buildSwarmTools
}));

vi.mock("../swarm/claude-agent-sdk-runtime.js", () => ({
  ClaudeAgentSdkRuntime: {
    create: runtimeFactoryMocks.claudeCreate
  }
}));

vi.mock("../swarm/codex-agent-runtime.js", () => ({
  CodexAgentRuntime: {
    create: runtimeFactoryMocks.codexCreate
  }
}));

import { RuntimeFactory } from "../swarm/runtime-factory.js";

function createDescriptor(provider: AgentDescriptor["model"]["provider"]): AgentDescriptor {
  const now = "2026-01-01T00:00:00.000Z";

  return {
    agentId: "worker-a",
    displayName: "Worker A",
    role: "worker",
    managerId: "manager",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    cwd: "/tmp/project",
    model: {
      provider,
      modelId: provider === "openai-codex-app-server" ? "default" : "claude-opus-4-6",
      thinkingLevel: "xhigh"
    },
    sessionFile: "/tmp/project/sessions/worker-a.jsonl"
  };
}

function createRuntimeStub(descriptor: AgentDescriptor) {
  return {
    descriptor,
    getStatus: () => descriptor.status,
    getPendingCount: () => 0,
    getContextUsage: () => undefined,
    sendMessage: vi.fn(),
    compact: vi.fn(),
    stopInFlight: vi.fn(),
    terminate: vi.fn(),
    getCustomEntries: () => [],
    appendCustomEntry: vi.fn()
  };
}

function createFactory() {
  const config = {
    paths: {
      dataDir: "/tmp/swarm-data",
      authFile: "/tmp/swarm-data/auth/auth.json"
    }
  } as SwarmConfig;

  return new RuntimeFactory({
    host: {
      listAgents: () => [],
      sendMessage: async () => {
        throw new Error("not used in this test");
      },
      spawnAgent: async () => {
        throw new Error("not used in this test");
      },
      publishToUser: async () => {
        throw new Error("not used in this test");
      }
    } as any,
    config,
    now: () => "2026-01-01T00:00:00.000Z",
    logDebug: () => {},
    getMemoryRuntimeResources: async () => ({
      memoryContextFile: {
        path: "/tmp/swarm-data/memory/manager.md",
        content: "Persist this context."
      },
      additionalSkillPaths: []
    }),
    getSwarmContextFiles: async () => [
      {
        path: "/repo/.swarm/context.md",
        content: "Repository policy context."
      }
    ],
    mergeRuntimeContextFiles: (baseAgentsFiles) => baseAgentsFiles,
    callbacks: {
      onStatusChange: async () => {},
      onSessionEvent: async () => {},
      onAgentEnd: async () => {},
      onRuntimeError: async () => {}
    }
  });
}

describe("RuntimeFactory", () => {
  beforeEach(() => {
    runtimeFactoryMocks.buildSwarmTools.mockReset();
    runtimeFactoryMocks.claudeCreate.mockReset();
    runtimeFactoryMocks.codexCreate.mockReset();

    runtimeFactoryMocks.buildSwarmTools.mockReturnValue([]);
    runtimeFactoryMocks.claudeCreate.mockImplementation(async ({ descriptor }: { descriptor: AgentDescriptor }) =>
      createRuntimeStub(descriptor)
    );
    runtimeFactoryMocks.codexCreate.mockImplementation(async ({ descriptor }: { descriptor: AgentDescriptor }) =>
      createRuntimeStub(descriptor)
    );
  });

  it("dispatches claude-agent-sdk descriptors to ClaudeAgentSdkRuntime with expected options", async () => {
    const factory = createFactory();
    const descriptor = createDescriptor("claude-agent-sdk");

    await factory.createRuntimeForDescriptor(descriptor, "Base system prompt");

    expect(runtimeFactoryMocks.claudeCreate).toHaveBeenCalledTimes(1);
    expect(runtimeFactoryMocks.codexCreate).not.toHaveBeenCalled();

    const call = runtimeFactoryMocks.claudeCreate.mock.calls[0]?.[0] as {
      authFile: string;
      runtimeEnv: Record<string, string>;
      systemPrompt: string;
    };
    expect(call.authFile).toBe("/tmp/swarm-data/auth/auth.json");
    expect(call.runtimeEnv).toMatchObject({
      SWARM_DATA_DIR: "/tmp/swarm-data",
      SWARM_MEMORY_FILE: "/tmp/swarm-data/memory/manager.md"
    });
    expect(call.systemPrompt).toContain("Base system prompt");
    expect(call.systemPrompt).toContain("Repository policy context.");
    expect(call.systemPrompt).toContain("Persist this context.");
  });

  it("keeps codex-app-server descriptors on CodexAgentRuntime", async () => {
    const factory = createFactory();
    const descriptor = createDescriptor("openai-codex-app-server");

    await factory.createRuntimeForDescriptor(descriptor, "Base system prompt");

    expect(runtimeFactoryMocks.codexCreate).toHaveBeenCalledTimes(1);
    expect(runtimeFactoryMocks.claudeCreate).not.toHaveBeenCalled();
  });
});
