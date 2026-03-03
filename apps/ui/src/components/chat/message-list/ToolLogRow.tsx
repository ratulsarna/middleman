import { useId, useState } from 'react'
import {
  AlertCircle,
  Boxes,
  Check,
  ChevronRight,
  FileText,
  Globe,
  Image,
  Loader2,
  ListTodo,
  MessageSquare,
  Terminal,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatTimestamp } from './message-row-utils'
import type { ToolCallCategory } from '@/lib/tool-call-classifier'
import type {
  ConversationLogEntry,
  ToolDisplayStatus,
  ToolExecutionDisplayEntry,
} from './types'

type ToolDetailConfig = {
  detailKeys?: string[]
  icon?: LucideIcon
  getDetail?: (input: Record<string, unknown>) => string | null
}

type CategoryMessageConfig = {
  label: string
  activeLabel: string
  cancelledLabel: string
  errorLabel: string
  icon: LucideIcon
}

const CATEGORY_MESSAGE_CONFIG: Record<ToolCallCategory, CategoryMessageConfig> = {
  shell: {
    label: 'Ran shell command',
    activeLabel: 'Running shell command',
    cancelledLabel: 'Shell command cancelled',
    errorLabel: 'Shell command failed',
    icon: Terminal,
  },
  file: {
    label: 'Ran file operation',
    activeLabel: 'Running file operation',
    cancelledLabel: 'File operation cancelled',
    errorLabel: 'File operation failed',
    icon: FileText,
  },
  agent: {
    label: 'Ran agent task',
    activeLabel: 'Running agent task',
    cancelledLabel: 'Agent task cancelled',
    errorLabel: 'Agent task failed',
    icon: Users,
  },
  mcp: {
    label: 'Ran MCP tool',
    activeLabel: 'Running MCP tool',
    cancelledLabel: 'MCP tool cancelled',
    errorLabel: 'MCP tool failed',
    icon: Boxes,
  },
  web: {
    label: 'Ran web tool',
    activeLabel: 'Running web tool',
    cancelledLabel: 'Web tool cancelled',
    errorLabel: 'Web tool failed',
    icon: Globe,
  },
  image: {
    label: 'Ran image tool',
    activeLabel: 'Running image tool',
    cancelledLabel: 'Image tool cancelled',
    errorLabel: 'Image tool failed',
    icon: Image,
  },
  plan: {
    label: 'Updated plan',
    activeLabel: 'Updating plan',
    cancelledLabel: 'Plan update cancelled',
    errorLabel: 'Plan update failed',
    icon: ListTodo,
  },
  input: {
    label: 'Requested user input',
    activeLabel: 'Requesting user input',
    cancelledLabel: 'User input request cancelled',
    errorLabel: 'User input request failed',
    icon: MessageSquare,
  },
  unknown: {
    label: 'Ran tool',
    activeLabel: 'Running tool',
    cancelledLabel: 'Tool cancelled',
    errorLabel: 'Tool failed',
    icon: Wrench,
  },
}

const TOOL_DETAIL_CONFIG: Record<string, ToolDetailConfig> = {
  bash: {
    detailKeys: ['description', 'command', 'cmd'],
    getDetail: (input) => {
      const command = pickString(input, ['description', 'command'])
      return command ? truncate(command, 72) : null
    },
  },
  exec_command: {
    detailKeys: ['description', 'command', 'cmd'],
  },
  command_execution: {
    detailKeys: ['description', 'command', 'cmd'],
  },
  read: {
    detailKeys: ['path'],
  },
  write: {
    detailKeys: ['path'],
  },
  edit: {
    detailKeys: ['path'],
  },
  file_change: {
    detailKeys: ['path'],
  },
  list_agents: {
    detailKeys: ['targetAgentId', 'agentId'],
  },
  send_message_to_agent: {
    detailKeys: ['targetAgentId', 'agentId'],
    getDetail: (input) => pickString(input, ['targetAgentId']) ?? null,
  },
  mcp__linear__list_issues: {
    detailKeys: ['query', 'project', 'team'],
  },
  mcp: {
    detailKeys: ['server', 'toolName'],
  },
}

const CATEGORY_DETAIL_KEYS: Partial<Record<ToolCallCategory, string[]>> = {
  shell: ['description', 'command', 'cmd'],
  file: ['path', 'targetPath', 'file'],
  agent: ['targetAgentId', 'agentId'],
  mcp: ['toolName', 'server', 'query'],
  web: ['query', 'url'],
  image: ['query', 'path', 'url'],
  plan: ['title', 'step'],
  input: ['prompt', 'question'],
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str
  }

  return `${str.slice(0, maxLen)}…`
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

