import type { ConversationEntry } from '@nexus/protocol'

export type ToolCallCategory =
  | 'shell'
  | 'file'
  | 'agent'
  | 'mcp'
  | 'web'
  | 'image'
  | 'plan'
  | 'input'
  | 'unknown'

export interface ToolCallClassification {
  callable: boolean
  category: ToolCallCategory
  displayKind: string
  normalizedName: string
}

export interface ToolCallClassificationContext {
  entryType: Extract<ConversationEntry, { type: 'agent_tool_call' | 'conversation_log' }>['type']
  eventKind: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'
  source?: string
  toolCallId?: string
}

const CALLABLE_EXACT_CATEGORY = new Map<string, ToolCallCategory>([
  ['exec_command', 'shell'],
  ['write_stdin', 'shell'],
  ['shell', 'shell'],
  ['shell_command', 'shell'],
  ['container.exec', 'shell'],
  ['local_shell', 'shell'],
  ['bash', 'shell'],
  ['bashoutput', 'shell'],
  ['killbash', 'shell'],

  ['read', 'file'],
  ['write', 'file'],
  ['edit', 'file'],
  ['glob', 'file'],
  ['grep', 'file'],
  ['apply_patch', 'file'],
  ['js_repl', 'file'],
  ['js_repl_reset', 'file'],
  ['grep_files', 'file'],
  ['read_file', 'file'],
  ['list_dir', 'file'],
  ['notebookedit', 'file'],
  ['attach', 'file'],
  ['artifacts', 'file'],
  ['extract_document', 'file'],

  ['webfetch', 'web'],
  ['websearch', 'web'],
  ['search_tool_bm25', 'web'],

  ['view_image', 'image'],

  ['update_plan', 'plan'],
  ['todo_write', 'plan'],
  ['todowrite', 'plan'],
  ['exit_plan_mode', 'plan'],
  ['exitplanmode', 'plan'],

  ['request_user_input', 'input'],
  ['ask_user_question', 'input'],
  ['askuserquestion', 'input'],
  ['item/tool/requestuserinput', 'input'],

  ['task', 'agent'],
  ['task_output', 'agent'],
  ['taskoutput', 'agent'],
  ['task_stop', 'agent'],
  ['taskstop', 'agent'],
  ['bash_output', 'shell'],
  ['kill_bash', 'shell'],
  ['config', 'agent'],
  ['enter_worktree', 'agent'],
  ['enterworktree', 'agent'],
  ['spawn_agent', 'agent'],
  ['send_input', 'agent'],
  ['resume_agent', 'agent'],
  ['wait', 'agent'],
  ['close_agent', 'agent'],
  ['spawn_agents_on_csv', 'agent'],
  ['report_agent_job_result', 'agent'],
  ['send_message_to_agent', 'agent'],
  ['list_agents', 'agent'],
  ['kill_agent', 'agent'],
  ['speak_to_user', 'agent'],

  ['list_mcp_resources', 'mcp'],
  ['list_mcp_resource_templates', 'mcp'],
  ['read_mcp_resource', 'mcp'],
  ['listmcpresources', 'mcp'],
  ['readmcpresource', 'mcp'],

  ['item/tool/call', 'unknown'],
  ['test_sync_tool', 'unknown'],
])

const NON_CALLABLE_EXACT = new Set<string>([
  'mcp_tool_call_begin',
  'mcp_tool_call_end',
  'exec_command_begin',
  'exec_command_end',
  'dynamic_tool_call_request',
  'dynamic_tool_call_response',
  'plan_update',
  'task_started',
  'task_complete',

  'item/started',
  'item/completed',
  'item/mcptoolcall/progress',
  'item/dynamictoolcall/request',
  'item/dynamictoolcall/response',
  'item/agentmessage/delta',
  'item/commandexecution/outputdelta',
  'item/filechange/outputdelta',

  'mcptoolcall',
  'dynamictoolcall',
  'collabagenttoolcall',
])

function normalizeName(toolName: string | undefined): string {
  return toolName?.trim().toLowerCase() ?? ''
}

