import { useId, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { MarkdownMessage } from '@/components/chat/MarkdownMessage'
import { cn } from '@/lib/utils'
import type { ArtifactReference } from '@/lib/artifacts'
import { MessageAttachments } from './MessageAttachments'
import { SourceBadge, formatTimestamp } from './message-row-utils'
import type { ConversationMessageEntry } from './types'

interface ConversationMessageRowProps {
  message: ConversationMessageEntry
  onArtifactClick?: (artifact: ArtifactReference) => void
}

export function ConversationMessageRow({
  message,
  onArtifactClick,
}: ConversationMessageRowProps) {
  const normalizedText = message.text.trim()
  const hasText = normalizedText.length > 0 && normalizedText !== '.'
  const attachments = message.attachments ?? []
  const thinking = message.role === 'assistant' ? message.thinking?.trim() : undefined
  const hasThinking = !!thinking && thinking.length > 0

  if (!hasText && attachments.length === 0 && !hasThinking) {
    return null
  }

  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext

  if (message.role === 'system') {
    return (
      <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-sm text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
        <div className="text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300/90">
          System
        </div>
        <div className="mt-1 space-y-2">
          {hasText ? (
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {normalizedText}
            </p>
          ) : null}
          <MessageAttachments attachments={attachments} isUser={false} />
        </div>
        {timestampLabel || sourceContext ? (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-700/80 dark:text-amber-300/80">
            <SourceBadge sourceContext={sourceContext} />
            {timestampLabel ? <span>{timestampLabel}</span> : null}
          </div>
        ) : null}
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-primary px-3 py-2 text-primary-foreground">
          <div className="space-y-2">
            <MessageAttachments attachments={attachments} isUser />
            {hasText ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {normalizedText}
              </p>
            ) : null}
          </div>
          {timestampLabel || sourceContext ? (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <SourceBadge sourceContext={sourceContext} isUser />
              {timestampLabel ? (
                <p className="text-right text-[10px] leading-none text-primary-foreground/70">
                  {timestampLabel}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-2 text-foreground">
      {hasThinking ? <ThinkingBlock thinking={thinking} /> : null}
      {hasText ? (
        <MarkdownMessage content={normalizedText} onArtifactClick={onArtifactClick} />
      ) : null}
      <MessageAttachments attachments={attachments} isUser={false} />
      {timestampLabel || sourceContext ? (
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground/70">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [isExpanded, setIsExpanded] = useState(true)
  const contentId = useId()

  return (
    <div className="rounded-lg border border-purple-300/40 bg-purple-50/50 dark:border-purple-400/20 dark:bg-purple-500/5">
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-left text-xs font-medium',
          'text-purple-700 dark:text-purple-300',
          'transition-colors hover:bg-purple-100/50 dark:hover:bg-purple-500/10',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        )}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        <Brain className="size-3.5 shrink-0" aria-hidden="true" />
        <span>Thinking</span>
        <ChevronRight
          className={cn(
            'ml-auto size-3 text-purple-500/70 transition-transform dark:text-purple-400/70',
            isExpanded && 'rotate-90',
          )}
          aria-hidden="true"
        />
      </button>
      <div
        id={contentId}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-2">
            <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-purple-900/80 dark:text-purple-100/70">
              {thinking}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}
