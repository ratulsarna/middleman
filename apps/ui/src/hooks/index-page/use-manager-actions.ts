import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { chooseFallbackAgentId } from '@/lib/agent-hierarchy'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import {
  createEmptyCreateManagerCatalog,
  fetchManagerModelCatalog,
  getCatalogAllowedThinkingLevels,
  getCatalogDefaultModelForProvider,
  getCatalogDefaultThinkingLevel,
  getCatalogModelOptions,
  getCatalogProviderOptions,
  getDefaultCatalogSelection,
  isCatalogDescriptorSupported,
  toCreateManagerCatalog,
} from '@/lib/manager-model-catalog-api'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type {
  AgentDescriptor,
  ThinkingLevel,
} from '@nexus/protocol'
import type { AppRouteState } from './use-route-state'

interface UseManagerActionsOptions {
  wsUrl: string
  clientRef: MutableRefObject<ManagerWsClient | null>
  agents: AgentDescriptor[]
  activeAgent: AgentDescriptor | null
  activeAgentId: string | null
  isActiveManager: boolean
  navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
  setState: Dispatch<SetStateAction<ManagerWsState>>
  clearPendingResponseForAgent: (agentId: string) => void
}

const DEFAULT_CREATE_MANAGER_THINKING_LEVEL: ThinkingLevel = 'off'

