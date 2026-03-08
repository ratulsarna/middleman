import { useMemo } from 'react'
import { ChevronDown } from 'lucide-react'
import type { AgentDescriptor, ThinkingLevel } from '@nexus/protocol'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  getCatalogAllowedThinkingLevels,
  getCatalogModelOptions,
  type CreateManagerCatalog,
} from '@/lib/manager-model-catalog-api'
import { cn } from '@/lib/utils'

interface ComposerModelSelectorProps {
  activeAgent: AgentDescriptor | null
  catalog: CreateManagerCatalog | null
  disabled: boolean
  onModelChange: (modelId: string) => void
  onThinkingLevelChange: (thinkingLevel: ThinkingLevel) => void
}

const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'Max',
}

function abbreviateModelLabel(label: string): string {
  // Remove common prefixes for display compactness
  return label
    .replace(/^claude-/i, '')
    .replace(/^gpt-/i, 'gpt-')
}

export function ComposerModelSelector({
  activeAgent,
  catalog,
  disabled,
  onModelChange,
  onThinkingLevelChange,
}: ComposerModelSelectorProps) {
  const provider = activeAgent?.model.provider
  const currentModelId = activeAgent?.model.modelId
  const currentThinkingLevel = activeAgent?.model.thinkingLevel

  const modelOptions = useMemo(() => {
    if (!catalog || !provider) return []
    return getCatalogModelOptions(catalog, provider)
  }, [catalog, provider])

  const thinkingOptions = useMemo(() => {
    if (!catalog || !provider || !currentModelId) return []
    return getCatalogAllowedThinkingLevels(catalog, provider, currentModelId)
  }, [catalog, provider, currentModelId])

  if (!activeAgent || !catalog || !currentModelId || !currentThinkingLevel) {
    return null
  }

  const currentModelLabel = modelOptions.find((opt) => opt.value === currentModelId)?.label ?? currentModelId
  const displayModelLabel = abbreviateModelLabel(currentModelLabel)
  const displayThinkingLabel = THINKING_LEVEL_LABELS[currentThinkingLevel] ?? currentThinkingLevel

  const isDisabled = disabled || modelOptions.length === 0

  return (
    <div className="flex items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-6 gap-0.5 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground/70 hover:text-foreground',
              isDisabled && 'pointer-events-none opacity-50',
            )}
            disabled={isDisabled}
          >
            <span className="max-w-[80px] truncate">{displayModelLabel}</span>
            <ChevronDown className="size-2.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="min-w-40">
          <DropdownMenuRadioGroup
            value={currentModelId}
            onValueChange={onModelChange}
          >
            {modelOptions.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {thinkingOptions.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                'h-6 gap-0.5 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground/70 hover:text-foreground',
                isDisabled && 'pointer-events-none opacity-50',
              )}
              disabled={isDisabled}
            >
              <span>{displayThinkingLabel}</span>
              <ChevronDown className="size-2.5 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6} className="min-w-32">
            <DropdownMenuRadioGroup
              value={currentThinkingLevel}
              onValueChange={(value) => onThinkingLevelChange(value as ThinkingLevel)}
            >
              {thinkingOptions.map((level) => (
                <DropdownMenuRadioItem key={level} value={level}>
                  {THINKING_LEVEL_LABELS[level] ?? level}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