function parseJsonRecord(input: string | undefined): Record<string, unknown> {
  if (!input) {
    return {}
  }

  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function formatPayload(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function humanizeToolName(toolName: string): string {
  return toolName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim()
}

function mapToolStatus(entry: ToolExecutionDisplayEntry): ToolDisplayStatus {
  if (entry.latestKind !== 'tool_execution_end') {
    return 'pending'
  }

  if (!entry.isError) {
    return 'completed'
  }

  const lowered = (entry.outputPayload ?? entry.latestPayload ?? '').toLowerCase()
  if (lowered.includes('[aborted]') || lowered.includes('cancel') || /\bskip(?:ped)?\b/.test(lowered)) {
    return 'cancelled'
  }

  return 'error'
}

function getFriendlyToolMessage(
  category: ToolCallCategory,
  toolName: string | undefined,
  input: Record<string, unknown>,
  status: ToolDisplayStatus,
): string {
  const config = CATEGORY_MESSAGE_CONFIG[category] ?? CATEGORY_MESSAGE_CONFIG.unknown

  const baseLabel =
    status === 'completed'
      ? config.label
      : status === 'cancelled'
        ? config.cancelledLabel
        : status === 'error'
        ? config.errorLabel
        : config.activeLabel

  const detail = getToolDetail(category, toolName, input)
  return detail ? `${baseLabel}: ${detail}` : baseLabel
}

function getToolDetail(
  category: ToolCallCategory,
  toolName: string | undefined,
  input: Record<string, unknown>,
): string | null {
  const normalizedToolName = (toolName ?? '').trim().toLowerCase()
  const toolConfig = normalizedToolName ? TOOL_DETAIL_CONFIG[normalizedToolName] : undefined

  const exactDetail = toolConfig?.getDetail?.(input)
  if (exactDetail) {
    return exactDetail
  }

  const keys = toolConfig?.detailKeys ?? CATEGORY_DETAIL_KEYS[category]
  const genericDetail = keys ? pickString(input, keys) : null
  if (genericDetail) {
    return truncate(genericDetail, 72)
  }

  if (category === 'unknown' && normalizedToolName.length > 0) {
    return truncate(humanizeToolName(normalizedToolName), 72)
  }

  return null
}

function ToolPayloadBlock({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: ToolDisplayStatus | 'neutral'
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <pre
        className={cn(
          'max-h-64 w-full overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words',
          tone === 'error'
            ? 'border-destructive/30 bg-destructive/10 text-destructive'
            : tone === 'cancelled'
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
              : 'border-border/70 bg-muted/45 text-foreground',
        )}
      >
        {formatPayload(value)}
      </pre>
    </div>
  )
}

function ToolExecutionLogRow({ entry }: { entry: ToolExecutionDisplayEntry }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const contentId = useId()

  const displayStatus = mapToolStatus(entry)
  const categoryConfig =
    CATEGORY_MESSAGE_CONFIG[entry.classification.category] ?? CATEGORY_MESSAGE_CONFIG.unknown
  const inputRecord = parseJsonRecord(entry.inputPayload ?? entry.latestPayload)
  const friendlyMessage = getFriendlyToolMessage(
    entry.classification.category,
    entry.toolName,
    inputRecord,
    displayStatus,
  )
  const actorLabel = entry.actorAgentId?.trim()

  const ToolIcon = categoryConfig.icon

  const outputPayload =
    entry.outputPayload ??
    (entry.latestPayload && entry.latestPayload !== entry.inputPayload
      ? entry.latestPayload
      : undefined)

  const outputLabel =
    displayStatus === 'pending'
      ? 'Update'
      : displayStatus === 'cancelled'
        ? 'Cancelled'
        : displayStatus === 'error'
          ? 'Error'
          : 'Result'

  return (
    <div className="rounded-md">
      <Button
        type="button"
        variant="ghost"
        className={cn(
          'group h-auto w-full items-start justify-start gap-1.5 rounded-md px-1 py-1 text-left text-sm font-normal text-foreground/70 italic transition-colors',
          'hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        )}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={() => setIsExpanded((previous) => !previous)}
      >
        <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
          {displayStatus === 'completed' ? (
            ToolIcon ? (
              <ToolIcon
                className="size-3.5 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            ) : (
              <Check
                className="size-3.5 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            )
          ) : displayStatus === 'cancelled' ? (
            <X className="size-3.5 text-rose-500 dark:text-rose-400" aria-hidden="true" />
          ) : displayStatus === 'error' ? (
            <AlertCircle className="size-3.5 text-destructive" aria-hidden="true" />
          ) : (
            <Loader2 className="size-3.5 animate-spin text-foreground/50" aria-hidden="true" />
          )}
        </span>

        <span className="min-w-0 flex-1 break-words">
          {actorLabel ? (
            <span className="mr-1.5 inline-flex items-center rounded-sm border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium not-italic text-muted-foreground">
              {actorLabel}
            </span>
          ) : null}
          {friendlyMessage}
        </span>

        <ChevronRight
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-muted-foreground/80 opacity-0 transition-all group-hover:opacity-100',
            isExpanded && 'rotate-90',
          )}
          aria-hidden="true"
        />
      </Button>

      <div
        id={contentId}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="ml-6 mt-1 space-y-2 pb-1">
            {entry.inputPayload ? (
              <ToolPayloadBlock label="Input" value={entry.inputPayload} tone="neutral" />
            ) : null}

            {outputPayload ? (
              <ToolPayloadBlock
                label={outputLabel}
                value={outputPayload}
                tone={displayStatus === 'pending' ? 'neutral' : displayStatus}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>{formatTimestamp(entry.timestamp)}</span>
              {actorLabel ? <span>• {actorLabel}</span> : null}
              {entry.toolName ? <span>• {entry.toolName}</span> : null}
              {entry.toolCallId ? <span>• {entry.toolCallId}</span> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function RuntimeErrorLog({ entry }: { entry: ConversationLogEntry }) {
  return (
    <div className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-destructive/80">
        Runtime error
      </div>
      <p className="whitespace-pre-wrap break-words leading-relaxed">{entry.text}</p>
    </div>
  )
}

export function ToolLogRow({
  type,
  entry,
}: {
  type: 'tool_execution' | 'runtime_error_log'
  entry: ToolExecutionDisplayEntry | ConversationLogEntry
}) {
  if (type === 'runtime_error_log') {
    return <RuntimeErrorLog entry={entry as ConversationLogEntry} />
  }

  return <ToolExecutionLogRow entry={entry as ToolExecutionDisplayEntry} />
}
