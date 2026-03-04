import type { ThinkingLevel } from './shared-types.js'

export type ManagerModelSurface = 'create_manager' | 'manager_settings' | 'spawn_default'

export interface ManagerModelCatalogModel {
  modelId: string
  modelLabel: string
  allowedThinkingLevels: ThinkingLevel[]
  defaultThinkingLevel: ThinkingLevel
}

export interface ManagerModelCatalogProvider {
  provider: string
  providerLabel: string
  surfaces: ManagerModelSurface[]
  models: ManagerModelCatalogModel[]
}

export interface ManagerModelCatalogResponse {
  fetchedAt: string
  providers: ManagerModelCatalogProvider[]
  warnings?: string[]
}
