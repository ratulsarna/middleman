import type { ConversationEntry } from '@nexus/protocol'

type ToolExecutionKind = 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'

type ToolExecutionConversationLog = Extract<ConversationEntry, { type: 'conversation_log' }> & {
  kind: ToolExecutionKind
}

export const PI_TOOL_CALL_ID_FIXTURES = {
  empty: '   ',
  pipeA: 'call-edge|item-a',
  pipeB: 'call-edge|item-b',
  long: `call-${'x'.repeat(384)}`,
} as const

export function piToolLogEvent(
  overrides: Partial<ToolExecutionConversationLog> = {},
): ToolExecutionConversationLog {
  return {
    type: 'conversation_log',
    agentId: 'manager',
    timestamp: '2026-03-03T10:00:00.000Z',
    source: 'runtime_log',
    kind: 'tool_execution_start',
    toolName: 'exec_command',
    toolCallId: 'call-1',
    text: '{}',
    ...overrides,
  }
}