function normalizeDisplayKind(callable: boolean, category: ToolCallCategory): string {
  if (!callable) {
    return category === 'unknown' ? 'non-callable-unknown' : `non-callable-${category}`
  }

  return category === 'unknown' ? 'callable-unknown' : `callable-${category}`
}

function isCaseSensitiveNonCallableLabel(toolName: string | undefined): boolean {
  return (
    toolName === 'webSearch' ||
    toolName === 'imageView' ||
    toolName === 'mcpToolCall' ||
    toolName === 'dynamicToolCall' ||
    toolName === 'collabAgentToolCall'
  )
}

function isNonCallablePattern(name: string): boolean {
  return (
    name.startsWith('codex/event/') ||
    /^collab_.*_(begin|end)$/.test(name) ||
    /^(mcp_tool_call|exec_command|dynamic_tool_call)_?(begin|end)$/.test(name)
  )
}

function isMcpCallablePattern(name: string): boolean {
  return /^mcp__[^_]+__.+$/.test(name)
}

function hasToolCallContext(context: ToolCallClassificationContext): boolean {
  return context.entryType === 'agent_tool_call' || Boolean(context.toolCallId?.trim())
}

function codexToolLikeCategoryForName(name: string): ToolCallCategory | undefined {
  if (name === 'command_execution') return 'shell'
  if (name === 'file_change') return 'file'
  if (name === 'web_search') return 'web'
  if (name === 'image_view') return 'image'
  if (/^mcp:[^/]+\/.+/.test(name)) return 'mcp'

  return undefined
}

function isRequestUserInputTelemetryLabel(
  name: string,
  context: ToolCallClassificationContext,
): boolean {
  if (name !== 'request_user_input') {
    return false
  }

  return (
    context.entryType === 'conversation_log' &&
    context.source === 'runtime_log' &&
    !context.toolCallId?.trim() &&
    context.eventKind === 'tool_execution_update'
  )
}

export function classifyToolCall(
  toolName: string | undefined,
  context: ToolCallClassificationContext,
): ToolCallClassification {
  const normalizedName = normalizeName(toolName)
  const hasContext = hasToolCallContext(context)

  if (isRequestUserInputTelemetryLabel(normalizedName, context)) {
    const category: ToolCallCategory = 'input'
    return {
      callable: false,
      category,
      displayKind: normalizeDisplayKind(false, category),
      normalizedName,
    }
  }

  if (normalizedName.length === 0) {
    const category: ToolCallCategory = 'unknown'
    return {
      callable: true,
      category,
      displayKind: normalizeDisplayKind(true, category),
      normalizedName,
    }
  }

  if (
    isCaseSensitiveNonCallableLabel(toolName) ||
    NON_CALLABLE_EXACT.has(normalizedName) ||
    isNonCallablePattern(normalizedName)
  ) {
    const category: ToolCallCategory = 'unknown'
    return {
      callable: false,
      category,
      displayKind: normalizeDisplayKind(false, category),
      normalizedName,
    }
  }

  const codexToolLikeCategory = codexToolLikeCategoryForName(normalizedName)
  if (codexToolLikeCategory) {
    return {
      callable: hasContext,
      category: codexToolLikeCategory,
      displayKind: normalizeDisplayKind(hasContext, codexToolLikeCategory),
      normalizedName,
    }
  }

  if (isMcpCallablePattern(normalizedName)) {
    const category: ToolCallCategory = 'mcp'
    return {
      callable: true,
      category,
      displayKind: normalizeDisplayKind(true, category),
      normalizedName,
    }
  }

  const exactCategory = CALLABLE_EXACT_CATEGORY.get(normalizedName)
  if (exactCategory) {
    return {
      callable: true,
      category: exactCategory,
      displayKind: normalizeDisplayKind(true, exactCategory),
      normalizedName,
    }
  }

  const category: ToolCallCategory = 'unknown'
  return {
    callable: true,
    category,
    displayKind: normalizeDisplayKind(true, category),
    normalizedName,
  }
}
