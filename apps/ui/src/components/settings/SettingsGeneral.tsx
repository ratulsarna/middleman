import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
} from '@/lib/theme'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import {
  createEmptyCreateManagerCatalog,
  fetchManagerModelCatalog,
  getCatalogProviderLabel,
  getCatalogAllowedThinkingLevels,
  getCatalogDefaultModelForProvider,
  getCatalogDefaultThinkingLevel,
  getCatalogModelOptions,
  getCatalogProviderOptions,
  getDefaultCatalogSelection,
  getManagerSettingsAllowedThinkingLevels,
  getManagerSettingsDefaultModelForProvider,
  getManagerSettingsDefaultThinkingLevel,
  getManagerSettingsModelOptions,
  getManagerSettingsProviderOptions,
  isCatalogDescriptorSupported,
  isSupportedManagerSettingsDescriptor,
  toManagerSettingsCatalog,
  toSpawnDefaultCatalog,
} from '@/lib/manager-model-catalog-api'
import type { UpdateManagerInput, UpdateManagerResult } from '@/lib/ws-client'
import type { AgentDescriptor, ThinkingLevel } from '@nexus/protocol'
import { fetchClaudeOutputStyle, toErrorMessage, updateClaudeOutputStyle } from './settings-api'
import type { ClaudeOutputStyleState } from './settings-types'

interface SettingsGeneralProps {
  wsUrl: string
  managers: AgentDescriptor[]
  onUpdateManager: (input: UpdateManagerInput) => Promise<UpdateManagerResult>
}

interface ManagerRuntimeDraft {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
  promptOverride: string
}

interface SpawnDefaultDraft {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
}

const NO_OUTPUT_STYLE_VALUE = '__none__'

function toManagerRuntimeDraft(manager: Pick<AgentDescriptor, 'model' | 'promptOverride'>): ManagerRuntimeDraft {
  return {
    provider: manager.model.provider,
    modelId: manager.model.modelId,
    thinkingLevel: manager.model.thinkingLevel,
    promptOverride: manager.promptOverride ?? '',
  }
}

