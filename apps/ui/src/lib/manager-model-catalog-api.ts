import type {
  ManagerModelCatalogResponse,
  ThinkingLevel,
} from '@nexus/protocol'
import { THINKING_LEVELS } from '@nexus/protocol'
import { resolveApiEndpoint } from './api-endpoint'

export interface CreateManagerCatalogModel {
  modelId: string
  modelLabel: string
  allowedThinkingLevels: ThinkingLevel[]
  defaultThinkingLevel: ThinkingLevel
}

export interface CreateManagerCatalogProvider {
  provider: string
  providerLabel: string
  models: CreateManagerCatalogModel[]
}

export interface CreateManagerCatalog {
  providers: CreateManagerCatalogProvider[]
  warnings: string[]
}

export interface CreateManagerSelection {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
}

export interface CreateManagerSelectOption {
  value: string
  label: string
}

const MANAGER_CREATE_SURFACE = 'create_manager'
const MANAGER_SETTINGS_SURFACE = 'manager_settings'
const SPAWN_DEFAULT_SURFACE = 'spawn_default'
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS)

export function createEmptyCreateManagerCatalog(): CreateManagerCatalog {
  return {
    providers: [],
    warnings: [],
  }
}

export async function fetchManagerModelCatalog(wsUrl: string): Promise<ManagerModelCatalogResponse> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/models/manager-catalog')
  const response = await fetch(endpoint)
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }

  const payload = (await response.json().catch(() => null)) as unknown
  if (!isRecord(payload) || !Array.isArray(payload.providers)) {
    throw new Error('Invalid manager model catalog response.')
  }

  return payload as unknown as ManagerModelCatalogResponse
}

export function toCreateManagerCatalog(response: ManagerModelCatalogResponse): CreateManagerCatalog {
  return toCatalogForSurface(response, MANAGER_CREATE_SURFACE)
}

export function toManagerSettingsCatalog(response: ManagerModelCatalogResponse): CreateManagerCatalog {
  return toCatalogForSurface(response, MANAGER_SETTINGS_SURFACE)
}

export function toSpawnDefaultCatalog(response: ManagerModelCatalogResponse): CreateManagerCatalog {
  return toCatalogForSurface(response, SPAWN_DEFAULT_SURFACE)
}

export function getCatalogProviderLabel(
  catalog: CreateManagerCatalog,
  provider: string,
): string {
  return findProvider(catalog, provider)?.providerLabel ?? provider
}

export function getManagerSettingsProviderOptions(
  catalog: CreateManagerCatalog,
): CreateManagerSelectOption[] {
  return getCatalogProviderOptions(catalog)
}

export function getManagerSettingsModelOptions(
  catalog: CreateManagerCatalog,
  provider: string,
): CreateManagerSelectOption[] {
  return getCatalogModelOptions(catalog, provider)
}

export function getManagerSettingsAllowedThinkingLevels(
  catalog: CreateManagerCatalog,
  provider: string,
  modelId: string,
): ThinkingLevel[] {
  return getCatalogAllowedThinkingLevels(catalog, provider, modelId)
}

export function getManagerSettingsDefaultModelForProvider(
  catalog: CreateManagerCatalog,
  provider: string,
): string | undefined {
  return getCatalogDefaultModelForProvider(catalog, provider)
}

export function getManagerSettingsDefaultThinkingLevel(
  catalog: CreateManagerCatalog,
  provider: string,
  modelId: string,
): ThinkingLevel | undefined {
  return getCatalogDefaultThinkingLevel(catalog, provider, modelId)
}

export function isSupportedManagerSettingsDescriptor(
  catalog: CreateManagerCatalog,
  provider: string,
  modelId: string,
): boolean {
  return isCatalogDescriptorSupported(catalog, provider, modelId)
}

function toCatalogForSurface(
  response: ManagerModelCatalogResponse,
  surface: string,
): CreateManagerCatalog {
  if (!response || !Array.isArray(response.providers)) {
    return createEmptyCreateManagerCatalog()
  }

  const providers: CreateManagerCatalogProvider[] = []
  const seenProviders = new Set<string>()

  for (const rawProvider of response.providers) {
    if (!isRecord(rawProvider)) {
      continue
    }

    if (!providerSupportsSurface(rawProvider.surfaces, surface)) {
      continue
    }

    const provider = normalizeRequiredString(rawProvider.provider)
    if (!provider) {
      continue
    }

    const providerKey = provider.toLowerCase()
    if (seenProviders.has(providerKey)) {
      continue
    }

    const providerLabel = normalizeOptionalString(rawProvider.providerLabel) ?? provider
    const models = normalizeProviderModels(rawProvider.models)
    if (models.length === 0) {
      continue
    }

    seenProviders.add(providerKey)
    providers.push({
      provider,
      providerLabel,
      models,
    })
  }

  return {
    providers,
    warnings: normalizeWarnings(response.warnings),
  }
}

export function getDefaultCatalogSelection(catalog: CreateManagerCatalog): CreateManagerSelection | null {
  const firstProvider = catalog.providers[0]
  const firstModel = firstProvider?.models[0]
  if (!firstProvider || !firstModel) {
    return null
  }

  return {
    provider: firstProvider.provider,
    modelId: firstModel.modelId,
    thinkingLevel: firstModel.defaultThinkingLevel,
  }
}

export function getCatalogProviderOptions(
  catalog: CreateManagerCatalog,
): CreateManagerSelectOption[] {
  return catalog.providers.map((provider) => ({
    value: provider.provider,
    label: provider.providerLabel,
  }))
}

