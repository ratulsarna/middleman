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
  getManagerSettingsAllowedThinkingLevels,
  getManagerSettingsDefaultModelForProvider,
  getManagerSettingsDefaultThinkingLevel,
  getManagerSettingsModelOptions,
  getManagerSettingsProviderLabel,
  getManagerSettingsProviderOptions,
  isSupportedManagerSettingsDescriptor,
} from '@/lib/manager-settings-model-catalog'
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
  const [runtimeDraft, setRuntimeDraft] = useState<ManagerRuntimeDraft | null>(null)
  const [runtimeSelectionHint, setRuntimeSelectionHint] = useState<string | null>(null)
  const [runtimeSaveError, setRuntimeSaveError] = useState<string | null>(null)
  const [runtimeSaveSuccess, setRuntimeSaveSuccess] = useState<string | null>(null)
  const [isSavingRuntimeSettings, setIsSavingRuntimeSettings] = useState(false)
  const runtimeSaveRequestIdRef = useRef(0)
  const previousRuntimeManagerIdRef = useRef<string>('')
  const selectedRuntimeManagerIdRef = useRef('')
  selectedRuntimeManagerIdRef.current = selectedRuntimeManagerId

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

  const runtimeProviderOptions = useMemo(() => {
    const options = getManagerSettingsProviderOptions()
    const currentProvider = runtimeDraft?.provider
    if (!currentProvider || options.some((option) => option.value === currentProvider)) {
      return options
    }

    return [
      ...options,
      {
        value: currentProvider,
        label: `${getManagerSettingsProviderLabel(currentProvider)} (unsupported)`,
      },
    ]
  }, [runtimeDraft?.provider])

  const runtimeModelOptions = useMemo(() => {
    if (!runtimeDraft) {
      return []
    }

    const options = getManagerSettingsModelOptions(runtimeDraft.provider)
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
  }, [runtimeDraft])

  const runtimeThinkingOptions = useMemo(() => {
    if (!runtimeDraft) {
      return []
    }

    const allowedThinkingLevels = getManagerSettingsAllowedThinkingLevels(
      runtimeDraft.provider,
      runtimeDraft.modelId,
    )

    if (allowedThinkingLevels.includes(runtimeDraft.thinkingLevel)) {
      return allowedThinkingLevels
    }

    return [...allowedThinkingLevels, runtimeDraft.thinkingLevel]
  }, [runtimeDraft])

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
        getManagerSettingsDefaultModelForProvider(nextProvider) ??
        getManagerSettingsModelOptions(nextProvider)[0]?.value ??
        current.modelId
      const shouldResetModel = nextModelId !== current.modelId

      const nextThinkingOptions = getManagerSettingsAllowedThinkingLevels(nextProvider, nextModelId)
      const defaultThinkingLevel = getManagerSettingsDefaultThinkingLevel(nextProvider, nextModelId)
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
  }, [resetRuntimeFeedback])

  const handleRuntimeModelChange = useCallback((nextModelId: string) => {
    setRuntimeDraft((current) => {
      if (!current) {
        return current
      }

      resetRuntimeFeedback()

      const nextThinkingOptions = getManagerSettingsAllowedThinkingLevels(current.provider, nextModelId)
      const defaultThinkingLevel = getManagerSettingsDefaultThinkingLevel(current.provider, nextModelId)
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
  }, [resetRuntimeFeedback])

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

    const descriptorSupported = isSupportedManagerSettingsDescriptor(
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
  }, [onUpdateManager, runtimeDraft, selectedRuntimeManager])

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
        description="Configure explicit model descriptor settings for existing managers"
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
                disabled={isSavingRuntimeSettings || !runtimeDraft}
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
                disabled={isSavingRuntimeSettings || !runtimeDraft || runtimeModelOptions.length === 0}
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
                disabled={isSavingRuntimeSettings || !runtimeDraft || runtimeThinkingOptions.length === 0}
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
                    disabled={!runtimeDraft || isSavingRuntimeSettings}
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
