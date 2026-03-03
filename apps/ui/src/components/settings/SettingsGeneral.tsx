import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
} from '@/lib/theme'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import type { AgentDescriptor } from '@nexus/protocol'
import { fetchClaudeOutputStyle, toErrorMessage, updateClaudeOutputStyle } from './settings-api'
import type { ClaudeOutputStyleState } from './settings-types'

interface SettingsGeneralProps {
  wsUrl: string
  managers: AgentDescriptor[]
}

const NO_OUTPUT_STYLE_VALUE = '__none__'

export function SettingsGeneral({ wsUrl, managers }: SettingsGeneralProps) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readStoredThemePreference(),
  )
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
            <SelectTrigger className="w-full sm:w-48">
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
                <SelectTrigger className="w-full sm:w-72">
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
                  <SelectTrigger className="w-full sm:w-72">
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
