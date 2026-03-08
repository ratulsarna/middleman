import { useCallback, useState, type MutableRefObject } from 'react'
import type { AgentDescriptor, ThinkingLevel } from '@nexus/protocol'
import type { ManagerWsClient } from '@/lib/ws-client'
import {
  getCatalogAllowedThinkingLevels,
  getCatalogDefaultThinkingLevel,
  type CreateManagerCatalog,
} from '@/lib/manager-model-catalog-api'

export function useComposerModelActions(options: {
  activeAgent: AgentDescriptor | null
  catalog: CreateManagerCatalog | null
  clientRef: MutableRefObject<ManagerWsClient | null>
}): {
  handleModelChange: (modelId: string) => void
  handleThinkingLevelChange: (thinkingLevel: ThinkingLevel) => void
  isUpdating: boolean
  updateError: string | null
} {
  const { activeAgent, catalog, clientRef } = options
  const [isUpdating, setIsUpdating] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)

  const handleModelChange = useCallback(
    (modelId: string) => {
      const client = clientRef.current
      if (!client || !activeAgent || !catalog) return

      setUpdateError(null)
      setIsUpdating(true)

      // When model changes, check if current thinking level is still valid.
      const provider = activeAgent.model.provider
      const allowedLevels = getCatalogAllowedThinkingLevels(catalog, provider, modelId)
      const currentThinking = activeAgent.model.thinkingLevel

      const thinkingLevel =
        allowedLevels.includes(currentThinking)
          ? currentThinking
          : getCatalogDefaultThinkingLevel(catalog, provider, modelId) ?? currentThinking

      client
        .updateAgentModel({
          agentId: activeAgent.agentId,
          modelId,
          thinkingLevel,
        })
        .catch((error) => {
          setUpdateError(error instanceof Error ? error.message : 'Failed to update model')
        })
        .finally(() => {
          setIsUpdating(false)
        })
    },
    [activeAgent, catalog, clientRef],
  )

  const handleThinkingLevelChange = useCallback(
    (thinkingLevel: ThinkingLevel) => {
      const client = clientRef.current
      if (!client || !activeAgent) return

      setUpdateError(null)
      setIsUpdating(true)

      client
        .updateAgentModel({
          agentId: activeAgent.agentId,
          thinkingLevel,
        })
        .catch((error) => {
          setUpdateError(error instanceof Error ? error.message : 'Failed to update thinking level')
        })
        .finally(() => {
          setIsUpdating(false)
        })
    },
    [activeAgent, clientRef],
  )

  return {
    handleModelChange,
    handleThinkingLevelChange,
    isUpdating,
    updateError,
  }
}
