import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentDescriptor, AgentsStoreFile, SwarmConfig } from "./types.js";

const CLAUDE_RUNTIME_STATE_FILE_SUFFIX = ".claude-runtime-state.json";
const CODEX_RUNTIME_STATE_FILE_SUFFIX = ".codex-runtime-state.json";

interface PersistenceServiceDependencies {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  sortedDescriptors: () => AgentDescriptor[];
  validateAgentDescriptor: (value: unknown) => AgentDescriptor | string;
  extractDescriptorAgentId: (value: unknown) => string | undefined;
  logDebug: (message: string, details?: unknown) => void;
}

export class PersistenceService {
  constructor(private readonly deps: PersistenceServiceDependencies) {}

  async ensureDirectories(): Promise<void> {
    const dirs = [
      this.deps.config.paths.dataDir,
      this.deps.config.paths.swarmDir,
      this.deps.config.paths.sessionsDir,
      this.deps.config.paths.uploadsDir,
      this.deps.config.paths.authDir,
      this.deps.config.paths.agentDir,
      this.deps.config.paths.managerAgentDir
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  async deleteManagerSessionFile(sessionFile: string): Promise<void> {
    await this.deleteFileIfExists(sessionFile);
    await this.deleteFileIfExists(`${sessionFile}${CLAUDE_RUNTIME_STATE_FILE_SUFFIX}`);
    await this.deleteFileIfExists(`${sessionFile}${CODEX_RUNTIME_STATE_FILE_SUFFIX}`);
  }

  async loadStore(): Promise<AgentsStoreFile> {
    try {
      const raw = await readFile(this.deps.config.paths.agentsStoreFile, "utf8");
      const parsed = JSON.parse(raw) as AgentsStoreFile;
      if (!Array.isArray(parsed.agents)) {
        return { agents: [] };
      }

      const validAgents: AgentDescriptor[] = [];
      for (const [index, candidate] of parsed.agents.entries()) {
        const validated = this.deps.validateAgentDescriptor(candidate);
        if (typeof validated === "string") {
          const maybeAgentId = this.deps.extractDescriptorAgentId(candidate);
          const descriptorHint = maybeAgentId ? `agentId=${maybeAgentId}` : `index=${index}`;
          console.warn(
            `[swarm] Skipping invalid descriptor (${descriptorHint}) in ${this.deps.config.paths.agentsStoreFile}: ${validated}`
          );
          continue;
        }

        validAgents.push(validated);
      }

      return {
        agents: validAgents
      };
    } catch {
      return { agents: [] };
    }
  }

  async saveStore(): Promise<void> {
    const payload: AgentsStoreFile = {
      agents: this.deps.sortedDescriptors()
    };

    const target = this.deps.config.paths.agentsStoreFile;
    const tmp = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }

  private async deleteFileIfExists(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (isEnoentError(error)) {
        return;
      }
      throw error;
    }
  }
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
