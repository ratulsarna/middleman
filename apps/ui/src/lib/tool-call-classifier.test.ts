import { describe, expect, it } from 'vitest'
import { classifyToolCall } from './tool-call-classifier'

describe('classifyToolCall', () => {
  it('classifies known callable tools with category metadata', () => {
    expect(
      classifyToolCall('exec_command', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'shell',
      displayKind: 'callable-shell',
    })

    expect(
      classifyToolCall('mcp__linear__list_issues', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'mcp',
      displayKind: 'callable-mcp',
    })

    expect(
      classifyToolCall('item/tool/call', {
        entryType: 'conversation_log',
        eventKind: 'tool_execution_start',
        source: 'runtime_log',
      }),
    ).toMatchObject({
      callable: true,
    })

    expect(
      classifyToolCall('WebSearch', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'web',
    })

    expect(
      classifyToolCall('mcp__linear__*', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'mcp',
    })

    expect(
      classifyToolCall('command_execution', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'shell',
    })

    expect(
      classifyToolCall('file_change', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'file',
    })

    expect(
      classifyToolCall('web_search', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'web',
    })

    expect(
      classifyToolCall('image_view', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'image',
    })

    expect(
      classifyToolCall('mcp:linear/list_issues', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'mcp',
    })

    expect(
      classifyToolCall('attach', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'file',
    })

    expect(
      classifyToolCall('artifacts', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'file',
    })

    expect(
      classifyToolCall('extract_document', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'file',
    })
  })

  it('classifies known non-callable labels as excluded', () => {
    for (const label of [
      'mcp_tool_call_begin',
      'item/started',
      'codex/event/tool_execution_start',
      'webSearch',
    ]) {
      const classification = classifyToolCall(label, {
        entryType: 'conversation_log',
        eventKind: 'tool_execution_update',
        source: 'runtime_log',
      })

      expect(classification.callable).toBe(false)
      expect(classification.displayKind).toContain('non-callable')
    }

    expect(
      classifyToolCall('mcp:linear/list_issues', {
        entryType: 'conversation_log',
        eventKind: 'tool_execution_update',
        source: 'runtime_log',
      }),
    ).toMatchObject({
      callable: false,
      category: 'mcp',
    })
  })

  it('resolves request_user_input ambiguity with context-first rules', () => {
    expect(
      classifyToolCall('request_user_input', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'input',
    })

    expect(
      classifyToolCall('request_user_input', {
        entryType: 'conversation_log',
        eventKind: 'tool_execution_update',
        source: 'runtime_log',
      }),
    ).toMatchObject({
      callable: false,
      category: 'input',
    })
  })

  it('uses deterministic unknown fallback without crashing', () => {
    const first = classifyToolCall('future_dynamic_tool_x', {
      entryType: 'agent_tool_call',
      eventKind: 'tool_execution_start',
    })

    const second = classifyToolCall('future_dynamic_tool_x', {
      entryType: 'agent_tool_call',
      eventKind: 'tool_execution_start',
    })

    expect(first).toMatchObject({
      callable: true,
      category: 'unknown',
      displayKind: 'callable-unknown',
    })
    expect(second).toEqual(first)
  })

  it('keeps javascript_repl on callable unknown fallback for PI compatibility', () => {
    expect(
      classifyToolCall('javascript_repl', {
        entryType: 'agent_tool_call',
        eventKind: 'tool_execution_start',
      }),
    ).toMatchObject({
      callable: true,
      category: 'unknown',
      displayKind: 'callable-unknown',
    })
  })
})