export function useManagerActions({
  wsUrl,
  clientRef,
  agents,
  activeAgent,
  activeAgentId,
  isActiveManager,
  navigateToRoute,
  setState,
  clearPendingResponseForAgent,
}: UseManagerActionsOptions): {
  isCreateManagerDialogOpen: boolean
  newManagerName: string
  newManagerCwd: string
  newManagerProvider: string
  newManagerModelId: string
  newManagerThinkingLevel: ThinkingLevel
  isLoadingCreateManagerCatalog: boolean
  createManagerCatalogError: string | null
  isCreateManagerSubmitDisabled: boolean
  createManagerProviderOptions: Array<{ value: string; label: string }>
  createManagerModelOptions: Array<{ value: string; label: string }>
  createManagerThinkingOptions: Array<{ value: ThinkingLevel; label: string }>
  createManagerSelectionHint: string | null
  createManagerError: string | null
  browseError: string | null
  isCreatingManager: boolean
  isValidatingDirectory: boolean
  isPickingDirectory: boolean
  handleNewManagerNameChange: (value: string) => void
  handleNewManagerCwdChange: (value: string) => void
  handleNewManagerProviderChange: (value: string) => void
  handleNewManagerModelIdChange: (value: string) => void
  handleNewManagerThinkingLevelChange: (value: ThinkingLevel) => void
  handleOpenCreateManagerDialog: () => void
  handleCreateManagerDialogOpenChange: (open: boolean) => void
  handleBrowseDirectory: () => Promise<void>
  handleCreateManager: (event: FormEvent<HTMLFormElement>) => Promise<void>
  managerToDelete: AgentDescriptor | null
  deleteManagerError: string | null
  isDeletingManager: boolean
  handleRequestDeleteManager: (managerId: string) => void
  handleConfirmDeleteManager: () => Promise<void>
  handleCloseDeleteManagerDialog: () => void
  isCompactingManager: boolean
  handleCompactManager: (customInstructions?: string) => Promise<void>
  isStoppingAllAgents: boolean
  handleStopAllAgents: () => Promise<void>
} {
  const [isCreateManagerDialogOpen, setIsCreateManagerDialogOpen] = useState(false)
  const [newManagerName, setNewManagerName] = useState('')
  const [newManagerCwd, setNewManagerCwd] = useState('')
  const [createManagerCatalog, setCreateManagerCatalog] = useState(createEmptyCreateManagerCatalog)
  const [isLoadingCreateManagerCatalog, setIsLoadingCreateManagerCatalog] = useState(false)
  const [createManagerCatalogError, setCreateManagerCatalogError] = useState<string | null>(null)
  const [newManagerProvider, setNewManagerProvider] = useState('')
  const [newManagerModelId, setNewManagerModelId] = useState('')
  const [newManagerThinkingLevel, setNewManagerThinkingLevel] = useState<ThinkingLevel>(
    DEFAULT_CREATE_MANAGER_THINKING_LEVEL,
  )
  const [createManagerSelectionHint, setCreateManagerSelectionHint] = useState<string | null>(null)
  const [createManagerError, setCreateManagerError] = useState<string | null>(null)
  const [isCreatingManager, setIsCreatingManager] = useState(false)
  const [isValidatingDirectory, setIsValidatingDirectory] = useState(false)

  const [browseError, setBrowseError] = useState<string | null>(null)
  const [isPickingDirectory, setIsPickingDirectory] = useState(false)

  const [managerToDelete, setManagerToDelete] = useState<AgentDescriptor | null>(null)
  const [deleteManagerError, setDeleteManagerError] = useState<string | null>(null)
  const [isDeletingManager, setIsDeletingManager] = useState(false)

  const [isCompactingManager, setIsCompactingManager] = useState(false)
  const [isStoppingAllAgents, setIsStoppingAllAgents] = useState(false)
  const createManagerCatalogRequestIdRef = useRef(0)

  const handleNewManagerNameChange = useCallback((value: string) => {
    setNewManagerName(value)
  }, [])

  const handleNewManagerCwdChange = useCallback((value: string) => {
    setNewManagerCwd(value)
    setCreateManagerError(null)
  }, [])

  const createManagerProviderOptions = useMemo(
    () => getCatalogProviderOptions(createManagerCatalog),
    [createManagerCatalog],
  )

  const createManagerModelOptions = useMemo(
    () => getCatalogModelOptions(createManagerCatalog, newManagerProvider),
    [createManagerCatalog, newManagerProvider],
  )

  const createManagerThinkingOptions = useMemo(
    () =>
      getCatalogAllowedThinkingLevels(createManagerCatalog, newManagerProvider, newManagerModelId).map(
        (thinkingLevel) => ({
          value: thinkingLevel,
          label: thinkingLevel,
        }),
      ),
    [createManagerCatalog, newManagerProvider, newManagerModelId],
  )

  useEffect(() => {
    if (!isCreateManagerDialogOpen || isLoadingCreateManagerCatalog) {
      return
    }

    if (newManagerProvider) {
      return
    }

    const defaultSelection = getDefaultCatalogSelection(createManagerCatalog)
    if (!defaultSelection) {
      return
    }

    setNewManagerProvider(defaultSelection.provider)
    setNewManagerModelId(defaultSelection.modelId)
    setNewManagerThinkingLevel(defaultSelection.thinkingLevel)
  }, [
    createManagerCatalog,
    isCreateManagerDialogOpen,
    isLoadingCreateManagerCatalog,
    newManagerProvider,
  ])

  const isCreateManagerSelectionValid = useMemo(() => {
    if (!newManagerProvider || !newManagerModelId) {
      return false
    }

    if (!isCatalogDescriptorSupported(createManagerCatalog, newManagerProvider, newManagerModelId)) {
      return false
    }

    const allowedThinkingLevels = getCatalogAllowedThinkingLevels(
      createManagerCatalog,
      newManagerProvider,
      newManagerModelId,
    )
    return allowedThinkingLevels.includes(newManagerThinkingLevel)
  }, [createManagerCatalog, newManagerModelId, newManagerProvider, newManagerThinkingLevel])

  const isCreateManagerSubmitDisabled =
    isCreatingManager ||
    isPickingDirectory ||
    isLoadingCreateManagerCatalog ||
    !isCreateManagerSelectionValid

  const handleNewManagerProviderChange = useCallback((value: string) => {
    setNewManagerProvider(value)
    setCreateManagerError(null)
    setCreateManagerSelectionHint(null)

    const nextModelId =
      getCatalogDefaultModelForProvider(createManagerCatalog, value) ??
      getCatalogModelOptions(createManagerCatalog, value)[0]?.value ??
      ''
    const shouldResetModel = nextModelId !== newManagerModelId
    setNewManagerModelId(nextModelId)

    const nextThinkingOptions = getCatalogAllowedThinkingLevels(createManagerCatalog, value, nextModelId)
    const defaultThinkingLevel = getCatalogDefaultThinkingLevel(createManagerCatalog, value, nextModelId)
    const fallbackThinkingLevel =
      (defaultThinkingLevel && nextThinkingOptions.includes(defaultThinkingLevel)
        ? defaultThinkingLevel
        : nextThinkingOptions[0]) ?? DEFAULT_CREATE_MANAGER_THINKING_LEVEL

    const nextThinkingLevel = nextThinkingOptions.includes(newManagerThinkingLevel)
      ? newManagerThinkingLevel
      : fallbackThinkingLevel
    const shouldResetThinking = nextThinkingLevel !== newManagerThinkingLevel
    setNewManagerThinkingLevel(nextThinkingLevel)

    if (shouldResetModel && shouldResetThinking) {
      setCreateManagerSelectionHint('Model and thinking were reset for the selected provider.')
      return
    }

    if (shouldResetModel) {
      setCreateManagerSelectionHint('Model was reset for the selected provider.')
      return
    }

    if (shouldResetThinking) {
      setCreateManagerSelectionHint('Thinking was reset for the selected provider.')
    }
  }, [createManagerCatalog, newManagerModelId, newManagerThinkingLevel])

  const handleNewManagerModelIdChange = useCallback((value: string) => {
    const normalizedModelId = value.trim()
    const nextModelId =
      normalizedModelId ||
      getCatalogDefaultModelForProvider(createManagerCatalog, newManagerProvider) ||
      ''
    setNewManagerModelId(nextModelId)
    setCreateManagerError(null)
    setCreateManagerSelectionHint(null)

    const nextThinkingOptions = getCatalogAllowedThinkingLevels(
      createManagerCatalog,
      newManagerProvider,
      nextModelId,
    )
    const defaultThinkingLevel = getCatalogDefaultThinkingLevel(
      createManagerCatalog,
      newManagerProvider,
      nextModelId,
    )
    const fallbackThinkingLevel =
      (defaultThinkingLevel && nextThinkingOptions.includes(defaultThinkingLevel)
        ? defaultThinkingLevel
        : nextThinkingOptions[0]) ?? DEFAULT_CREATE_MANAGER_THINKING_LEVEL
    const nextThinkingLevel = nextThinkingOptions.includes(newManagerThinkingLevel)
      ? newManagerThinkingLevel
      : fallbackThinkingLevel

    if (nextThinkingLevel !== newManagerThinkingLevel) {
      setCreateManagerSelectionHint(
        normalizedModelId
          ? 'Thinking was reset for the selected model.'
          : 'Model and thinking were reset for the selected provider.',
      )
      setNewManagerThinkingLevel(nextThinkingLevel)
    }
  }, [createManagerCatalog, newManagerProvider, newManagerThinkingLevel])

  const handleNewManagerThinkingLevelChange = useCallback((value: ThinkingLevel) => {
    setNewManagerThinkingLevel(value)
    setCreateManagerError(null)
    setCreateManagerSelectionHint(null)
  }, [])

  const handleCompactManager = useCallback(async (customInstructions?: string) => {
    if (!isActiveManager || !activeAgentId) {
      return
    }

    setIsCompactingManager(true)

    try {
      await requestManagerCompaction(wsUrl, activeAgentId, customInstructions)
      setState((previous) => ({
        ...previous,
        lastError: null,
      }))
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to compact manager context: ${toErrorMessage(error)}`,
      }))
    } finally {
      setIsCompactingManager(false)
    }
  }, [activeAgentId, isActiveManager, setState, wsUrl])

  const handleStopAllAgents = useCallback(async () => {
    const client = clientRef.current
    if (!client || activeAgent?.role !== 'manager') {
      return
    }

    setIsStoppingAllAgents(true)

    try {
      await client.stopAllAgents(activeAgent.agentId)
      clearPendingResponseForAgent(activeAgent.agentId)
      setState((previous) => ({
        ...previous,
        lastError: null,
      }))
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to stop manager and workers: ${toErrorMessage(error)}`,
      }))
    } finally {
      setIsStoppingAllAgents(false)
    }
  }, [activeAgent, clearPendingResponseForAgent, clientRef, setState])

  const handleOpenCreateManagerDialog = useCallback(() => {
    const defaultCwd =
      activeAgent?.cwd ??
      agents.find((agent) => agent.role === 'manager')?.cwd ??
      ''

    const requestId = ++createManagerCatalogRequestIdRef.current

    setNewManagerName('')
    setNewManagerCwd(defaultCwd)
    setNewManagerProvider('')
    setNewManagerModelId('')
    setNewManagerThinkingLevel(DEFAULT_CREATE_MANAGER_THINKING_LEVEL)
    setCreateManagerCatalog(createEmptyCreateManagerCatalog())
    setIsLoadingCreateManagerCatalog(true)
    setCreateManagerCatalogError(null)
    setCreateManagerSelectionHint(null)
    setBrowseError(null)
    setCreateManagerError(null)
    setIsCreateManagerDialogOpen(true)

    void (async () => {
      try {
        const response = await fetchManagerModelCatalog(wsUrl)
        const nextCatalog = toCreateManagerCatalog(response)
        if (requestId !== createManagerCatalogRequestIdRef.current) {
          return
        }

        setCreateManagerCatalog(nextCatalog)
        if (nextCatalog.providers.length === 0) {
          setCreateManagerCatalogError('No manager model options are available right now.')
        }
      } catch (error) {
        if (requestId !== createManagerCatalogRequestIdRef.current) {
          return
        }
        setCreateManagerCatalogError(toErrorMessage(error))
      } finally {
        if (requestId === createManagerCatalogRequestIdRef.current) {
          setIsLoadingCreateManagerCatalog(false)
        }
      }
    })()
  }, [activeAgent, agents, wsUrl])

  const handleCreateManagerDialogOpenChange = useCallback((open: boolean) => {
    if (!open && isCreatingManager) {
      return
    }

    setIsCreateManagerDialogOpen(open)
  }, [isCreatingManager])

  const handleBrowseDirectory = useCallback(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }

    setBrowseError(null)
    setIsPickingDirectory(true)

    try {
      const pickedPath = await client.pickDirectory(newManagerCwd)
      if (!pickedPath) {
        return
      }

      setNewManagerCwd(pickedPath)
      setCreateManagerError(null)
    } catch (error) {
      setBrowseError(toErrorMessage(error))
    } finally {
      setIsPickingDirectory(false)
    }
  }, [clientRef, newManagerCwd])

  const handleCreateManager = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const client = clientRef.current
    if (!client) {
      return
    }

    const name = newManagerName.trim()
    const cwd = newManagerCwd.trim()

    if (!name) {
      setCreateManagerError('Manager name is required.')
      return
    }

    if (!cwd) {
      setCreateManagerError('Manager working directory is required.')
      return
    }

    if (!newManagerProvider) {
      setCreateManagerError('Provider selection is required.')
      return
    }

    if (!newManagerModelId) {
      setCreateManagerError('Model selection is required.')
      return
    }

    if (!newManagerThinkingLevel) {
      setCreateManagerError('Thinking selection is required.')
      return
    }

    if (isLoadingCreateManagerCatalog) {
      setCreateManagerError('Model catalog is still loading. Please wait.')
      return
    }

    if (!isCatalogDescriptorSupported(createManagerCatalog, newManagerProvider, newManagerModelId)) {
      setCreateManagerError('Select a supported provider and model before creating.')
      return
    }

    const allowedThinkingLevels = getCatalogAllowedThinkingLevels(
      createManagerCatalog,
      newManagerProvider,
      newManagerModelId,
    )
    if (!allowedThinkingLevels.includes(newManagerThinkingLevel)) {
      setCreateManagerError('Selected thinking level is not available for this model.')
      return
    }

    setCreateManagerError(null)
    setIsCreatingManager(true)

    try {
      setIsValidatingDirectory(true)
      const validation = await client.validateDirectory(cwd)
      setIsValidatingDirectory(false)

      if (!validation.valid) {
        setCreateManagerError(validation.message ?? 'Directory is not valid.')
        return
      }

      const manager = await client.createManager({
        name,
        cwd: validation.path || cwd,
        provider: newManagerProvider,
        modelId: newManagerModelId,
        thinkingLevel: newManagerThinkingLevel,
      })

      navigateToRoute({ view: 'chat', agentId: manager.agentId })
      client.subscribeToAgent(manager.agentId)

      setIsCreateManagerDialogOpen(false)
      setNewManagerName('')
      setNewManagerCwd('')
      setNewManagerProvider('')
      setNewManagerModelId('')
      setNewManagerThinkingLevel(DEFAULT_CREATE_MANAGER_THINKING_LEVEL)
      setCreateManagerSelectionHint(null)
      setBrowseError(null)
      setCreateManagerError(null)
    } catch (error) {
      setCreateManagerError(toErrorMessage(error))
    } finally {
      setIsValidatingDirectory(false)
      setIsCreatingManager(false)
    }
  }, [
    clientRef,
    navigateToRoute,
    newManagerCwd,
    newManagerModelId,
    newManagerName,
    newManagerProvider,
    newManagerThinkingLevel,
    createManagerCatalog,
    isLoadingCreateManagerCatalog,
  ])

  const handleRequestDeleteManager = useCallback((managerId: string) => {
    const manager = agents.find(
      (agent) => agent.agentId === managerId && agent.role === 'manager',
    )
    if (!manager) {
      return
    }

    setDeleteManagerError(null)
    setManagerToDelete(manager)
  }, [agents])

  const handleConfirmDeleteManager = useCallback(async () => {
    const manager = managerToDelete
    const client = clientRef.current
    if (!manager || !client) {
      return
    }

    setDeleteManagerError(null)
    setIsDeletingManager(true)

    try {
      await client.deleteManager(manager.agentId)

      if (activeAgentId === manager.agentId) {
        const remainingAgents = agents.filter(
          (agent) =>
            agent.agentId !== manager.agentId &&
            agent.managerId !== manager.agentId,
        )
        const fallbackAgentId = chooseFallbackAgentId(remainingAgents)
        if (fallbackAgentId) {
          navigateToRoute({ view: 'chat', agentId: fallbackAgentId })
          client.subscribeToAgent(fallbackAgentId)
        }
      }

      setManagerToDelete(null)
      setDeleteManagerError(null)
    } catch (error) {
      setDeleteManagerError(toErrorMessage(error))
    } finally {
      setIsDeletingManager(false)
    }
  }, [activeAgentId, agents, clientRef, managerToDelete, navigateToRoute])

  const handleCloseDeleteManagerDialog = useCallback(() => {
    if (isDeletingManager) {
      return
    }

    setManagerToDelete(null)
    setDeleteManagerError(null)
  }, [isDeletingManager])

  return {
    isCreateManagerDialogOpen,
    newManagerName,
    newManagerCwd,
    newManagerProvider,
    newManagerModelId,
    newManagerThinkingLevel,
    isLoadingCreateManagerCatalog,
    createManagerCatalogError,
    isCreateManagerSubmitDisabled,
    createManagerProviderOptions,
    createManagerModelOptions,
    createManagerThinkingOptions,
    createManagerSelectionHint,
    createManagerError,
    browseError,
    isCreatingManager,
    isValidatingDirectory,
    isPickingDirectory,
    handleNewManagerNameChange,
    handleNewManagerCwdChange,
    handleNewManagerProviderChange,
    handleNewManagerModelIdChange,
    handleNewManagerThinkingLevelChange,
    handleOpenCreateManagerDialog,
    handleCreateManagerDialogOpenChange,
    handleBrowseDirectory,
    handleCreateManager,
    managerToDelete,
    deleteManagerError,
    isDeletingManager,
    handleRequestDeleteManager,
    handleConfirmDeleteManager,
    handleCloseDeleteManagerDialog,
    isCompactingManager,
    handleCompactManager,
    isStoppingAllAgents,
    handleStopAllAgents,
  }
}

async function requestManagerCompaction(
  wsUrl: string,
  agentId: string,
  customInstructions?: string,
): Promise<void> {
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/agents/${encodeURIComponent(agentId)}/compact`,
  )

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(
      customInstructions && customInstructions.trim().length > 0
        ? { customInstructions: customInstructions.trim() }
        : {},
    ),
  })

  if (response.ok) {
    return
  }

  let errorMessage: string | undefined
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
      errorMessage = payload.error.trim()
    }
  } catch {
    // Ignore JSON parsing errors and fall back to status-based error text.
  }

  throw new Error(errorMessage ?? `Compaction request failed with status ${response.status}`)
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'An unexpected error occurred.'
}
