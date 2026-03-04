import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { AgentDescriptor, SwarmConfig } from "../swarm/types.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  buildSwarmTools: vi.fn(),
  claudeCreate: vi.fn(),
  codexCreate: vi.fn(),
  readClaudeOutputStyleLenient: vi.fn()
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

vi.mock("../swarm/claude-output-style-settings.js", () => ({
  readClaudeOutputStyleLenient: runtimeFactoryMocks.readClaudeOutputStyleLenient
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
  const codexThinkingLevelToEffort = {
    off: "none",
    minimal: "minimal",
    low: "minimal",
    medium: "low",
    high: "medium",
    xhigh: "high"
  } as const;
  const claudeThinkingLevelToConfig = {
    off: { thinking: "disabled" },
    minimal: { thinking: "enabled", effort: "low" },
    low: { thinking: "enabled", effort: "low" },
    medium: { thinking: "enabled", effort: "medium" },
    high: { thinking: "enabled", effort: "high" },
    xhigh: { thinking: "enabled", effort: "max" }
  } as const;

  const config = {
    paths: {
      dataDir: "/tmp/swarm-data",
      authFile: "/tmp/swarm-data/auth/auth.json"
    },
    providerThinkingLevelMappings: {
      codexAppServer: codexThinkingLevelToEffort,
      claudeAgentSdk: claudeThinkingLevelToConfig
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
    getSwarmContextFiles: async () => [
      {
        path: "/repo/.swarm/context.md",
        content: "Repository policy context."
      }
    ],
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
    runtimeFactoryMocks.readClaudeOutputStyleLenient.mockReset();

    runtimeFactoryMocks.buildSwarmTools.mockReturnValue([]);
    runtimeFactoryMocks.claudeCreate.mockImplementation(async ({ descriptor }: { descriptor: AgentDescriptor }) =>
      createRuntimeStub(descriptor)
    );
    runtimeFactoryMocks.codexCreate.mockImplementation(async ({ descriptor }: { descriptor: AgentDescriptor }) =>
      createRuntimeStub(descriptor)
    );
    runtimeFactoryMocks.readClaudeOutputStyleLenient.mockResolvedValue({
      settingsPath: "/tmp/project/.claude/settings.local.json",
      outputStyle: null
    });
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
      thinkingLevelToConfig: Record<string, { thinking: string; effort?: string }>;
      settingsPolicy: {
        primarySources: string[];
        fallbackSources: string[];
        enableFallbackOnReadError: boolean;
      };
    };
    expect(call.authFile).toBe("/tmp/swarm-data/auth/auth.json");
    expect(call.runtimeEnv).toMatchObject({
      SWARM_DATA_DIR: "/tmp/swarm-data",
      CLAUDE_CONFIG_DIR: "/tmp/swarm-data/claude-code"
    });
    expect(call.systemPrompt).toContain("Base system prompt");
    expect(call.systemPrompt).toContain("Repository policy context.");
    expect(call.thinkingLevelToConfig).toEqual({
      off: { thinking: "disabled" },
      minimal: { thinking: "enabled", effort: "low" },
      low: { thinking: "enabled", effort: "low" },
      medium: { thinking: "enabled", effort: "medium" },
      high: { thinking: "enabled", effort: "high" },
      xhigh: { thinking: "enabled", effort: "max" }
    });
    expect(call.settingsPolicy).toEqual({
      primarySources: ["project"],
      fallbackSources: [],
      enableFallbackOnReadError: true
    });
  });

  it("keeps codex-app-server descriptors on CodexAgentRuntime", async () => {
    const factory = createFactory();
    const descriptor = createDescriptor("openai-codex-app-server");

    await factory.createRuntimeForDescriptor(descriptor, "Base system prompt");

    expect(runtimeFactoryMocks.codexCreate).toHaveBeenCalledTimes(1);
    expect(runtimeFactoryMocks.claudeCreate).not.toHaveBeenCalled();

    const call = runtimeFactoryMocks.codexCreate.mock.calls[0]?.[0] as {
      thinkingLevelToEffort: Record<string, string>;
    };
    expect(call.thinkingLevelToEffort).toEqual({
      off: "none",
      minimal: "minimal",
      low: "minimal",
      medium: "low",
      high: "medium",
      xhigh: "high"
    });
  });

  it("suppresses manager base prompt for claude runtime when outputStyle is selected", async () => {
    runtimeFactoryMocks.readClaudeOutputStyleLenient.mockResolvedValue({
      settingsPath: "/tmp/project/.claude/settings.local.json",
      outputStyle: "concise"
    });

    const factory = createFactory();
    const descriptor = {
      ...createDescriptor("claude-agent-sdk"),
      role: "manager" as const,
      managerId: "manager"
    };

    await factory.createRuntimeForDescriptor(descriptor, "Manager base system prompt");

    const call = runtimeFactoryMocks.claudeCreate.mock.calls[0]?.[0] as {
      systemPrompt: string;
    };
    expect(runtimeFactoryMocks.readClaudeOutputStyleLenient).toHaveBeenCalledWith("/tmp/project");
    expect(call.systemPrompt).not.toContain("Manager base system prompt");
    expect(call.systemPrompt).toContain("Repository policy context.");
  });

  it("suppresses manager base prompt when outputStyle exists only in .claude/settings.json", async () => {
    const claudeSettingsModule = await vi.importActual<typeof import("../swarm/claude-output-style-settings.js")>(
      "../swarm/claude-output-style-settings.js"
    );
    runtimeFactoryMocks.readClaudeOutputStyleLenient.mockImplementation(
      claudeSettingsModule.readClaudeOutputStyleLenient
    );

    const projectRoot = await mkdtemp(join(tmpdir(), "runtime-factory-claude-style-"));
    try {
      await mkdir(join(projectRoot, ".claude"), { recursive: true });
      await writeFile(
        join(projectRoot, ".claude", "settings.json"),
        `${JSON.stringify({ outputStyle: "technical" }, null, 2)}\n`,
        "utf8"
      );

      const factory = createFactory();
      const descriptor = {
        ...createDescriptor("claude-agent-sdk"),
        role: "manager" as const,
        managerId: "manager",
        cwd: projectRoot
      };

      await factory.createRuntimeForDescriptor(descriptor, "Manager base system prompt");

      const call = runtimeFactoryMocks.claudeCreate.mock.calls[0]?.[0] as {
        systemPrompt: string;
      };
      expect(runtimeFactoryMocks.readClaudeOutputStyleLenient).toHaveBeenCalledWith(projectRoot);
      expect(call.systemPrompt).not.toContain("Manager base system prompt");
      expect(call.systemPrompt).toContain("Repository policy context.");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("honors .claude/settings.local.json precedence over .claude/settings.json for outputStyle selection", async () => {
    const claudeSettingsModule = await vi.importActual<typeof import("../swarm/claude-output-style-settings.js")>(
      "../swarm/claude-output-style-settings.js"
    );
    runtimeFactoryMocks.readClaudeOutputStyleLenient.mockImplementation(
      claudeSettingsModule.readClaudeOutputStyleLenient
    );

    const projectRoot = await mkdtemp(join(tmpdir(), "runtime-factory-claude-style-local-"));
    try {
      await mkdir(join(projectRoot, ".claude"), { recursive: true });
      await writeFile(
        join(projectRoot, ".claude", "settings.json"),
        `${JSON.stringify({ outputStyle: "technical" }, null, 2)}\n`,
        "utf8"
      );
      await writeFile(
        join(projectRoot, ".claude", "settings.local.json"),
        `${JSON.stringify({ outputStyle: null }, null, 2)}\n`,
        "utf8"
      );

      const factory = createFactory();
      const descriptor = {
        ...createDescriptor("claude-agent-sdk"),
        role: "manager" as const,
        managerId: "manager",
        cwd: projectRoot
      };

      await factory.createRuntimeForDescriptor(descriptor, "Manager base system prompt");

      const call = runtimeFactoryMocks.claudeCreate.mock.calls[0]?.[0] as {
        systemPrompt: string;
      };
      expect(runtimeFactoryMocks.readClaudeOutputStyleLenient).toHaveBeenCalledWith(projectRoot);
      expect(call.systemPrompt).toContain("Manager base system prompt");
      expect(call.systemPrompt).toContain("Repository policy context.");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
