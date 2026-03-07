import {
  THINKING_LEVELS,
  type ManagerModelCatalogModel,
  type ManagerModelCatalogProvider,
  type ManagerModelCatalogResponse,
  type ThinkingLevel
} from "@nexus/protocol";
import { CodexJsonRpcClient } from "./codex-jsonrpc-client.js";

const DEFAULT_CODEX_PROBE_TIMEOUT_MS = 4_000;
const DEFAULT_CODEX_PROBE_TTL_MS = 60_000;
const CODEX_PROVIDER_LABEL = "OpenAI Codex App Server";
const CODEX_PROVIDER_ID = "openai-codex-app-server";
const CODEX_APP_SERVER_MODEL_LIST_METHOD = "model/list";

const CODEX_EFFORT_TO_THINKING: Record<CodexReasoningEffort, ThinkingLevel> = {
  none: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh"
};

const THINKING_LEVEL_RANK: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5
};

type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface CachedCodexModels {
  fetchedAtMs: number;
  models: ManagerModelCatalogModel[];
  warning?: string;
}

export interface ManagerModelCatalogServiceOptions {
  now?: () => Date;
  codexProbeTtlMs?: number;
  codexProbeTimeoutMs?: number;
  probeCodexModelListData?: (timeoutMs: number) => Promise<unknown>;
}

export class ManagerModelCatalogService {
  private readonly now: () => Date;
  private readonly codexProbeTtlMs: number;
  private readonly codexProbeTimeoutMs: number;
  private readonly probeCodexModelListData: (timeoutMs: number) => Promise<unknown>;

  private cachedCodexModels: CachedCodexModels | undefined;
  private codexProbeInFlight: Promise<{ models: ManagerModelCatalogModel[]; warning?: string }> | undefined;

  constructor(options?: ManagerModelCatalogServiceOptions) {
    this.now = options?.now ?? (() => new Date());
    this.codexProbeTtlMs = options?.codexProbeTtlMs ?? DEFAULT_CODEX_PROBE_TTL_MS;
    this.codexProbeTimeoutMs = options?.codexProbeTimeoutMs ?? DEFAULT_CODEX_PROBE_TIMEOUT_MS;
    this.probeCodexModelListData = options?.probeCodexModelListData ?? probeCodexModelListData;
  }

  async getCatalog(): Promise<ManagerModelCatalogResponse> {
    const warnings: string[] = [];
    const codexProviderModels = await this.getCodexAppServerModels();
    if (codexProviderModels.warning) {
      warnings.push(codexProviderModels.warning);
    }

    const providers: ManagerModelCatalogProvider[] = [
      {
        provider: "claude-agent-sdk",
        providerLabel: "Claude Agent SDK",
        surfaces: ["create_manager", "manager_settings", "spawn_default"],
        models: buildClaudeAgentSdkModels()
      },
      {
        provider: CODEX_PROVIDER_ID,
        providerLabel: CODEX_PROVIDER_LABEL,
        surfaces: ["create_manager", "manager_settings", "spawn_default"],
        models: codexProviderModels.models
      }
    ];

    const response: ManagerModelCatalogResponse = {
      fetchedAt: this.now().toISOString(),
      providers
    };

    if (warnings.length > 0) {
      response.warnings = Array.from(new Set(warnings));
    }

    return response;
  }

  private async getCodexAppServerModels(): Promise<{ models: ManagerModelCatalogModel[]; warning?: string }> {
    const nowMs = this.now().getTime();
    const cached = this.cachedCodexModels;

    if (cached && nowMs - cached.fetchedAtMs < this.codexProbeTtlMs) {
      return {
        models: cached.models.map(cloneCatalogModel),
        warning: cached.warning
      };
    }

    if (!this.codexProbeInFlight) {
      this.codexProbeInFlight = this.refreshCodexAppServerModels(nowMs);
    }

    return await this.codexProbeInFlight;
  }

  private async refreshCodexAppServerModels(
    nowMs: number
  ): Promise<{ models: ManagerModelCatalogModel[]; warning?: string }> {
    try {
      const rawData = await this.probeCodexModelListData(this.codexProbeTimeoutMs);
      const models = parseCodexModelListData(rawData);
      if (models.length === 0) {
        const warning = "Codex model probe returned no models; using fallback model catalog.";
        const fallbackModels = buildCodexFallbackModels();
        this.cachedCodexModels = {
          fetchedAtMs: nowMs,
          models: fallbackModels,
          warning
        };
        return {
          models: fallbackModels.map(cloneCatalogModel),
          warning
        };
      }

      this.cachedCodexModels = {
        fetchedAtMs: nowMs,
        models,
        warning: undefined
      };

      return {
        models: models.map(cloneCatalogModel)
      };
    } catch (error) {
      const cached = this.cachedCodexModels;
      const errorMessage = toErrorMessage(error);

      if (cached) {
        return {
          models: cached.models.map(cloneCatalogModel),
          warning: `Codex model probe failed; using stale cached catalog: ${errorMessage}`
        };
      }

      const warning = `Codex model probe failed; using fallback model catalog: ${errorMessage}`;
      const fallbackModels = buildCodexFallbackModels();
      this.cachedCodexModels = {
        fetchedAtMs: nowMs,
        models: fallbackModels,
        warning
      };
      return {
        models: fallbackModels.map(cloneCatalogModel),
        warning
      };
    } finally {
      this.codexProbeInFlight = undefined;
    }
  }
}

