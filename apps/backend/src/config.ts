import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { normalizeAllowlistRoots } from "./swarm/cwd-policy.js";
import { getMemoryDirPath } from "./swarm/memory-paths.js";
import {
  DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS,
  DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS
} from "./swarm/model-preset-config.js";
import type {
  ProviderThinkingLevelMappings,
  SwarmConfig,
  SwarmModelPresetDefinitions
} from "./swarm/types.js";

export function createConfig(): SwarmConfig {
  const rootDir = detectRootDir();
  const dataDir = resolve(homedir(), ".nexus");
  const managerId = undefined;
  const swarmDir = resolve(dataDir, "swarm");
  const sessionsDir = resolve(dataDir, "sessions");
  const uploadsDir = resolve(dataDir, "uploads");
  const authDir = resolve(dataDir, "auth");
  const authFile = resolve(authDir, "auth.json");
  migrateLegacyPiAuthFileIfNeeded(authFile);
  const agentDir = resolve(dataDir, "agent");
  const managerAgentDir = resolve(agentDir, "manager");
  const repoArchetypesDir = resolve(rootDir, ".swarm", "archetypes");
  const memoryDir = getMemoryDirPath(dataDir);
  const memoryFile = undefined;
  const repoMemorySkillFile = resolve(rootDir, ".swarm", "skills", "memory", "SKILL.md");
  const secretsFile = resolve(dataDir, "secrets.json");
  const defaultCwd = rootDir;

  const cwdAllowlistRoots = normalizeAllowlistRoots([
    rootDir,
    resolve(homedir(), "worktrees")
  ]);
  const modelPresetDefinitions = cloneModelPresetDefinitions(DEFAULT_SWARM_MODEL_PRESET_DEFINITIONS);
  const providerThinkingLevelMappings = cloneProviderThinkingLevelMappings(
    DEFAULT_PROVIDER_THINKING_LEVEL_MAPPINGS
  );
  const defaultModel = { ...modelPresetDefinitions["pi-codex"].descriptor };

  return {
    host: process.env.NEXUS_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.NEXUS_PORT ?? "47187", 10),
    debug: true,
    allowNonManagerSubscriptions: true,
    managerId,
    managerDisplayName: "Manager",
    defaultModel,
    modelPresetDefinitions,
    providerThinkingLevelMappings,
    defaultCwd,
    cwdAllowlistRoots,
    paths: {
      rootDir,
      dataDir,
      swarmDir,
      sessionsDir,
      uploadsDir,
      authDir,
      authFile,
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryDir,
      memoryFile,
      repoMemorySkillFile,
      agentsStoreFile: resolve(swarmDir, "agents.json"),
      secretsFile,
      schedulesFile: undefined
    }
  };
}

function cloneModelPresetDefinitions(
  definitions: SwarmModelPresetDefinitions
): SwarmModelPresetDefinitions {
  return {
    "pi-codex": {
      descriptor: { ...definitions["pi-codex"].descriptor },
      aliases: definitions["pi-codex"].aliases?.map((alias) => ({ ...alias }))
    },
    "pi-opus": {
      descriptor: { ...definitions["pi-opus"].descriptor },
      aliases: definitions["pi-opus"].aliases?.map((alias) => ({ ...alias }))
    },
    "codex-app": {
      descriptor: { ...definitions["codex-app"].descriptor },
      aliases: definitions["codex-app"].aliases?.map((alias) => ({ ...alias }))
    },
    "claude-agent-sdk": {
      descriptor: { ...definitions["claude-agent-sdk"].descriptor },
      aliases: definitions["claude-agent-sdk"].aliases?.map((alias) => ({ ...alias }))
    }
  };
}

function cloneProviderThinkingLevelMappings(
  mappings: ProviderThinkingLevelMappings
): ProviderThinkingLevelMappings {
  return {
    codexAppServer: { ...mappings.codexAppServer },
    claudeAgentSdk: {
      off: { ...mappings.claudeAgentSdk.off },
      minimal: { ...mappings.claudeAgentSdk.minimal },
      low: { ...mappings.claudeAgentSdk.low },
      medium: { ...mappings.claudeAgentSdk.medium },
      high: { ...mappings.claudeAgentSdk.high },
      xhigh: { ...mappings.claudeAgentSdk.xhigh }
    },
    piRuntime: { ...mappings.piRuntime }
  };
}

function detectRootDir(): string {
  let current = resolve(process.cwd());

  while (true) {
    if (isSwarmRepoRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return resolve(process.cwd(), "../..");
}

function isSwarmRepoRoot(path: string): boolean {
  return existsSync(resolve(path, "pnpm-workspace.yaml")) && existsSync(resolve(path, "apps"));
}

function migrateLegacyPiAuthFileIfNeeded(targetAuthFile: string): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return;
  }

  const legacyPiAuthFile = resolve(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(targetAuthFile) || !existsSync(legacyPiAuthFile)) {
    return;
  }

  try {
    mkdirSync(dirname(targetAuthFile), { recursive: true });
    copyFileSync(legacyPiAuthFile, targetAuthFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[swarm] Failed to migrate legacy Pi auth file: ${message}`);
  }
}
