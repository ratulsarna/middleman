import { THINKING_LEVELS, type ThinkingLevel } from '@nexus/protocol'

const ALL_THINKING_LEVELS = [...THINKING_LEVELS] as ThinkingLevel[]

export interface ManagerSettingsCatalogEntry {
  provider: string
  providerLabel: string
  modelId: string
  modelLabel: string
  defaultThinkingLevel: ThinkingLevel
  allowedThinkingLevels: ThinkingLevel[]
}

export interface ManagerSettingsSelectOption {
  value: string
  label: string
}

export const MANAGER_SETTINGS_MODEL_CATALOG: ManagerSettingsCatalogEntry[] = [
  {
    provider: 'openai-codex',
    providerLabel: 'OpenAI Codex',
    modelId: 'gpt-5.3-codex',
    modelLabel: 'gpt-5.3-codex',
    defaultThinkingLevel: 'xhigh',
    allowedThinkingLevels: ALL_THINKING_LEVELS,
  },
  {
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    modelId: 'claude-opus-4-6',
    modelLabel: 'claude-opus-4-6',
    defaultThinkingLevel: 'xhigh',
    allowedThinkingLevels: ALL_THINKING_LEVELS,
  },
  {
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    modelId: 'claude-sonnet-4-5',
    modelLabel: 'claude-sonnet-4-5',
    defaultThinkingLevel: 'xhigh',
    allowedThinkingLevels: ALL_THINKING_LEVELS,
  },
  {
    provider: 'claude-agent-sdk',
    providerLabel: 'Claude Agent SDK',
    modelId: 'claude-opus-4-6',
    modelLabel: 'claude-opus-4-6',
    defaultThinkingLevel: 'xhigh',
    allowedThinkingLevels: ALL_THINKING_LEVELS,
  },
  {
    provider: 'openai-codex-app-server',
    providerLabel: 'OpenAI Codex App Server',
    modelId: 'default',
    modelLabel: 'default',
    defaultThinkingLevel: 'xhigh',
    allowedThinkingLevels: ALL_THINKING_LEVELS,
  },
]

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function findCatalogEntry(provider: string, modelId: string): ManagerSettingsCatalogEntry | undefined {
  const normalizedProvider = normalize(provider)
  const normalizedModelId = normalize(modelId)

  return MANAGER_SETTINGS_MODEL_CATALOG.find(
    (entry) =>
      normalize(entry.provider) === normalizedProvider &&
      normalize(entry.modelId) === normalizedModelId,
  )
}

export function isSupportedManagerSettingsDescriptor(provider: string, modelId: string): boolean {
  return Boolean(findCatalogEntry(provider, modelId))
}

export function getManagerSettingsProviderOptions(): ManagerSettingsSelectOption[] {
  const uniqueProviders = new Map<string, string>()

  for (const entry of MANAGER_SETTINGS_MODEL_CATALOG) {
    if (!uniqueProviders.has(entry.provider)) {
      uniqueProviders.set(entry.provider, entry.providerLabel)
    }
  }

  return [...uniqueProviders.entries()].map(([value, label]) => ({ value, label }))
}

export function getManagerSettingsModelOptions(provider: string): ManagerSettingsSelectOption[] {
  const normalizedProvider = normalize(provider)

  return MANAGER_SETTINGS_MODEL_CATALOG
    .filter((entry) => normalize(entry.provider) === normalizedProvider)
    .map((entry) => ({
      value: entry.modelId,
      label: entry.modelLabel,
    }))
}

export function getManagerSettingsAllowedThinkingLevels(provider: string, modelId: string): ThinkingLevel[] {
  const entry = findCatalogEntry(provider, modelId)
  if (!entry) {
    return []
  }

  return [...entry.allowedThinkingLevels]
}

export function getManagerSettingsDefaultModelForProvider(provider: string): string | undefined {
  const normalizedProvider = normalize(provider)
  const entry = MANAGER_SETTINGS_MODEL_CATALOG.find(
    (candidate) => normalize(candidate.provider) === normalizedProvider,
  )

  return entry?.modelId
}

export function getManagerSettingsDefaultThinkingLevel(
  provider: string,
  modelId: string,
): ThinkingLevel | undefined {
  return findCatalogEntry(provider, modelId)?.defaultThinkingLevel
}

export function getManagerSettingsProviderLabel(provider: string): string {
  const normalizedProvider = normalize(provider)
  const entry = MANAGER_SETTINGS_MODEL_CATALOG.find(
    (candidate) => normalize(candidate.provider) === normalizedProvider,
  )

  return entry?.providerLabel ?? provider
}