export function getCatalogModelOptions(
  catalog: CreateManagerCatalog,
  provider: string,
): CreateManagerSelectOption[] {
  const providerEntry = findProvider(catalog, provider)
  if (!providerEntry) {
    return []
  }

  return providerEntry.models.map((model) => ({
    value: model.modelId,
    label: model.modelLabel,
  }))
}

export function getCatalogAllowedThinkingLevels(
  catalog: CreateManagerCatalog,
  provider: string,
  modelId: string,
): ThinkingLevel[] {
  const model = findModel(catalog, provider, modelId)
  if (!model) {
    return []
  }

  return [...model.allowedThinkingLevels]
}

export function getCatalogDefaultModelForProvider(
  catalog: CreateManagerCatalog,
  provider: string,
): string | undefined {
  return findProvider(catalog, provider)?.models[0]?.modelId
}

export function getCatalogDefaultThinkingLevel(
  catalog: CreateManagerCatalog,
  provider: string,
  modelId: string,
): ThinkingLevel | undefined {
  return findModel(catalog, provider, modelId)?.defaultThinkingLevel
}

export function isCatalogDescriptorSupported(
  catalog: CreateManagerCatalog,
  provider: string,
  modelId: string,
): boolean {
  return Boolean(findModel(catalog, provider, modelId))
}

function findProvider(catalog: CreateManagerCatalog, provider: string): CreateManagerCatalogProvider | undefined {
  const normalizedProvider = provider.trim().toLowerCase()
  if (!normalizedProvider) {
    return undefined
  }

  return catalog.providers.find(
    (entry) => entry.provider.trim().toLowerCase() === normalizedProvider,
  )
}

function findModel(
  catalog: CreateManagerCatalog,
  provider: string,
  modelId: string,
): CreateManagerCatalogModel | undefined {
  const providerEntry = findProvider(catalog, provider)
  if (!providerEntry) {
    return undefined
  }

  const normalizedModelId = modelId.trim().toLowerCase()
  if (!normalizedModelId) {
    return undefined
  }

  return providerEntry.models.find(
    (model) => model.modelId.trim().toLowerCase() === normalizedModelId,
  )
}

function normalizeProviderModels(value: unknown): CreateManagerCatalogModel[] {
  if (!Array.isArray(value)) {
    return []
  }

  const models: CreateManagerCatalogModel[] = []
  const seenModelIds = new Set<string>()

  for (const rawModel of value) {
    const model = normalizeModel(rawModel)
    if (!model) {
      continue
    }

    const modelKey = model.modelId.toLowerCase()
    if (seenModelIds.has(modelKey)) {
      continue
    }

    seenModelIds.add(modelKey)
    models.push(model)
  }

  return models
}

function normalizeModel(value: unknown): CreateManagerCatalogModel | null {
  if (!isRecord(value)) {
    return null
  }

  const modelId = normalizeRequiredString(value.modelId)
  if (!modelId) {
    return null
  }

  const allowedThinkingLevels = normalizeThinkingLevels(value.allowedThinkingLevels)
  if (allowedThinkingLevels.length === 0) {
    return null
  }

  const defaultThinkingLevelRaw = normalizeOptionalString(value.defaultThinkingLevel)
  const defaultThinkingLevel = defaultThinkingLevelRaw && THINKING_LEVEL_SET.has(defaultThinkingLevelRaw)
    ? (defaultThinkingLevelRaw as ThinkingLevel)
    : undefined

  return {
    modelId,
    modelLabel: normalizeOptionalString(value.modelLabel) ?? modelId,
    allowedThinkingLevels,
    defaultThinkingLevel:
      defaultThinkingLevel && allowedThinkingLevels.includes(defaultThinkingLevel)
        ? defaultThinkingLevel
        : allowedThinkingLevels[0],
  }
}

function normalizeThinkingLevels(value: unknown): ThinkingLevel[] {
  if (!Array.isArray(value)) {
    return []
  }

  const allowed = new Set<ThinkingLevel>()

  for (const rawThinkingLevel of value) {
    if (typeof rawThinkingLevel !== 'string') {
      continue
    }

    const normalized = rawThinkingLevel.trim()
    if (!normalized || !THINKING_LEVEL_SET.has(normalized)) {
      continue
    }

    allowed.add(normalized as ThinkingLevel)
  }

  return THINKING_LEVELS.filter((thinkingLevel) => allowed.has(thinkingLevel))
}

function providerSupportsSurface(value: unknown, surface: string): boolean {
  if (!Array.isArray(value)) {
    return false
  }

  const normalizedSurface = surface.trim().toLowerCase()

  return value.some(
    (entry) =>
      typeof entry === 'string' &&
      entry.trim().toLowerCase() === normalizedSurface,
  )
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const warnings = new Set<string>()
  for (const warning of value) {
    if (typeof warning !== 'string') {
      continue
    }
    const normalized = warning.trim()
    if (!normalized) {
      continue
    }
    warnings.add(normalized)
  }

  return [...warnings]
}

function normalizeRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

async function readApiError(response: Response): Promise<string> {
  const bodyText = await response.text().catch(() => '')
  const trimmedBodyText = bodyText.trim()

  if (trimmedBodyText.length > 0) {
    try {
      const payload = JSON.parse(trimmedBodyText) as { error?: unknown; message?: unknown }
      if (typeof payload.error === 'string' && payload.error.trim()) {
        return payload.error
      }
      if (typeof payload.message === 'string' && payload.message.trim()) {
        return payload.message
      }
    } catch {
      // Keep plain-text error body as-is.
    }

    return trimmedBodyText
  }

  return `Request failed (${response.status})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
