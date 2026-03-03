import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ToolCallCategory } from '@/lib/tool-call-classifier'
import { ToolLogRow } from './ToolLogRow'
import type { ToolExecutionDisplayEntry } from './types'

type ToolRowOverrides = Partial<ToolExecutionDisplayEntry> & {
  category?: ToolCallCategory
}

function renderToolRow(overrides: ToolRowOverrides = {}): string {
  const category = overrides.category ?? 'unknown'

  const entry: ToolExecutionDisplayEntry = {
    id: 'tool-row-1',
    actorAgentId: 'worker-1',
    toolName: 'future_tool_xyz',
    toolCallId: 'call-1',
    callable: true,
    classification: {
      callable: true,
      category,
      displayKind: category === 'unknown' ? 'callable-unknown' : `callable-${category}`,
      normalizedName: 'future_tool_xyz',
    },
    inputPayload: '{}',
    latestPayload: '{}',
    outputPayload: '{"ok":true}',
    timestamp: '2026-03-03T11:00:00.000Z',
    latestKind: 'tool_execution_end',
    isError: false,
    ...overrides,
  }

  return renderToStaticMarkup(
    createElement(ToolLogRow, {
      type: 'tool_execution',
      entry,
    }),
  )
}

describe('ToolLogRow', () => {
  it('renders category-first completed summaries for known categories', () => {
    const expectations: Array<{ category: ToolCallCategory; expectedText: string }> = [
      { category: 'shell', expectedText: 'Ran shell command' },
      { category: 'file', expectedText: 'Ran file operation' },
      { category: 'agent', expectedText: 'Ran agent task' },
      { category: 'mcp', expectedText: 'Ran MCP tool' },
      { category: 'web', expectedText: 'Ran web tool' },
      { category: 'image', expectedText: 'Ran image tool' },
      { category: 'plan', expectedText: 'Updated plan' },
      { category: 'input', expectedText: 'Requested user input' },
    ]

    for (const item of expectations) {
      const html = renderToolRow({
        category: item.category,
        toolName: `tool-${item.category}`,
        classification: {
          callable: true,
          category: item.category,
          displayKind: `callable-${item.category}`,
          normalizedName: `tool-${item.category}`,
        },
      })

      expect(html).toContain(item.expectedText)
    }
  })

  it('uses category-first pending and error status messaging', () => {
    const pendingHtml = renderToolRow({
      category: 'web',
      toolName: 'web_search',
      latestKind: 'tool_execution_start',
      latestPayload: '{"query":"vite docs"}',
      outputPayload: undefined,
      isError: false,
      classification: {
        callable: true,
        category: 'web',
        displayKind: 'callable-web',
        normalizedName: 'web_search',
      },
    })

    expect(pendingHtml).toContain('Running web tool')

    const errorHtml = renderToolRow({
      category: 'mcp',
      toolName: 'mcp__linear__list_issues',
      latestKind: 'tool_execution_end',
      outputPayload: 'request timeout',
      latestPayload: 'request timeout',
      isError: true,
      classification: {
        callable: true,
        category: 'mcp',
        displayKind: 'callable-mcp',
        normalizedName: 'mcp__linear__list_issues',
      },
    })

    expect(errorHtml).toContain('MCP tool failed')
  })

  it('appends tool detail while keeping category-first summaries', () => {
    const html = renderToolRow({
      category: 'shell',
      toolName: 'command_execution',
      inputPayload: '{"command":"pnpm test"}',
      latestPayload: '{"command":"pnpm test"}',
      outputPayload: '{"ok":true}',
      latestKind: 'tool_execution_end',
      classification: {
        callable: true,
        category: 'shell',
        displayKind: 'callable-shell',
        normalizedName: 'command_execution',
      },
    })

    expect(html).toContain('Ran shell command: pnpm test')
  })

  it('keeps unknown category fallback robust and readable', () => {
    const html = renderToolRow({
      category: 'unknown',
      toolName: 'future_tool_xyz',
      classification: {
        callable: true,
        category: 'unknown',
        displayKind: 'callable-unknown',
        normalizedName: 'future_tool_xyz',
      },
    })

    expect(html).toContain('Ran tool: future tool xyz')
  })

  it('preserves cancelled status behavior', () => {
    const html = renderToolRow({
      category: 'agent',
      toolName: 'send_message_to_agent',
      latestKind: 'tool_execution_end',
      outputPayload: '[aborted] cancelled by user',
      latestPayload: '[aborted] cancelled by user',
      isError: true,
      classification: {
        callable: true,
        category: 'agent',
        displayKind: 'callable-agent',
        normalizedName: 'send_message_to_agent',
      },
    })

    expect(html).toContain('Agent task cancelled')
  })

  it('treats skipped tool outputs as cancelled', () => {
    const html = renderToolRow({
      category: 'file',
      toolName: 'extract_document',
      latestKind: 'tool_execution_end',
      outputPayload: '{"message":"Skipped due to queued user message."}',
      latestPayload: '{"message":"Skipped due to queued user message."}',
      isError: true,
      classification: {
        callable: true,
        category: 'file',
        displayKind: 'callable-file',
        normalizedName: 'extract_document',
      },
    })

    expect(html).toContain('File operation cancelled')
  })
})