export function SettingsGeneral({ wsUrl, managers, onUpdateManager }: SettingsGeneralProps) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readStoredThemePreference(),
  )

  const managerOptions = useMemo(
    () => managers.filter((manager) => manager.role === 'manager'),
    [managers],
  )

  const [selectedRuntimeManagerId, setSelectedRuntimeManagerId] = useState('')
  const [runtimeCatalog, setRuntimeCatalog] = useState(createEmptyCreateManagerCatalog)
  const [isLoadingRuntimeCatalog, setIsLoadingRuntimeCatalog] = useState(false)
  const [runtimeCatalogError, setRuntimeCatalogError] = useState<string | null>(null)
  const [runtimeDraft, setRuntimeDraft] = useState<ManagerRuntimeDraft | null>(null)
  const [runtimeSelectionHint, setRuntimeSelectionHint] = useState<string | null>(null)
  const [runtimeSaveError, setRuntimeSaveError] = useState<string | null>(null)
  const [runtimeSaveSuccess, setRuntimeSaveSuccess] = useState<string | null>(null)
  const [isSavingRuntimeSettings, setIsSavingRuntimeSettings] = useState(false)
  const runtimeSaveRequestIdRef = useRef(0)
  const runtimeCatalogRequestIdRef = useRef(0)
  const previousRuntimeManagerIdRef = useRef<string>('')
  const selectedRuntimeManagerIdRef = useRef('')
  selectedRuntimeManagerIdRef.current = selectedRuntimeManagerId

  const [selectedSpawnManagerId, setSelectedSpawnManagerId] = useState('')
  const [spawnCatalog, setSpawnCatalog] = useState(createEmptyCreateManagerCatalog)
  const [spawnDraft, setSpawnDraft] = useState<SpawnDefaultDraft | null>(null)
  const [spawnSelectionHint, setSpawnSelectionHint] = useState<string | null>(null)
  const [spawnSaveError, setSpawnSaveError] = useState<string | null>(null)
  const [spawnSaveSuccess, setSpawnSaveSuccess] = useState<string | null>(null)
  const [isSavingSpawnSettings, setIsSavingSpawnSettings] = useState(false)
  const spawnSaveRequestIdRef = useRef(0)
  const previousSpawnManagerIdRef = useRef<string>('')
  const selectedSpawnManagerIdRef = useRef('')
  selectedSpawnManagerIdRef.current = selectedSpawnManagerId

  const [selectedClaudeManagerId, setSelectedClaudeManagerId] = useState<string>('')
  const [claudeOutputStyleState, setClaudeOutputStyleState] = useState<ClaudeOutputStyleState | null>(null)
  const [isLoadingClaudeOutputStyle, setIsLoadingClaudeOutputStyle] = useState(false)
  const [isSavingClaudeOutputStyle, setIsSavingClaudeOutputStyle] = useState(false)
  const [claudeOutputStyleError, setClaudeOutputStyleError] = useState<string | null>(null)
  const claudeOutputStyleRequestIdRef = useRef(0)
  const selectedClaudeManagerIdRef = useRef('')
  selectedClaudeManagerIdRef.current = selectedClaudeManagerId

  useEffect(() => {
    setThemePreference(readStoredThemePreference())
  }, [])

  useEffect(() => {
    setSelectedRuntimeManagerId((current) => {
      if (current && managerOptions.some((manager) => manager.agentId === current)) {
        return current
      }

      return managerOptions[0]?.agentId ?? ''
    })
  }, [managerOptions])

  useEffect(() => {
    setSelectedSpawnManagerId((current) => {
      if (current && managerOptions.some((manager) => manager.agentId === current)) {
        return current
      }

      return managerOptions[0]?.agentId ?? ''
    })
  }, [managerOptions])

  const selectedRuntimeManager = useMemo(
    () => managerOptions.find((manager) => manager.agentId === selectedRuntimeManagerId) ?? null,
    [managerOptions, selectedRuntimeManagerId],
  )

  useEffect(() => {
    const nextManagerId = selectedRuntimeManager?.agentId ?? ''
    if (previousRuntimeManagerIdRef.current === nextManagerId) {
      return
    }

    previousRuntimeManagerIdRef.current = nextManagerId
    setIsSavingRuntimeSettings(false)
    setRuntimeSelectionHint(null)
    setRuntimeSaveError(null)
    setRuntimeSaveSuccess(null)

    if (!selectedRuntimeManager) {
      setRuntimeDraft(null)
      return
    }

    setRuntimeDraft(toManagerRuntimeDraft(selectedRuntimeManager))
  }, [selectedRuntimeManager])

  const selectedSpawnManager = useMemo(
    () => managerOptions.find((manager) => manager.agentId === selectedSpawnManagerId) ?? null,
    [managerOptions, selectedSpawnManagerId],
  )

  const isSpawnDefaultSet = Boolean(selectedSpawnManager?.spawnDefaultModel)

  useEffect(() => {
    const nextManagerId = selectedSpawnManager?.agentId ?? ''
    const managerChanged = previousSpawnManagerIdRef.current !== nextManagerId

    if (managerChanged) {
      previousSpawnManagerIdRef.current = nextManagerId
      setIsSavingSpawnSettings(false)
      setSpawnSelectionHint(null)
      setSpawnSaveError(null)
      setSpawnSaveSuccess(null)
    }

    if (!selectedSpawnManager) {
      if (managerChanged) {
        setSpawnDraft(null)
      }
      return
    }

    if (selectedSpawnManager.spawnDefaultModel) {
      if (managerChanged) {
        setSpawnDraft({
          provider: selectedSpawnManager.spawnDefaultModel.provider,
          modelId: selectedSpawnManager.spawnDefaultModel.modelId,
          thinkingLevel: selectedSpawnManager.spawnDefaultModel.thinkingLevel,
        })
      }
      return
    }

    // No spawn default set — fill from catalog defaults on manager change or catalog load.
    setSpawnDraft((current) => {
      if (current !== null && !managerChanged) {
        return current
      }
      const defaultSelection = getDefaultCatalogSelection(spawnCatalog)
      if (defaultSelection) {
        return {
          provider: defaultSelection.provider,
          modelId: defaultSelection.modelId,
          thinkingLevel: defaultSelection.thinkingLevel,
        }
      }
      return null
    })
  }, [selectedSpawnManager, spawnCatalog])

  useEffect(() => {
    const requestId = ++runtimeCatalogRequestIdRef.current
    setIsLoadingRuntimeCatalog(true)
    setRuntimeCatalogError(null)

    void (async () => {
      try {
        const response = await fetchManagerModelCatalog(wsUrl)
        if (requestId !== runtimeCatalogRequestIdRef.current) {
          return
        }

        const nextCatalog = toManagerSettingsCatalog(response)
        setRuntimeCatalog(nextCatalog)
        setSpawnCatalog(toSpawnDefaultCatalog(response))
        if (nextCatalog.providers.length === 0) {
          setRuntimeCatalogError('No runtime model options are available right now.')
        }
      } catch (error) {
        if (requestId !== runtimeCatalogRequestIdRef.current) {
          return
        }

        setRuntimeCatalog(createEmptyCreateManagerCatalog())
        setSpawnCatalog(createEmptyCreateManagerCatalog())
        setRuntimeCatalogError(toErrorMessage(error))
      } finally {
        if (requestId === runtimeCatalogRequestIdRef.current) {
          setIsLoadingRuntimeCatalog(false)
        }
      }
    })()
  }, [wsUrl])

  const runtimeProviderOptions = useMemo(() => {
    const options = getManagerSettingsProviderOptions(runtimeCatalog)
    const currentProvider = runtimeDraft?.provider
    if (!currentProvider || options.some((option) => option.value === currentProvider)) {
      return options
    }

    return [
      ...options,
      {
        value: currentProvider,
        label: `${getCatalogProviderLabel(runtimeCatalog, currentProvider)} (unsupported)`,
      },
    ]
  }, [runtimeCatalog, runtimeDraft?.provider])

  const runtimeModelOptions = useMemo(() => {
    if (!runtimeDraft) {
      return []
    }

    const options = getManagerSettingsModelOptions(runtimeCatalog, runtimeDraft.provider)
    if (options.some((option) => option.value === runtimeDraft.modelId)) {
      return options
    }

    return [
      ...options,
      {
        value: runtimeDraft.modelId,
        label: `${runtimeDraft.modelId} (unsupported)`,
      },
    ]
  }, [runtimeCatalog, runtimeDraft])

  const runtimeThinkingOptions = useMemo(() => {
    if (!runtimeDraft) {
      return []
    }

    const allowedThinkingLevels = getManagerSettingsAllowedThinkingLevels(
      runtimeCatalog,
      runtimeDraft.provider,
      runtimeDraft.modelId,
    )

    if (allowedThinkingLevels.includes(runtimeDraft.thinkingLevel)) {
      return allowedThinkingLevels
    }

    return [...allowedThinkingLevels, runtimeDraft.thinkingLevel]
  }, [runtimeCatalog, runtimeDraft])

  const spawnProviderOptions = useMemo(() => {
    const options = getCatalogProviderOptions(spawnCatalog)
    const currentProvider = spawnDraft?.provider
    if (!currentProvider || options.some((option) => option.value === currentProvider)) {
      return options
    }

    return [
      ...options,
      {
        value: currentProvider,
        label: `${getCatalogProviderLabel(spawnCatalog, currentProvider)} (unsupported)`,
      },
    ]
  }, [spawnCatalog, spawnDraft?.provider])

  const spawnModelOptions = useMemo(() => {
    if (!spawnDraft) {
      return []
    }

    const options = getCatalogModelOptions(spawnCatalog, spawnDraft.provider)
    if (options.some((option) => option.value === spawnDraft.modelId)) {
      return options
    }

    return [
      ...options,
      {
        value: spawnDraft.modelId,
        label: `${spawnDraft.modelId} (unsupported)`,
      },
    ]
  }, [spawnCatalog, spawnDraft?.provider, spawnDraft?.modelId])

  const spawnThinkingOptions = useMemo(() => {
    if (!spawnDraft) {
      return []
    }

    const allowedThinkingLevels = getCatalogAllowedThinkingLevels(
      spawnCatalog,
      spawnDraft.provider,
      spawnDraft.modelId,
    )

    if (allowedThinkingLevels.includes(spawnDraft.thinkingLevel)) {
      return allowedThinkingLevels
    }

    return [...allowedThinkingLevels, spawnDraft.thinkingLevel]
  }, [spawnCatalog, spawnDraft?.provider, spawnDraft?.modelId, spawnDraft?.thinkingLevel])

  const resetRuntimeFeedback = useCallback(() => {
    setRuntimeSaveError(null)
    setRuntimeSaveSuccess(null)
    setRuntimeSelectionHint(null)
  }, [])

  const handleRuntimeProviderChange = useCallback((nextProvider: string) => {
    setRuntimeDraft((current) => {
      if (!current) {
        return current
      }

      resetRuntimeFeedback()

      const nextModelId =
        getManagerSettingsDefaultModelForProvider(runtimeCatalog, nextProvider) ??
        getManagerSettingsModelOptions(runtimeCatalog, nextProvider)[0]?.value ??
        current.modelId
      const shouldResetModel = nextModelId !== current.modelId

      const nextThinkingOptions = getManagerSettingsAllowedThinkingLevels(runtimeCatalog, nextProvider, nextModelId)
      const defaultThinkingLevel = getManagerSettingsDefaultThinkingLevel(runtimeCatalog, nextProvider, nextModelId)
      const fallbackThinkingLevel =
        (defaultThinkingLevel && nextThinkingOptions.includes(defaultThinkingLevel)
          ? defaultThinkingLevel
          : nextThinkingOptions[0]) ?? current.thinkingLevel

      const nextThinkingLevel = nextThinkingOptions.includes(current.thinkingLevel)
        ? current.thinkingLevel
        : fallbackThinkingLevel
      const shouldResetThinking = nextThinkingLevel !== current.thinkingLevel

      if (shouldResetModel && shouldResetThinking) {
        setRuntimeSelectionHint('Model and thinking were reset for the selected provider.')
      } else if (shouldResetModel) {
        setRuntimeSelectionHint('Model was reset for the selected provider.')
      } else if (shouldResetThinking) {
        setRuntimeSelectionHint('Thinking was reset for the selected provider.')
      }

      return {
        ...current,
        provider: nextProvider,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      }
    })
  }, [resetRuntimeFeedback, runtimeCatalog])

  const handleRuntimeModelChange = useCallback((nextModelId: string) => {
    setRuntimeDraft((current) => {
      if (!current) {
        return current
      }

      resetRuntimeFeedback()

      const nextThinkingOptions = getManagerSettingsAllowedThinkingLevels(runtimeCatalog, current.provider, nextModelId)
      const defaultThinkingLevel = getManagerSettingsDefaultThinkingLevel(runtimeCatalog, current.provider, nextModelId)
      const fallbackThinkingLevel =
        (defaultThinkingLevel && nextThinkingOptions.includes(defaultThinkingLevel)
          ? defaultThinkingLevel
          : nextThinkingOptions[0]) ?? current.thinkingLevel

      const nextThinkingLevel = nextThinkingOptions.includes(current.thinkingLevel)
        ? current.thinkingLevel
        : fallbackThinkingLevel

      if (nextThinkingLevel !== current.thinkingLevel) {
        setRuntimeSelectionHint('Thinking was reset for the selected model.')
      }

      return {
        ...current,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      }
    })
  }, [resetRuntimeFeedback, runtimeCatalog])

  const handleRuntimeThinkingChange = useCallback((nextThinkingLevel: ThinkingLevel) => {
    setRuntimeDraft((current) => {
      if (!current) {
        return current
      }

      resetRuntimeFeedback()

      return {
        ...current,
        thinkingLevel: nextThinkingLevel,
      }
    })
  }, [resetRuntimeFeedback])

  const resetSpawnFeedback = useCallback(() => {
    setSpawnSaveError(null)
    setSpawnSaveSuccess(null)
    setSpawnSelectionHint(null)
  }, [])

  const handleSpawnProviderChange = useCallback((nextProvider: string) => {
    setSpawnDraft((current) => {
      if (!current) {
        return current
      }

      resetSpawnFeedback()

      const nextModelId =
        getCatalogDefaultModelForProvider(spawnCatalog, nextProvider) ??
        getCatalogModelOptions(spawnCatalog, nextProvider)[0]?.value ??
        current.modelId
      const shouldResetModel = nextModelId !== current.modelId

      const nextThinkingOptions = getCatalogAllowedThinkingLevels(spawnCatalog, nextProvider, nextModelId)
      const defaultThinkingLevel = getCatalogDefaultThinkingLevel(spawnCatalog, nextProvider, nextModelId)
      const fallbackThinkingLevel =
        (defaultThinkingLevel && nextThinkingOptions.includes(defaultThinkingLevel)
          ? defaultThinkingLevel
          : nextThinkingOptions[0]) ?? current.thinkingLevel

      const nextThinkingLevel = nextThinkingOptions.includes(current.thinkingLevel)
        ? current.thinkingLevel
        : fallbackThinkingLevel
      const shouldResetThinking = nextThinkingLevel !== current.thinkingLevel

      if (shouldResetModel && shouldResetThinking) {
        setSpawnSelectionHint('Model and thinking were reset for the selected provider.')
      } else if (shouldResetModel) {
        setSpawnSelectionHint('Model was reset for the selected provider.')
      } else if (shouldResetThinking) {
        setSpawnSelectionHint('Thinking was reset for the selected provider.')
      }

      return {
        ...current,
        provider: nextProvider,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      }
    })
  }, [resetSpawnFeedback, spawnCatalog])

  const handleSpawnModelChange = useCallback((nextModelId: string) => {
    setSpawnDraft((current) => {
      if (!current) {
        return current
      }

      resetSpawnFeedback()

      const nextThinkingOptions = getCatalogAllowedThinkingLevels(spawnCatalog, current.provider, nextModelId)
      const defaultThinkingLevel = getCatalogDefaultThinkingLevel(spawnCatalog, current.provider, nextModelId)
      const fallbackThinkingLevel =
        (defaultThinkingLevel && nextThinkingOptions.includes(defaultThinkingLevel)
          ? defaultThinkingLevel
          : nextThinkingOptions[0]) ?? current.thinkingLevel

      const nextThinkingLevel = nextThinkingOptions.includes(current.thinkingLevel)
        ? current.thinkingLevel
        : fallbackThinkingLevel

      if (nextThinkingLevel !== current.thinkingLevel) {
        setSpawnSelectionHint('Thinking was reset for the selected model.')
      }

      return {
        ...current,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      }
    })
  }, [resetSpawnFeedback, spawnCatalog])

  const handleSpawnThinkingChange = useCallback((nextThinkingLevel: ThinkingLevel) => {
    setSpawnDraft((current) => {
      if (!current) {
        return current
      }

      resetSpawnFeedback()

      return {
        ...current,
        thinkingLevel: nextThinkingLevel,
      }
    })
  }, [resetSpawnFeedback])

  const handleRuntimePromptOverrideChange = useCallback((nextPromptOverride: string) => {
    setRuntimeDraft((current) => {
      if (!current) {
        return current
      }

      setRuntimeSaveError(null)
      setRuntimeSaveSuccess(null)

      return {
        ...current,
        promptOverride: nextPromptOverride,
      }
    })
  }, [])

  const handleSaveRuntimeSettings = useCallback(async () => {
    if (!selectedRuntimeManager || !runtimeDraft) {
      return
    }

    const currentPromptOverride = selectedRuntimeManager.promptOverride ?? ''
    const descriptorChanged =
      selectedRuntimeManager.model.provider !== runtimeDraft.provider ||
      selectedRuntimeManager.model.modelId !== runtimeDraft.modelId ||
      selectedRuntimeManager.model.thinkingLevel !== runtimeDraft.thinkingLevel
    const promptOverrideChanged = currentPromptOverride !== runtimeDraft.promptOverride

    if (!runtimeDraft.provider || !runtimeDraft.modelId || !runtimeDraft.thinkingLevel) {
      setRuntimeSaveError('Provider, model, and thinking are required.')
      setRuntimeSaveSuccess(null)
      return
    }

    if (isLoadingRuntimeCatalog) {
      setRuntimeSaveError('Runtime model catalog is still loading. Please wait.')
      setRuntimeSaveSuccess(null)
      return
    }

    const descriptorSupported = isSupportedManagerSettingsDescriptor(
      runtimeCatalog,
      runtimeDraft.provider,
      runtimeDraft.modelId,
    )

    if (!descriptorSupported && descriptorChanged) {
      setRuntimeSaveError('Select a supported provider and model combination before saving.')
      setRuntimeSaveSuccess(null)
      return
    }

    if (!descriptorSupported && !promptOverrideChanged) {
      setRuntimeSaveError('Current model is unsupported in this editor. Choose a supported model to save.')
      setRuntimeSaveSuccess(null)
      return
    }

    const allowedThinkingLevels = getManagerSettingsAllowedThinkingLevels(
      runtimeCatalog,
      runtimeDraft.provider,
      runtimeDraft.modelId,
    )
    if (
      descriptorSupported &&
      !allowedThinkingLevels.includes(runtimeDraft.thinkingLevel)
    ) {
      setRuntimeSaveError('Selected thinking level is not available for this model.')
      setRuntimeSaveSuccess(null)
      return
    }

    const requestId = ++runtimeSaveRequestIdRef.current
    setIsSavingRuntimeSettings(true)
    setRuntimeSaveError(null)
    setRuntimeSaveSuccess(null)

    const input: UpdateManagerInput = {
      managerId: selectedRuntimeManager.agentId,
    }

    if (descriptorSupported) {
      input.provider = runtimeDraft.provider
      input.modelId = runtimeDraft.modelId
      input.thinkingLevel = runtimeDraft.thinkingLevel
    }

    if (promptOverrideChanged) {
      input.promptOverride = runtimeDraft.promptOverride
    }

    try {
      const result = await onUpdateManager(input)

      if (
        requestId !== runtimeSaveRequestIdRef.current ||
        selectedRuntimeManager.agentId !== selectedRuntimeManagerIdRef.current
      ) {
        return
      }

      setRuntimeDraft(toManagerRuntimeDraft(result.manager))
      setRuntimeSelectionHint(null)
      setRuntimeSaveSuccess(
        result.resetApplied
          ? 'Manager settings saved. Runtime was reset.'
          : 'Manager settings saved. No runtime reset was needed.',
      )
    } catch (error) {
      if (
        requestId !== runtimeSaveRequestIdRef.current ||
        selectedRuntimeManager.agentId !== selectedRuntimeManagerIdRef.current
      ) {
        return
      }

      setRuntimeSaveError(toErrorMessage(error))
    } finally {
      if (
        requestId === runtimeSaveRequestIdRef.current &&
        selectedRuntimeManager.agentId === selectedRuntimeManagerIdRef.current
      ) {
        setIsSavingRuntimeSettings(false)
      }
    }
  }, [isLoadingRuntimeCatalog, onUpdateManager, runtimeCatalog, runtimeDraft, selectedRuntimeManager])

  const handleSaveSpawnDefault = useCallback(async () => {
    if (!selectedSpawnManager || !spawnDraft) {
      return
    }

    if (!spawnDraft.provider || !spawnDraft.modelId || !spawnDraft.thinkingLevel) {
      setSpawnSaveError('Provider, model, and thinking are required.')
      setSpawnSaveSuccess(null)
      return
    }

    if (isLoadingRuntimeCatalog) {
      setSpawnSaveError('Model catalog is still loading. Please wait.')
      setSpawnSaveSuccess(null)
      return
    }

    const descriptorSupported = isCatalogDescriptorSupported(
      spawnCatalog,
      spawnDraft.provider,
      spawnDraft.modelId,
    )

    if (!descriptorSupported) {
      setSpawnSaveError('Select a supported provider and model combination before saving.')
      setSpawnSaveSuccess(null)
      return
    }

    const allowedThinkingLevels = getCatalogAllowedThinkingLevels(
      spawnCatalog,
      spawnDraft.provider,
      spawnDraft.modelId,
    )
    if (!allowedThinkingLevels.includes(spawnDraft.thinkingLevel)) {
      setSpawnSaveError('Selected thinking level is not available for this model.')
      setSpawnSaveSuccess(null)
      return
    }

    const requestId = ++spawnSaveRequestIdRef.current
    setIsSavingSpawnSettings(true)
    setSpawnSaveError(null)
    setSpawnSaveSuccess(null)

    try {
      const result = await onUpdateManager({
        managerId: selectedSpawnManager.agentId,
        spawnDefaultProvider: spawnDraft.provider,
        spawnDefaultModelId: spawnDraft.modelId,
        spawnDefaultThinkingLevel: spawnDraft.thinkingLevel,
      })

      if (
        requestId !== spawnSaveRequestIdRef.current ||
        selectedSpawnManager.agentId !== selectedSpawnManagerIdRef.current
      ) {
        return
      }

      if (result.manager.spawnDefaultModel) {
        setSpawnDraft({
          provider: result.manager.spawnDefaultModel.provider,
          modelId: result.manager.spawnDefaultModel.modelId,
          thinkingLevel: result.manager.spawnDefaultModel.thinkingLevel,
        })
      }
      setSpawnSelectionHint(null)
      setSpawnSaveSuccess('Worker spawn default saved.')
    } catch (error) {
      if (
        requestId !== spawnSaveRequestIdRef.current ||
        selectedSpawnManager.agentId !== selectedSpawnManagerIdRef.current
      ) {
        return
      }

      setSpawnSaveError(toErrorMessage(error))
    } finally {
      if (
        requestId === spawnSaveRequestIdRef.current &&
        selectedSpawnManager.agentId === selectedSpawnManagerIdRef.current
      ) {
        setIsSavingSpawnSettings(false)
      }
    }
  }, [isLoadingRuntimeCatalog, onUpdateManager, spawnCatalog, spawnDraft, selectedSpawnManager])

  const handleClearSpawnDefault = useCallback(async () => {
    if (!selectedSpawnManager) {
      return
    }

    const requestId = ++spawnSaveRequestIdRef.current
    setIsSavingSpawnSettings(true)
    setSpawnSaveError(null)
    setSpawnSaveSuccess(null)

    try {
      await onUpdateManager({
        managerId: selectedSpawnManager.agentId,
        clearSpawnDefault: true,
      })

      if (
        requestId !== spawnSaveRequestIdRef.current ||
        selectedSpawnManager.agentId !== selectedSpawnManagerIdRef.current
      ) {
        return
      }

      const defaultSelection = getDefaultCatalogSelection(spawnCatalog)
      if (defaultSelection) {
        setSpawnDraft({
          provider: defaultSelection.provider,
          modelId: defaultSelection.modelId,
          thinkingLevel: defaultSelection.thinkingLevel,
        })
      } else {
        setSpawnDraft(null)
      }
      setSpawnSelectionHint(null)
      setSpawnSaveSuccess('Worker spawn default cleared.')
    } catch (error) {
      if (
        requestId !== spawnSaveRequestIdRef.current ||
        selectedSpawnManager.agentId !== selectedSpawnManagerIdRef.current
      ) {
        return
      }

      setSpawnSaveError(toErrorMessage(error))
    } finally {
      if (
        requestId === spawnSaveRequestIdRef.current &&
        selectedSpawnManager.agentId === selectedSpawnManagerIdRef.current
      ) {
        setIsSavingSpawnSettings(false)
      }
    }
  }, [onUpdateManager, selectedSpawnManager, spawnCatalog])

  const claudeManagers = useMemo(
    () =>
      managers.filter(
        (manager) => manager.role === 'manager' && manager.model.provider.trim().toLowerCase() === 'claude-agent-sdk',
      ),
    [managers],
  )

  useEffect(() => {
    setSelectedClaudeManagerId((current) => {
      if (current && claudeManagers.some((manager) => manager.agentId === current)) {
        return current
      }
      return claudeManagers[0]?.agentId ?? ''
    })
  }, [claudeManagers])

  const handleThemePreferenceChange = useCallback((nextPreference: ThemePreference) => {
    setThemePreference(nextPreference)
    applyThemePreference(nextPreference)
  }, [])

  const loadClaudeOutputStyle = useCallback(async (managerId: string) => {
    const requestId = ++claudeOutputStyleRequestIdRef.current
    setIsLoadingClaudeOutputStyle(true)
    setClaudeOutputStyleError(null)
    try {
      const state = await fetchClaudeOutputStyle(wsUrl, managerId)
      if (
        requestId !== claudeOutputStyleRequestIdRef.current ||
        managerId !== selectedClaudeManagerIdRef.current
      ) {
        return
      }
      setClaudeOutputStyleState(state)
    } catch (error) {
      if (
        requestId !== claudeOutputStyleRequestIdRef.current ||
        managerId !== selectedClaudeManagerIdRef.current
      ) {
        return
      }
      setClaudeOutputStyleState(null)
      setClaudeOutputStyleError(toErrorMessage(error))
    } finally {
      if (
        requestId === claudeOutputStyleRequestIdRef.current &&
        managerId === selectedClaudeManagerIdRef.current
      ) {
        setIsLoadingClaudeOutputStyle(false)
      }
    }
  }, [wsUrl])

  useEffect(() => {
    setIsSavingClaudeOutputStyle(false)

    if (!selectedClaudeManagerId) {
      setClaudeOutputStyleState(null)
      setClaudeOutputStyleError(null)
      setIsLoadingClaudeOutputStyle(false)
      return
    }

    void loadClaudeOutputStyle(selectedClaudeManagerId)
  }, [loadClaudeOutputStyle, selectedClaudeManagerId])

  const styleOptions = useMemo(() => {
    const options = new Set(claudeOutputStyleState?.availableStyles ?? [])
    if (claudeOutputStyleState?.selectedStyle) {
      options.add(claudeOutputStyleState.selectedStyle)
    }
    return Array.from(options)
  }, [claudeOutputStyleState])

  const selectedOutputStyleValue = claudeOutputStyleState?.selectedStyle ?? NO_OUTPUT_STYLE_VALUE

  const handleClaudeOutputStyleSelection = useCallback(async (value: string) => {
    if (!selectedClaudeManagerId) {
      return
    }

    const managerId = selectedClaudeManagerId
    const requestId = ++claudeOutputStyleRequestIdRef.current
    setIsSavingClaudeOutputStyle(true)
    setClaudeOutputStyleError(null)

    try {
      const nextValue = value === NO_OUTPUT_STYLE_VALUE ? null : value
      const updatedState = await updateClaudeOutputStyle(wsUrl, managerId, nextValue)
      if (
        requestId !== claudeOutputStyleRequestIdRef.current ||
        managerId !== selectedClaudeManagerIdRef.current
      ) {
        return
      }
      setClaudeOutputStyleState(updatedState)
    } catch (error) {
      if (
        requestId !== claudeOutputStyleRequestIdRef.current ||
        managerId !== selectedClaudeManagerIdRef.current
      ) {
        return
      }
      setClaudeOutputStyleError(toErrorMessage(error))
    } finally {
      if (
        requestId === claudeOutputStyleRequestIdRef.current &&
        managerId === selectedClaudeManagerIdRef.current
      ) {
        setIsSavingClaudeOutputStyle(false)
      }
    }
  }, [selectedClaudeManagerId, wsUrl])

  const isStyleSelectDisabled =
    !selectedClaudeManagerId || isLoadingClaudeOutputStyle || isSavingClaudeOutputStyle

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        label="Appearance"
        description="Customize how the app looks"
      >
        <SettingsWithCTA
          label="Theme"
          description="Choose between light, dark, or system theme"
        >
          <Select
            value={themePreference}
            onValueChange={(value) => {
              if (value === 'light' || value === 'dark' || value === 'auto') {
                handleThemePreferenceChange(value)
              }
            }}
          >
            <SelectTrigger aria-label="Theme" className="w-full sm:w-48">
              <SelectValue placeholder="Select theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">
                <span className="inline-flex items-center gap-2">
                  <Sun className="size-3.5" />
                  Light
                </span>
              </SelectItem>
              <SelectItem value="dark">
                <span className="inline-flex items-center gap-2">
                  <Moon className="size-3.5" />
                  Dark
                </span>
              </SelectItem>
              <SelectItem value="auto">
                <span className="inline-flex items-center gap-2">
                  <Monitor className="size-3.5" />
                  System
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="System"
        description="Manage the Nexus daemon"
      >
        <SettingsWithCTA
          label="Reboot"
          description="Restart the Nexus daemon and all agents"
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const endpoint = resolveApiEndpoint(wsUrl, '/api/reboot')
              void fetch(endpoint, { method: 'POST' }).catch(() => {})
            }}
          >
            <RotateCcw className="size-3.5 mr-1.5" />
            Reboot
          </Button>
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="Manager Runtime"
        description="Configure explicit model descriptor settings for existing managers. Model and thinking level can also be changed from the chat input toolbar."
      >
        {managerOptions.length === 0 ? (
          <SettingsWithCTA
            label="Manager"
            description="No managers are available."
          >
            <span className="text-xs text-muted-foreground">Create a manager to configure runtime settings.</span>
          </SettingsWithCTA>
        ) : (
          <>
            <SettingsWithCTA
              label="Manager"
              description="Choose which manager to configure"
            >
              <Select
                value={selectedRuntimeManagerId}
                onValueChange={(value) => {
                  setSelectedRuntimeManagerId(value)
                }}
                disabled={isSavingRuntimeSettings}
              >
                <SelectTrigger aria-label="Manager runtime manager" className="w-full sm:w-72">
                  <SelectValue placeholder="Select manager" />
                </SelectTrigger>
                <SelectContent>
                  {managerOptions.map((manager) => (
                    <SelectItem key={manager.agentId} value={manager.agentId}>
                      {manager.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsWithCTA>

            <SettingsWithCTA
              label="Provider"
              description="Choose the runtime provider"
            >
              <Select
                value={runtimeDraft?.provider ?? ''}
                onValueChange={handleRuntimeProviderChange}
                disabled={isSavingRuntimeSettings || isLoadingRuntimeCatalog || !runtimeDraft || runtimeProviderOptions.length === 0}
              >
                <SelectTrigger aria-label="Manager runtime provider" className="w-full sm:w-72">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {runtimeProviderOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsWithCTA>

            <SettingsWithCTA
              label="Model"
              description="Available models depend on selected provider"
            >
              <Select
                value={runtimeDraft?.modelId ?? ''}
                onValueChange={handleRuntimeModelChange}
                disabled={isSavingRuntimeSettings || isLoadingRuntimeCatalog || !runtimeDraft || runtimeModelOptions.length === 0}
              >
                <SelectTrigger aria-label="Manager runtime model" className="w-full sm:w-72">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {runtimeModelOptions.map((option) => (
                    <SelectItem key={`${runtimeDraft?.provider ?? 'provider'}:${option.value}`} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsWithCTA>

            <SettingsWithCTA
              label="Thinking"
              description="Available levels depend on selected provider and model"
            >
              <Select
                value={runtimeDraft?.thinkingLevel ?? ''}
                onValueChange={(value) => handleRuntimeThinkingChange(value as ThinkingLevel)}
                disabled={isSavingRuntimeSettings || isLoadingRuntimeCatalog || !runtimeDraft || runtimeThinkingOptions.length === 0}
              >
                <SelectTrigger aria-label="Manager runtime thinking" className="w-full sm:w-72">
                  <SelectValue placeholder="Select thinking" />
                </SelectTrigger>
                <SelectContent>
                  {runtimeThinkingOptions.map((thinkingLevel) => (
                    <SelectItem key={thinkingLevel} value={thinkingLevel}>
                      {thinkingLevel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsWithCTA>

            <SettingsWithCTA
              label="Prompt override"
              description="Set an explicit manager prompt. Leave empty to clear override on save."
              direction="col"
            >
              <div className="flex w-full flex-col gap-2">
                <Textarea
                  aria-label="Manager runtime prompt override"
                  value={runtimeDraft?.promptOverride ?? ''}
                  onChange={(event) => {
                    handleRuntimePromptOverrideChange(event.target.value)
                  }}
                  disabled={isSavingRuntimeSettings || !runtimeDraft}
                  placeholder="Optional manager prompt override"
                  rows={5}
                />
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!runtimeDraft || isSavingRuntimeSettings || isLoadingRuntimeCatalog}
                    onClick={() => {
                      void handleSaveRuntimeSettings()
                    }}
                  >
                    {isSavingRuntimeSettings ? 'Saving...' : 'Save manager settings'}
                  </Button>
                </div>
              </div>
            </SettingsWithCTA>

            {runtimeSelectionHint ? (
              <p className="text-[11px] text-muted-foreground">{runtimeSelectionHint}</p>
            ) : null}

            {isLoadingRuntimeCatalog ? (
              <p className="text-[11px] text-muted-foreground">Loading runtime model catalog...</p>
            ) : null}

            {!isLoadingRuntimeCatalog && runtimeCatalogError ? (
              <p className="text-xs text-destructive">{runtimeCatalogError}</p>
            ) : null}

            {!isLoadingRuntimeCatalog && !runtimeCatalogError && runtimeProviderOptions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No runtime model options are available right now.
              </p>
            ) : null}

            {!isLoadingRuntimeCatalog && runtimeCatalog.warnings.length > 0 ? (
              <p className="text-[11px] text-amber-700">
                {runtimeCatalog.warnings.join(' ')}
              </p>
            ) : null}

            {runtimeSaveError ? (
              <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                <p className="text-xs text-destructive">{runtimeSaveError}</p>
              </div>
            ) : null}

            {runtimeSaveSuccess ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
                <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <p className="text-xs text-emerald-600 dark:text-emerald-400">{runtimeSaveSuccess}</p>
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>

      <SettingsSection
        label="Worker Spawn Defaults"
        description="Configure the default model for worker agents spawned by a manager. When not set, workers inherit the manager's runtime model."
      >
        {managerOptions.length === 0 ? (
          <SettingsWithCTA
            label="Manager"
            description="No managers are available."
          >
            <span className="text-xs text-muted-foreground">Create a manager to configure spawn defaults.</span>
          </SettingsWithCTA>
        ) : (
          <>
            <SettingsWithCTA
              label="Manager"
              description="Choose which manager to configure"
            >
              <Select
                value={selectedSpawnManagerId}
                onValueChange={(value) => {
                  setSelectedSpawnManagerId(value)
                }}
                disabled={isSavingSpawnSettings}
              >
                <SelectTrigger aria-label="Spawn default manager" className="w-full sm:w-72">
                  <SelectValue placeholder="Select manager" />
                </SelectTrigger>
                <SelectContent>
                  {managerOptions.map((manager) => (
                    <SelectItem key={manager.agentId} value={manager.agentId}>
                      {manager.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsWithCTA>

            <SettingsWithCTA
              label="Provider"
              description="Choose the provider for spawned workers"
            >
              <Select
                value={spawnDraft?.provider ?? ''}
                onValueChange={handleSpawnProviderChange}
                disabled={isSavingSpawnSettings || isLoadingRuntimeCatalog || !spawnDraft || spawnProviderOptions.length === 0}
              >
                <SelectTrigger aria-label="Spawn default provider" className="w-full sm:w-72">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {spawnProviderOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsWithCTA>

            <SettingsWithCTA
              label="Model"
              description="Available models depend on selected provider"
            >
              <Select
                value={spawnDraft?.modelId ?? ''}
                onValueChange={handleSpawnModelChange}
                disabled={isSavingSpawnSettings || isLoadingRuntimeCatalog || !spawnDraft || spawnModelOptions.length === 0}
              >
                <SelectTrigger aria-label="Spawn default model" className="w-full sm:w-72">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {spawnModelOptions.map((option) => (
                    <SelectItem key={`${spawnDraft?.provider ?? 'provider'}:${option.value}`} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsWithCTA>

            <SettingsWithCTA
              label="Thinking"
              description="Available levels depend on selected provider and model"
            >
              <Select
                value={spawnDraft?.thinkingLevel ?? ''}
                onValueChange={(value) => handleSpawnThinkingChange(value as ThinkingLevel)}
                disabled={isSavingSpawnSettings || isLoadingRuntimeCatalog || !spawnDraft || spawnThinkingOptions.length === 0}
              >
                <SelectTrigger aria-label="Spawn default thinking" className="w-full sm:w-72">
                  <SelectValue placeholder="Select thinking" />
                </SelectTrigger>
                <SelectContent>
                  {spawnThinkingOptions.map((thinkingLevel) => (
                    <SelectItem key={thinkingLevel} value={thinkingLevel}>
                      {thinkingLevel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsWithCTA>

            <div className="flex justify-end gap-2">
              {isSpawnDefaultSet ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!spawnDraft || isSavingSpawnSettings}
                  onClick={() => {
                    void handleClearSpawnDefault()
                  }}
                >
                  Clear default
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={!spawnDraft || isSavingSpawnSettings || isLoadingRuntimeCatalog}
                onClick={() => {
                  void handleSaveSpawnDefault()
                }}
              >
                {isSavingSpawnSettings ? 'Saving...' : 'Save spawn default'}
              </Button>
            </div>

            {spawnSelectionHint ? (
              <p className="text-[11px] text-muted-foreground">{spawnSelectionHint}</p>
            ) : null}

            {isLoadingRuntimeCatalog ? (
              <p className="text-[11px] text-muted-foreground">Loading model catalog...</p>
            ) : null}

            {!isLoadingRuntimeCatalog && spawnProviderOptions.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No spawn model options are available right now.
              </p>
            ) : null}

            {!isLoadingRuntimeCatalog && spawnCatalog.warnings.length > 0 ? (
              <p className="text-[11px] text-amber-700">
                {spawnCatalog.warnings.join(' ')}
              </p>
            ) : null}

            {spawnSaveError ? (
              <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                <p className="text-xs text-destructive">{spawnSaveError}</p>
              </div>
            ) : null}

            {spawnSaveSuccess ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
                <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <p className="text-xs text-emerald-600 dark:text-emerald-400">{spawnSaveSuccess}</p>
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>

      <SettingsSection
        label="Claude"
        description="Configure manager-level Claude output style"
      >
        {claudeManagers.length === 0 ? (
          <SettingsWithCTA
            label="Output style"
            description="No Claude managers are available."
          >
            <span className="text-xs text-muted-foreground">Create or switch a manager to claude-agent-sdk.</span>
          </SettingsWithCTA>
        ) : (
          <>
            <SettingsWithCTA
              label="Manager"
              description="Choose which Claude manager to configure"
            >
              <Select
                value={selectedClaudeManagerId}
                onValueChange={(value) => {
                  setSelectedClaudeManagerId(value)
                }}
              >
                <SelectTrigger aria-label="Claude manager" className="w-full sm:w-72">
                  <SelectValue placeholder="Select manager" />
                </SelectTrigger>
                <SelectContent>
                  {claudeManagers.map((manager) => (
                    <SelectItem key={manager.agentId} value={manager.agentId}>
                      {manager.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsWithCTA>

            <SettingsWithCTA
              label="Output style"
              description="Selecting a style disables manager promptOverride and archetype base prompt."
            >
              <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto">
                <Select
                  value={selectedOutputStyleValue}
                  onValueChange={(value) => {
                    void handleClaudeOutputStyleSelection(value)
                  }}
                  disabled={isStyleSelectDisabled}
                >
                  <SelectTrigger aria-label="Claude output style" className="w-full sm:w-72">
                    <SelectValue
                      placeholder={isLoadingClaudeOutputStyle ? 'Loading styles...' : 'Select output style'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_OUTPUT_STYLE_VALUE}>Default (no style)</SelectItem>
                    {styleOptions.map((style) => (
                      <SelectItem key={style} value={style}>
                        {style}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selectedClaudeManagerId || isLoadingClaudeOutputStyle || isSavingClaudeOutputStyle}
                    onClick={() => {
                      if (!selectedClaudeManagerId) return
                      void loadClaudeOutputStyle(selectedClaudeManagerId)
                    }}
                  >
                    Refresh styles
                  </Button>
                </div>
              </div>
            </SettingsWithCTA>

            {claudeOutputStyleState?.warning ? (
              <p className="text-xs text-amber-700">{claudeOutputStyleState.warning}</p>
            ) : null}

            {claudeOutputStyleError ? (
              <p className="text-xs text-red-600">{claudeOutputStyleError}</p>
            ) : null}
          </>
        )}
      </SettingsSection>
    </div>
  )
}