export function parseCodexModelListData(data: unknown): ManagerModelCatalogModel[] {
  const records = resolveCodexModelListEntries(data);
  const modelsById = new Map<string, ManagerModelCatalogModel>();

  for (const rawRecord of records) {
    if (!isRecord(rawRecord)) {
      continue;
    }

    const modelId =
      normalizeModelId(rawRecord.id) ??
      normalizeModelId(rawRecord.model) ??
      normalizeModelId(rawRecord.name);
    if (!modelId) {
      continue;
    }

    const normalizedModelId = modelId.toLowerCase();
    if (modelsById.has(normalizedModelId)) {
      continue;
    }

    const defaultEffort = parseCodexReasoningEffort(
      rawRecord.defaultReasoningEffort ?? rawRecord.default_reasoning_effort
    );
    const supportedEfforts = parseSupportedCodexEfforts(
      rawRecord.supportedReasoningEfforts ?? rawRecord.supported_reasoning_efforts,
      defaultEffort
    );
    const allowedThinkingLevels = mapCodexEffortsToThinkingLevels(supportedEfforts);
    if (allowedThinkingLevels.length === 0) {
      continue;
    }

    const defaultThinkingLevel = resolveCodexDefaultThinkingLevel(allowedThinkingLevels, defaultEffort);
    const modelLabel = normalizeOptionalString(rawRecord.name) ?? modelId;

    modelsById.set(normalizedModelId, {
      modelId,
      modelLabel,
      allowedThinkingLevels,
      defaultThinkingLevel
    });
  }

  return sortCatalogModels(Array.from(modelsById.values()));
}

function resolveCodexModelListEntries(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }

  if (!isRecord(data)) {
    return [];
  }

  const nestedData = data.data;
  return Array.isArray(nestedData) ? nestedData : [];
}

function mapCodexEffortsToThinkingLevels(efforts: CodexReasoningEffort[]): ThinkingLevel[] {
  if (efforts.length === 0) {
    return [];
  }

  const deduped = new Set<ThinkingLevel>();
  for (const effort of efforts) {
    deduped.add(CODEX_EFFORT_TO_THINKING[effort]);
  }

  return THINKING_LEVELS.filter((thinkingLevel) => deduped.has(thinkingLevel));
}

function resolveCodexDefaultThinkingLevel(
  allowedThinkingLevels: ThinkingLevel[],
  defaultEffort: CodexReasoningEffort | undefined
): ThinkingLevel {
  const mappedDefault = defaultEffort ? CODEX_EFFORT_TO_THINKING[defaultEffort] : undefined;
  if (mappedDefault && allowedThinkingLevels.includes(mappedDefault)) {
    return mappedDefault;
  }

  let highestThinkingLevel = allowedThinkingLevels[0];
  for (const thinkingLevel of allowedThinkingLevels) {
    if (!highestThinkingLevel || THINKING_LEVEL_RANK[thinkingLevel] > THINKING_LEVEL_RANK[highestThinkingLevel]) {
      highestThinkingLevel = thinkingLevel;
    }
  }

  return highestThinkingLevel ?? "off";
}

function parseSupportedCodexEfforts(
  value: unknown,
  defaultEffort: CodexReasoningEffort | undefined
): CodexReasoningEffort[] {
  const efforts: CodexReasoningEffort[] = [];

  if (Array.isArray(value)) {
    for (const entry of value) {
      const direct = parseCodexReasoningEffort(entry);
      if (direct) {
        efforts.push(direct);
        continue;
      }

      if (!isRecord(entry)) {
        continue;
      }

      const nested = parseCodexReasoningEffort(entry.reasoningEffort ?? entry.reasoning_effort);
      if (nested) {
        efforts.push(nested);
      }
    }
  }

  if (efforts.length === 0 && defaultEffort) {
    efforts.push(defaultEffort);
  }

  return Array.from(new Set(efforts));
}

function parseCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "none":
      return "none";
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return undefined;
  }
}

function buildClaudeAgentSdkModels(): ManagerModelCatalogModel[] {
  return [
    {
      modelId: "claude-opus-4-6",
      modelLabel: "Claude Opus 4.6",
      allowedThinkingLevels: [...THINKING_LEVELS],
      defaultThinkingLevel: "xhigh"
    }
  ];
}

function buildCodexFallbackModels(): ManagerModelCatalogModel[] {
  return [
    {
      modelId: "default",
      modelLabel: "default",
      allowedThinkingLevels: [...THINKING_LEVELS],
      defaultThinkingLevel: "xhigh"
    }
  ];
}

function sortCatalogModels(models: ManagerModelCatalogModel[]): ManagerModelCatalogModel[] {
  return [...models].sort((left, right) => left.modelId.localeCompare(right.modelId, undefined, { sensitivity: "base" }));
}

function cloneCatalogModel(model: ManagerModelCatalogModel): ManagerModelCatalogModel {
  return {
    modelId: model.modelId,
    modelLabel: model.modelLabel,
    allowedThinkingLevels: [...model.allowedThinkingLevels],
    defaultThinkingLevel: model.defaultThinkingLevel
  };
}

async function probeCodexModelListData(timeoutMs: number): Promise<unknown> {
  const command = process.env.CODEX_BIN?.trim() || "codex";
  const rpc = new CodexJsonRpcClient({
    command,
    args: ["app-server", "--listen", "stdio://"],
    spawnOptions: {
      cwd: process.cwd(),
      env: { ...process.env }
    },
    onStderr: () => {
      // Intentionally ignored.
    }
  });

  try {
    await rpc.request(
      "initialize",
      {
        clientInfo: {
          name: "swarm",
          title: "Swarm",
          version: "1.0.0"
        },
        capabilities: {
          experimentalApi: true
        }
      },
      timeoutMs
    );
    rpc.notify("initialized");

    const result = await rpc.request<{ data?: unknown }>(
      CODEX_APP_SERVER_MODEL_LIST_METHOD,
      {},
      timeoutMs
    );
    return result?.data;
  } finally {
    rpc.dispose();
  }
}

function normalizeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
