import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'
import type { RuntimeUserMessage, SwarmAgentRuntime } from '../swarm/runtime-types.js'

class FakeRuntime {
  readonly descriptor: AgentDescriptor
  private readonly sessionManager: SessionManager
  terminateCalls: Array<{ abort?: boolean } | undefined> = []
  stopInFlightCalls: Array<{ abort?: boolean } | undefined> = []
  sendCalls: Array<{ message: string | RuntimeUserMessage; delivery: RequestedDeliveryMode }> = []
  compactCalls: Array<string | undefined> = []
  nextDeliveryId = 0
  busy = false

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor
    this.sessionManager = SessionManager.open(descriptor.sessionFile)
  }

  getStatus(): AgentDescriptor['status'] {
    return this.descriptor.status
  }

  getPendingCount(): number {
    return this.busy ? 1 : 0
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined
  }

  async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sendCalls.push({ message, delivery })
    this.nextDeliveryId += 1
    this.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
    } as any)

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: `delivery-${this.nextDeliveryId}`,
      acceptedMode: this.busy ? 'steer' : 'prompt',
    }
  }

  async terminate(options?: { abort?: boolean }): Promise<void> {
    this.terminateCalls.push(options)
  }

  async stopInFlight(options?: { abort?: boolean }): Promise<void> {
    this.stopInFlightCalls.push(options)
    this.busy = false
    this.descriptor.status = 'idle'
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.compactCalls.push(customInstructions)
    return {
      status: 'ok',
      customInstructions: customInstructions ?? null,
    }
  }

  getCustomEntries(customType: string): unknown[] {
    const entries = this.sessionManager.getEntries()
    return entries
      .filter((entry) => entry.type === 'custom' && entry.customType === customType)
      .map((entry) => (entry.type === 'custom' ? entry.data : undefined))
      .filter((entry) => entry !== undefined)
  }

  appendCustomEntry(customType: string, data?: unknown): void {
    this.sessionManager.appendCustomEntry(customType, data)
  }
}

class ResumeInspectingRuntime extends FakeRuntime {
  readonly resumedProviderState: { provider: string; resumeId: string } | null

  constructor(descriptor: AgentDescriptor) {
    super(descriptor)
    this.resumedProviderState = readPersistedResumeState(descriptor)
  }
}

class TestSwarmManager extends SwarmManager {
  readonly runtimeByAgentId = new Map<string, FakeRuntime>()
  readonly createdRuntimeIds: string[] = []
  readonly systemPromptByAgentId = new Map<string, string>()

  async getSwarmContextFilesForTest(cwd: string): Promise<Array<{ path: string; content: string }>> {
    return this.getSwarmContextFiles(cwd)
  }

  getLoadedConversationAgentIdsForTest(): string[] {
    const state = this as unknown as {
      conversationEntriesByAgentId: Map<string, unknown>
    }

    return Array.from(state.conversationEntriesByAgentId.keys()).sort((left, right) => left.localeCompare(right))
  }

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
  ): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(descriptor)
    this.createdRuntimeIds.push(descriptor.agentId)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
    return runtime as unknown as SwarmAgentRuntime
  }
}

class ResumeInspectingSwarmManager extends TestSwarmManager {
  readonly resumeStateByAgentId = new Map<string, { provider: string; resumeId: string } | null>()

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
  ): Promise<SwarmAgentRuntime> {
    const runtime = new ResumeInspectingRuntime(descriptor)
    this.createdRuntimeIds.push(descriptor.agentId)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
    this.resumeStateByAgentId.set(descriptor.agentId, runtime.resumedProviderState)
    return runtime as unknown as SwarmAgentRuntime
  }
}

function readPersistedResumeState(
  descriptor: AgentDescriptor,
): { provider: string; resumeId: string } | null {
  const provider = descriptor.model.provider.trim().toLowerCase()
  if (provider === 'claude-agent-sdk') {
    const runtimeStateFile = `${descriptor.sessionFile}.claude-runtime-state.json`
    if (existsSync(runtimeStateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(runtimeStateFile, 'utf8')) as { sessionId?: unknown }
        if (typeof parsed.sessionId === 'string' && parsed.sessionId.trim().length > 0) {
          return {
            provider,
            resumeId: parsed.sessionId.trim(),
          }
        }
      } catch {}
    }
  }

  if (provider === 'openai-codex-app-server') {
    const runtimeStateFile = `${descriptor.sessionFile}.codex-runtime-state.json`
    if (existsSync(runtimeStateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(runtimeStateFile, 'utf8')) as { threadId?: unknown }
        if (typeof parsed.threadId === 'string' && parsed.threadId.trim().length > 0) {
          return {
            provider,
            resumeId: parsed.threadId.trim(),
          }
        }
      } catch {}
    }
  }

  const sessionManager = SessionManager.open(descriptor.sessionFile)
  const customType =
    provider === 'claude-agent-sdk'
      ? 'swarm_claude_agent_sdk_runtime_state'
      : provider === 'openai-codex-app-server'
        ? 'swarm_codex_runtime_state'
        : undefined
  if (!customType) {
    return null
  }

  const entries = sessionManager
    .getEntries()
    .filter((entry) => entry.type === 'custom' && entry.customType === customType)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type !== 'custom' || !entry.data || typeof entry.data !== 'object') {
      continue
    }

    const maybeResumeId = provider === 'claude-agent-sdk'
      ? (entry.data as { sessionId?: unknown }).sessionId
      : (entry.data as { threadId?: unknown }).threadId
    if (typeof maybeResumeId !== 'string' || maybeResumeId.trim().length === 0) {
      continue
    }

    return {
      provider,
      resumeId: maybeResumeId.trim(),
    }
  }

  return null
}

function appendSessionConversationMessage(sessionFile: string, agentId: string, text: string): void {
  const sessionManager = SessionManager.open(sessionFile)
  sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'seed' }],
  } as any)
  sessionManager.appendCustomEntry('swarm_conversation_entry', {
    type: 'conversation_message',
    agentId,
    role: 'assistant',
    text,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'speak_to_user',
  })
}

function seedManagerDescriptorForRuntimeEventTests(manager: TestSwarmManager, config: SwarmConfig): void {
  const createdAt = '2026-01-01T00:00:00.000Z'
  const state = manager as unknown as {
    descriptors: Map<string, AgentDescriptor>
    conversationEntriesByAgentId: Map<string, unknown[]>
  }

  state.descriptors.set('manager', {
    agentId: 'manager',
    displayName: 'Manager',
    role: 'manager',
    managerId: 'manager',
    status: 'idle',
    createdAt,
    updatedAt: createdAt,
    cwd: config.defaultCwd,
    model: config.defaultModel,
    sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
  })
  state.conversationEntriesByAgentId.set('manager', [])
}

async function makeTempConfig(port = 8790): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), 'swarm-manager-test-'))
  const dataDir = join(root, 'data')
  const swarmDir = join(dataDir, 'swarm')
  const sessionsDir = join(dataDir, 'sessions')
  const uploadsDir = join(dataDir, 'uploads')
  const authDir = join(dataDir, 'auth')
  const agentDir = join(dataDir, 'agent')
  const managerAgentDir = join(agentDir, 'manager')
  const repoArchetypesDir = join(root, '.swarm', 'archetypes')

  await mkdir(swarmDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(uploadsDir, { recursive: true })
  await mkdir(authDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(managerAgentDir, { recursive: true })
  await mkdir(repoArchetypesDir, { recursive: true })

  return {
    host: '127.0.0.1',
    port,
    debug: false,
    allowNonManagerSubscriptions: false,
    managerId: 'manager',
    managerDisplayName: 'Manager',
    defaultModel: {
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    },
    defaultCwd: root,
    cwdAllowlistRoots: [root, join(root, 'worktrees')],
    paths: {
      rootDir: root,
      dataDir,
      swarmDir,
      sessionsDir,
      uploadsDir,
      authDir,
      authFile: join(authDir, 'auth.json'),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      agentsStoreFile: join(swarmDir, 'agents.json'),
      schedulesFile: getScheduleFilePath(dataDir, 'manager'),
    },
  }
}

async function bootWithDefaultManager(manager: TestSwarmManager, config: SwarmConfig): Promise<AgentDescriptor> {
  await manager.boot()
  const managerId = config.managerId ?? 'manager'
  const managerName = config.managerDisplayName ?? managerId

  const existingManager = manager.listAgents().find(
    (descriptor) => descriptor.agentId === managerId && descriptor.role === 'manager',
  )
  if (existingManager) {
    return existingManager
  }

  const createdManager = await manager.createManager(managerId, {
    name: managerName,
    cwd: config.defaultCwd,
  })

  // Keep fake runtime calls deterministic across tests.
  const createdRuntime = manager.runtimeByAgentId.get(createdManager.agentId)
  if (createdRuntime) {
    createdRuntime.sendCalls = []
    createdRuntime.nextDeliveryId = 0
  }

  return createdManager
}

describe('SwarmManager', () => {
  it('does not auto-create a manager on boot when the store is empty', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()

    const agents = manager.listAgents()
    expect(agents).toEqual([])
    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.size).toBe(0)
  })

  it('does not materialize manager SYSTEM.md into the data dir on boot', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()

    await expect(readFile(join(config.paths.managerAgentDir, 'SYSTEM.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('loads SWARM.md context files from the cwd ancestor chain', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    const rootSwarmPath = join(config.paths.rootDir, 'SWARM.md')
    const nestedDir = join(config.paths.rootDir, 'nested', 'deeper')
    const nestedSwarmPath = join(config.paths.rootDir, 'nested', 'SWARM.md')

    await mkdir(nestedDir, { recursive: true })
    await writeFile(rootSwarmPath, '# root swarm policy\n', 'utf8')
    await writeFile(nestedSwarmPath, '# nested swarm policy\n', 'utf8')

    const files = await manager.getSwarmContextFilesForTest(nestedDir)

    expect(files).toEqual([
      {
        path: rootSwarmPath,
        content: '# root swarm policy\n',
      },
      {
        path: nestedSwarmPath,
        content: '# nested swarm policy\n',
      },
    ])
  })

  it('returns no SWARM.md context files when none are present', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    const files = await manager.getSwarmContextFilesForTest(config.paths.rootDir)

    expect(files).toEqual([])
  })

  it('uses manager and default worker prompts with explicit visibility guidance', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const managerPrompt = manager.systemPromptByAgentId.get('manager')
    expect(managerPrompt).toContain('You are a PM/EM (product-engineering manager) in a multi-agent swarm.')
    expect(managerPrompt).toContain('End users only see two things')
    expect(managerPrompt).toContain('prefixed with "SYSTEM:"')
    expect(managerPrompt).toContain(
      'Delegation/subagent work MUST stay inside the Nexus swarm. The only allowed delegation primitives are `spawn_agent` and `send_message_to_agent`.',
    )
    expect(managerPrompt).toContain(
      'All delegation/subagent work must stay inside the Nexus swarm. Use only `spawn_agent` to create workers and `send_message_to_agent` to route or coordinate with existing Nexus agents.',
    )

    const worker = await manager.spawnAgent('manager', { agentId: 'Prompt Worker' })
    const workerPrompt = manager.systemPromptByAgentId.get(worker.agentId)

    expect(workerPrompt).toBeDefined()
    expect(workerPrompt).toContain('call the send_message_to_agent tool')
    expect(workerPrompt).toContain('SYSTEM:')
    expect(workerPrompt).toContain('you are a WORKER in a multi-agent swarm')
  })

  it('uses repo manager archetype overrides on boot', async () => {
    const config = await makeTempConfig()
    const managerOverride = 'You are the repo manager override.'
    await writeFile(join(config.paths.repoArchetypesDir, 'manager.md'), `${managerOverride}\n`, 'utf8')

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    expect(manager.systemPromptByAgentId.get('manager')).toBe(managerOverride)
  })

  it('spawns unique normalized agent ids on collisions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const first = await manager.spawnAgent('manager', { agentId: 'Code Scout' })
    const second = await manager.spawnAgent('manager', { agentId: 'Code Scout' })

    expect(first.agentId).toBe('code-scout')
    expect(first.displayName).toBe('code-scout')
    expect(second.agentId).toBe('code-scout-2')
    expect(second.displayName).toBe('code-scout-2')
  })

  it('does not force a worker suffix for normalized ids', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const spawned = await manager.spawnAgent('manager', { agentId: 'Task Owner' })

    expect(spawned.agentId).toBe('task-owner')
    expect(spawned.displayName).toBe('task-owner')
  })

  it('rejects explicit agent ids that would use the reserved manager id', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(manager.spawnAgent('manager', { agentId: 'manager' })).rejects.toThrow(
      'spawn_agent agentId "manager" is reserved',
    )
  })

  it('SYSTEM-prefixes worker initial messages (internal manager->worker input)', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Kickoff Worker',
      initialMessage: 'start implementation',
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: start implementation')
  })

  it('enforces manager-only spawn and kill permissions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker' })

    await expect(manager.spawnAgent(worker.agentId, { agentId: 'Nope' })).rejects.toThrow('Only manager can spawn agents')
    await expect(manager.killAgent(worker.agentId, worker.agentId)).rejects.toThrow('Only manager can kill agents')
  })

  it('returns fire-and-forget receipt and prefixes internal inter-agent deliveries', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Messenger' })

    const receipt = await manager.sendMessage('manager', worker.agentId, 'hi worker', 'auto')

    expect(receipt.targetAgentId).toBe(worker.agentId)
    expect(receipt.deliveryId).toBe('delivery-1')
    expect(receipt.acceptedMode).toBe('prompt')

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: hi worker')
  })

  it('sends manager user input as steer delivery, without SYSTEM prefixing, and with source metadata annotation', async () => {
    const config = await makeTempConfig()
    config.defaultModel = {
      provider: 'openai-codex-app-server',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    }
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('interrupt current plan')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.sendCalls.at(-1)?.delivery).toBe('steer')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('[sourceContext] {"channel":"web"}\n\ninterrupt current plan')
  })

  it('downgrades manager user input delivery to followUp for claude-agent-sdk managers', async () => {
    const config = await makeTempConfig()
    config.defaultModel = {
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    }
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('interrupt current plan')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.sendCalls.at(-1)?.delivery).toBe('followUp')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('[sourceContext] {"channel":"web"}\n\ninterrupt current plan')
  })

  it('downgrades manager user input delivery to followUp for claude provider casing variants', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const state = manager as unknown as {
      descriptors: Map<string, AgentDescriptor>
    }
    const managerDescriptor = state.descriptors.get('manager')
    expect(managerDescriptor).toBeDefined()
    managerDescriptor!.model = {
      provider: 'Claude-Agent-SDK' as AgentDescriptor['model']['provider'],
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    }

    await manager.handleUserMessage('interrupt current plan')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.sendCalls.at(-1)?.delivery).toBe('followUp')
  })

  it('surfaces manager assistant overflow turns as system conversation messages', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 180186 tokens > 180000 maximum"},"request_id":"req_test"}',
      },
    })

    const history = manager.getConversationHistory('manager')
    const systemEvent = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.source === 'system' &&
          entry.text.includes('Manager reply failed'),
      )

    expect(systemEvent).toBeDefined()
    if (systemEvent?.type === 'conversation_message') {
      expect(systemEvent.text).toContain('prompt is too long: 180186 tokens > 180000 maximum')
      expect(systemEvent.text).toContain('Try compacting the conversation to free up context space.')
    }
  })

  it('surfaces non-overflow manager runtime errors without overflow wording', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Rate limit exceeded for requests per minute',
      },
    })

    const history = manager.getConversationHistory('manager')
    const systemEvent = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.source === 'system' &&
          entry.text.includes('Manager reply failed'),
      )

    expect(systemEvent).toBeDefined()
    if (systemEvent?.type === 'conversation_message') {
      expect(systemEvent.text).toContain('Rate limit exceeded for requests per minute')
      expect(systemEvent.text).not.toContain('prompt exceeded the model context window')
      expect(systemEvent.text).not.toContain('Try compacting the conversation to free up context space.')
    }
  })

  it('records manager assistant error turns in runtime logs for debugging', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Rate limit exceeded for requests per minute',
      },
    })

    const history = manager.getConversationHistory('manager')
    const runtimeLog = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'conversation_log' &&
          entry.source === 'runtime_log' &&
          entry.kind === 'message_end' &&
          entry.role === 'assistant' &&
          entry.isError === true,
      )

    expect(runtimeLog).toBeDefined()
    if (runtimeLog?.type === 'conversation_log') {
      expect(runtimeLog.text).toContain('Rate limit exceeded for requests per minute')
    }
  })

  it('handles undefined/null/empty/malformed errorMessage payloads without crashing', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    const malformedErrorMessages: unknown[] = [undefined, null, '', { code: 'invalid_request_error' }]

    for (const errorMessage of malformedErrorMessages) {
      await expect(
        (manager as any).handleRuntimeSessionEvent('manager', {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage,
          },
        }),
      ).resolves.toBeUndefined()
    }

    const history = manager.getConversationHistory('manager')
    const systemErrorEvents = history.filter(
      (entry) =>
        entry.type === 'conversation_message' &&
        entry.role === 'system' &&
        entry.source === 'system' &&
        entry.text.includes('Manager reply failed'),
    )
    expect(systemErrorEvents).toHaveLength(malformedErrorMessages.length)
  })

  it('does not surface normal manager assistant turns as conversation messages', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'normal hidden manager assistant turn' }],
        stopReason: 'stop',
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(history).toHaveLength(0)
  })

  it('does not treat assistant turns with undefined errorMessage fields as runtime errors', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Standing by.' }],
        stopReason: undefined,
        errorMessage: undefined,
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(history).toHaveLength(0)
  })

  it('does not surface non-error manager turns that mention token limits', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'We should keep the summary short to avoid token limit issues.' }],
        stopReason: 'stop',
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(history).toHaveLength(0)
  })

  it('surfaces manager assistant thinking as a conversation message', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will spawn a worker.' }],
        thinking: 'The user wants me to analyze the codebase. I should spawn a worker for this.',
        stopReason: 'stop',
      },
    })

    const history = manager.getConversationHistory('manager')
    const thinkingMessage = history.find(
      (entry) =>
        entry.type === 'conversation_message' &&
        entry.role === 'assistant' &&
        entry.source === 'system',
    )
    expect(thinkingMessage).toBeDefined()
    if (thinkingMessage?.type === 'conversation_message') {
      expect(thinkingMessage.text).toBe('')
      expect(thinkingMessage.thinking).toBe(
        'The user wants me to analyze the codebase. I should spawn a worker for this.',
      )
    }

    const systemError = history.find(
      (entry) =>
        entry.type === 'conversation_message' &&
        entry.role === 'system' &&
        entry.text.includes('Manager reply failed'),
    )
    expect(systemError).toBeUndefined()
  })

  it('emits manager tool calls as conversation_log entries visible in web view', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_start',
      toolName: 'spawn_agent',
      toolCallId: 'call_abc123',
      args: { agentId: 'worker-1', task: 'Analyze the codebase' },
    })

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolName: 'spawn_agent',
      toolCallId: 'call_abc123',
      result: { success: true },
      isError: false,
    })

    const history = manager.getConversationHistory('manager')
    const toolLogs = history.filter(
      (entry): entry is Extract<typeof entry, { type: 'conversation_log' }> =>
        entry.type === 'conversation_log' && entry.toolName === 'spawn_agent',
    )
    expect(toolLogs).toHaveLength(2)
    expect(toolLogs[0].kind).toBe('tool_execution_start')
    expect(toolLogs[1].kind).toBe('tool_execution_end')
    expect(toolLogs[1].isError).toBe(false)
  })

  it('handles /compact as a manager slash command without forwarding it as a user prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('/compact')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.compactCalls).toEqual([undefined])
    expect(managerRuntime?.sendCalls).toEqual([])

    const history = manager.getConversationHistory('manager')
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Compacting manager context...',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Compaction complete.',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' && entry.role === 'user' && entry.text === '/compact',
      ),
    ).toBe(false)
  })

  it('passes optional custom instructions for /compact slash commands', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('/compact focus the summary on open implementation tasks')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime?.compactCalls).toEqual(['focus the summary on open implementation tasks'])
  })

  it('tags web user messages with default source metadata', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('interrupt current plan')

    const history = manager.getConversationHistory('manager')
    const userEvent = history.find(
      (entry) => entry.type === 'conversation_message' && entry.role === 'user' && entry.text === 'interrupt current plan',
    )

    expect(userEvent).toBeDefined()
    if (userEvent?.type === 'conversation_message') {
      expect(userEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('includes full sourceContext annotation when forwarding slack user messages to manager runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in slack thread', {
      sourceContext: {
        channel: 'slack',
        channelId: 'C123',
        userId: 'U456',
        threadTs: '173.456',
        channelType: 'channel',
        teamId: 'T789',
      },
    })

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe(
      '[sourceContext] {"channel":"slack","channelId":"C123","userId":"U456","threadTs":"173.456","channelType":"channel","teamId":"T789"}\n\nreply in slack thread',
    )
  })

  it('defaults speak_to_user routing to web when target is omitted, even after slack input', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in slack thread', {
      sourceContext: {
        channel: 'slack',
        channelId: 'C123',
        userId: 'U456',
        threadTs: '173.456',
      },
    })

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user')

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('uses explicit speak_to_user targets without inferred fallback behavior', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in slack thread', {
      sourceContext: {
        channel: 'slack',
        channelId: 'C123',
        userId: 'U456',
        threadTs: '173.456',
      },
    })

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user', {
      channel: 'slack',
      channelId: 'C999',
      userId: 'U000',
      threadTs: '999.000',
    })

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({
        channel: 'slack',
        channelId: 'C999',
        userId: 'U000',
        threadTs: '999.000',
      })
    }
  })

  it('requires channelId for explicit slack speak_to_user targets', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.publishToUser('manager', 'ack from manager', 'speak_to_user', {
        channel: 'slack',
      }),
    ).rejects.toThrow(
      'speak_to_user target.channelId is required when target.channel is "slack" or "telegram"',
    )
  })

  it('falls back to web routing when no explicit target context exists', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user')

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('does not SYSTEM-prefix direct user messages routed to a worker', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'User Routed Worker' })

    await manager.handleUserMessage('hello worker', { targetAgentId: worker.agentId })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('hello worker')
  })

  it('routes user image attachments to worker runtimes and conversation events', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Image Worker' })

    await manager.handleUserMessage('', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('object')
    if (sentMessage && typeof sentMessage !== 'string') {
      expect(sentMessage.text).toBe('')
      expect(sentMessage.images).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ])
    }

    const history = manager.getConversationHistory(worker.agentId)
    const userEvent = history.find(
      (entry) => entry.type === 'conversation_message' && entry.role === 'user' && entry.source === 'user_input',
    )

    expect(userEvent).toBeDefined()
    if (userEvent && userEvent.type === 'conversation_message') {
      expect(userEvent.text).toBe('')
      expect(userEvent.attachments).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
        },
      ])
    }
  })

  it('injects text attachments into the runtime prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Text Attachment Worker' })

    await manager.handleUserMessage('Please review this file.', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          type: 'text',
          mimeType: 'text/markdown',
          fileName: 'notes.md',
          text: '# Notes\n\n- item',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('string')
    if (typeof sentMessage === 'string') {
      expect(sentMessage).toContain('Please review this file.')
      expect(sentMessage).toContain('Name: notes.md')
      expect(sentMessage).toContain('# Notes')
    }
  })

  it('appends persisted attachment paths to runtime text while preserving image payloads', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Persisted Path Worker' })
    const imagePath = join(config.paths.uploadsDir, 'diagram.png')
    const textPath = join(config.paths.uploadsDir, 'notes.txt')

    await writeFile(imagePath, Buffer.from('hello'))
    await writeFile(textPath, 'hello from text attachment', 'utf8')

    await manager.handleUserMessage('Review these files', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
          filePath: imagePath,
        },
        {
          type: 'text',
          mimeType: 'text/plain',
          fileName: 'notes.txt',
          filePath: textPath,
          text: 'hello from text attachment',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('object')

    if (sentMessage && typeof sentMessage !== 'string') {
      expect(sentMessage.images).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ])
      expect(sentMessage.text).toContain('Review these files')
      expect(sentMessage.text).toContain(`[Attached file saved to: ${imagePath}]`)
      expect(sentMessage.text).toContain(`[Attached file saved to: ${textPath}]`)
    }
  })

  it('writes binary attachments to disk and passes their path to the runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Binary Attachment Worker' })

    await manager.handleUserMessage('', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          type: 'binary',
          mimeType: 'application/pdf',
          fileName: 'spec.pdf',
          data: 'aGVsbG8=',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('string')

    if (typeof sentMessage === 'string') {
      const savedPathMatch = sentMessage.match(/Saved to: (.+)/)
      expect(savedPathMatch).toBeTruthy()

      const savedPath = savedPathMatch?.[1]?.trim()
      expect(savedPath).toBeTruthy()

      if (savedPath) {
        const binaryContents = await readFile(savedPath)
        expect(binaryContents.toString('utf8')).toBe('hello')
      }
    }
  })

  it('does not double-prefix internal messages that already start with SYSTEM:', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Already Tagged Worker' })

    await manager.sendMessage('manager', worker.agentId, 'SYSTEM: pre-tagged', 'auto')

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: pre-tagged')
  })

  it('accepts busy-runtime messages as steer regardless of requested delivery', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Busy Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()
    runtime!.busy = true

    const autoReceipt = await manager.sendMessage('manager', worker.agentId, 'queued auto', 'auto')
    const followUpReceipt = await manager.sendMessage('manager', worker.agentId, 'queued followup', 'followUp')
    const steerReceipt = await manager.sendMessage('manager', worker.agentId, 'queued steer', 'steer')

    expect(autoReceipt.acceptedMode).toBe('steer')
    expect(followUpReceipt.acceptedMode).toBe('steer')
    expect(steerReceipt.acceptedMode).toBe('steer')
  })

  it('downgrades explicit steer delivery to followUp for claude-agent-sdk targets', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Claude Worker', model: 'claude-agent-sdk' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()

    await manager.sendMessage('manager', worker.agentId, 'queued steer', 'steer')

    expect(runtime?.sendCalls.at(-1)?.delivery).toBe('followUp')
  })

  it('kills a busy runtime with abort then marks descriptor terminated', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Killable Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()

    await manager.killAgent('manager', worker.agentId)

    expect(runtime!.terminateCalls).toEqual([{ abort: true }])
    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')
  })

  it('stops all agents by cancelling in-flight work without terminating runtimes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stop-All Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const managerDescriptor = state.descriptors.get('manager')
    const workerDescriptor = state.descriptors.get(worker.agentId)
    expect(managerDescriptor).toBeDefined()
    expect(workerDescriptor).toBeDefined()

    managerDescriptor!.status = 'streaming'
    workerDescriptor!.status = 'streaming'
    managerRuntime!.busy = true
    workerRuntime!.busy = true

    const stopped = await manager.stopAllAgents('manager', 'manager')

    expect(stopped).toEqual({
      managerId: 'manager',
      stoppedWorkerIds: [worker.agentId],
      managerStopped: true,
      terminatedWorkerIds: [worker.agentId],
      managerTerminated: true,
    })
    expect(managerRuntime!.stopInFlightCalls).toEqual([{ abort: true }])
    expect(workerRuntime!.stopInFlightCalls).toEqual([{ abort: true }])
    expect(managerRuntime!.terminateCalls).toEqual([])
    expect(workerRuntime!.terminateCalls).toEqual([])

    const managerAfter = manager.listAgents().find((agent) => agent.agentId === 'manager')
    const workerAfter = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(managerAfter?.status).toBe('idle')
    expect(workerAfter?.status).toBe('idle')
    expect(manager.runtimeByAgentId.has('manager')).toBe(true)
    expect(manager.runtimeByAgentId.has(worker.agentId)).toBe(true)
  })

  it('interrupts a worker without terminating its runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Interruptible Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const workerDescriptor = state.descriptors.get(worker.agentId)
    expect(workerDescriptor).toBeDefined()

    workerDescriptor!.status = 'streaming'
    runtime!.busy = true

    const interrupted = await manager.interruptAgent('manager', worker.agentId)

    expect(interrupted).toEqual({
      agentId: worker.agentId,
      managerId: 'manager',
      interrupted: true,
    })
    expect(runtime!.stopInFlightCalls).toEqual([{ abort: true }])
    expect(runtime!.terminateCalls).toEqual([])
    expect(manager.runtimeByAgentId.has(worker.agentId)).toBe(true)

    const workerAfter = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(workerAfter?.status).toBe('idle')
  })

  it('interrupts a queued worker even when the descriptor is still idle', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Queued Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const workerDescriptor = state.descriptors.get(worker.agentId)
    expect(workerDescriptor).toBeDefined()

    workerDescriptor!.status = 'idle'
    runtime!.busy = true

    const interrupted = await manager.interruptAgent('manager', worker.agentId)

    expect(interrupted).toEqual({
      agentId: worker.agentId,
      managerId: 'manager',
      interrupted: true,
    })
    expect(runtime!.stopInFlightCalls).toEqual([{ abort: true }])
    expect(runtime!.terminateCalls).toEqual([])
  })

  it('interrupts a manager only when targeting itself', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Secondary Manager',
      cwd: config.defaultCwd,
    })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const secondaryRuntime = manager.runtimeByAgentId.get(secondary.agentId)
    expect(managerRuntime).toBeDefined()
    expect(secondaryRuntime).toBeDefined()

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    state.descriptors.get('manager')!.status = 'streaming'
    state.descriptors.get(secondary.agentId)!.status = 'streaming'
    managerRuntime!.busy = true
    secondaryRuntime!.busy = true

    await expect(manager.interruptAgent('manager', secondary.agentId)).rejects.toThrow(
      `Only selected manager can interrupt manager ${secondary.agentId}`,
    )

    const interrupted = await manager.interruptAgent('manager', 'manager')
    expect(interrupted).toEqual({
      agentId: 'manager',
      managerId: 'manager',
      interrupted: true,
    })
    expect(managerRuntime!.stopInFlightCalls).toEqual([{ abort: true }])
    expect(secondaryRuntime!.stopInFlightCalls).toEqual([])
  })

  it('normalizes persisted streaming workers to idle on restart without recreating runtimes', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-a',
          displayName: 'Worker A',
          role: 'worker',
          managerId: 'manager',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-a.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const agents = manager.listAgents()
    const worker = agents.find((agent) => agent.agentId === 'worker-a')
    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; status: AgentDescriptor['status'] }>
    }
    const persistedWorker = persistedStore.agents.find((agent) => agent.agentId === 'worker-a')

    expect(worker?.status).toBe('idle')
    expect(persistedWorker?.status).toBe('idle')
    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('manager')).toBeUndefined()
    expect(manager.runtimeByAgentId.get('worker-a')).toBeUndefined()
  })

  it('fails closed for persisted unknown model descriptors when lazily restoring runtimes after boot', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-unknown-model',
          displayName: 'Worker Unknown Model',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: {
            provider: 'unknown-provider',
            modelId: 'unknown-model',
            thinkingLevel: 'xhigh',
          },
          sessionFile: join(config.paths.sessionsDir, 'worker-unknown-model.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    await expect(
      manager.sendMessage('manager', 'worker-unknown-model', 'attempt restore'),
    ).rejects.toThrow('Unsupported model descriptor unknown-provider/unknown-model')

    const worker = manager.listAgents().find((agent) => agent.agentId === 'worker-unknown-model')
    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{
        agentId: string
        status: AgentDescriptor['status']
        model: AgentDescriptor['model']
      }>
    }
    const persistedWorker = persistedStore.agents.find((agent) => agent.agentId === 'worker-unknown-model')

    expect(worker?.status).toBe('idle')
    expect(worker?.model).toEqual({
      provider: 'unknown-provider',
      modelId: 'unknown-model',
      thinkingLevel: 'xhigh',
    })
    expect(persistedWorker?.status).toBe('idle')
    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('worker-unknown-model')).toBeUndefined()
  })

  it('fails closed for unknown persisted descriptors on boot restore for streaming workers', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-unknown-streaming',
          displayName: 'Worker Unknown Streaming',
          role: 'worker',
          managerId: 'manager',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: {
            provider: 'unknown-provider',
            modelId: 'unknown-model',
            thinkingLevel: 'xhigh',
          },
          sessionFile: join(config.paths.sessionsDir, 'worker-unknown-streaming.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const restored = manager.listAgents().find((agent) => agent.agentId === 'worker-unknown-streaming')
    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; status: AgentDescriptor['status'] }>
    }
    const persisted = persistedStore.agents.find((agent) => agent.agentId === 'worker-unknown-streaming')

    // Boot normalization should not restore runtime or fallback providers for unknown descriptors.
    expect(restored?.status).toBe('idle')
    expect(persisted?.status).toBe('idle')
    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('worker-unknown-streaming')).toBeUndefined()
  })

  it('keeps configured primary manager fail-closed when persisted descriptor is unknown', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: {
            provider: 'unknown-provider',
            modelId: 'unknown-model',
            thinkingLevel: 'xhigh',
          },
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const restoredManager = manager.listAgents().find((agent) => agent.agentId === 'manager')
    expect(restoredManager?.status).toBe('idle')

    await expect(manager.handleUserMessage('hello manager')).rejects.toThrow(
      'Unsupported model descriptor unknown-provider/unknown-model',
    )
    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('manager')).toBeUndefined()
  })

  it('migrates persisted stopped_on_restart statuses to stopped at boot', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-stopped',
          displayName: 'Worker Stopped',
          role: 'worker',
          managerId: 'manager',
          status: 'stopped_on_restart',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-stopped.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const migrated = manager.listAgents().find((agent) => agent.agentId === 'worker-stopped')
    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; status: AgentDescriptor['status'] }>
    }
    const persistedWorker = persistedStore.agents.find((agent) => agent.agentId === 'worker-stopped')

    expect(migrated?.status).toBe('stopped')
    expect(persistedWorker?.status).toBe('stopped')
  })

  it('lazily creates idle runtimes when a restored agent receives work', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-idle',
          displayName: 'Worker Idle',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-idle.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('worker-idle')).toBeUndefined()

    await manager.sendMessage('manager', 'worker-idle', 'start now')

    const runtime = manager.runtimeByAgentId.get('worker-idle')
    expect(runtime).toBeDefined()
    expect(runtime?.sendCalls.at(-1)?.message).toBe('SYSTEM: start now')
    expect(manager.createdRuntimeIds).toEqual(['worker-idle'])
  })

  it('skips terminated histories at boot and lazy-loads them on demand', async () => {
    const config = await makeTempConfig()

    appendSessionConversationMessage(join(config.paths.sessionsDir, 'manager.jsonl'), 'manager', 'manager-history')
    appendSessionConversationMessage(
      join(config.paths.sessionsDir, 'worker-active.jsonl'),
      'worker-active',
      'active-worker-history',
    )
    appendSessionConversationMessage(
      join(config.paths.sessionsDir, 'worker-terminated.jsonl'),
      'worker-terminated',
      'terminated-worker-history',
    )

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-active',
          displayName: 'Worker Active',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-active.jsonl'),
        },
        {
          agentId: 'worker-terminated',
          displayName: 'Worker Terminated',
          role: 'worker',
          managerId: 'manager',
          status: 'terminated',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-terminated.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.getLoadedConversationAgentIdsForTest()).toEqual(['manager', 'worker-active'])

    const terminatedHistory = manager.getConversationHistory('worker-terminated')
    expect(terminatedHistory.some((entry) => entry.text === 'terminated-worker-history')).toBe(true)
    expect(manager.getLoadedConversationAgentIdsForTest()).toEqual(['manager', 'worker-active', 'worker-terminated'])
  })

  it('does not implicitly recreate the configured manager when other agents already exist', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'ops-manager',
          displayName: 'Ops Manager',
          role: 'manager',
          managerId: 'ops-manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'ops-manager.jsonl'),
        },
        {
          agentId: 'ops-worker',
          displayName: 'Ops Worker',
          role: 'worker',
          managerId: 'ops-manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'ops-worker.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const agents = manager.listAgents()
    const restoredWorker = agents.find((agent) => agent.agentId === 'ops-worker')

    expect(agents.some((agent) => agent.agentId === 'manager')).toBe(false)
    expect(restoredWorker?.managerId).toBe('ops-manager')
    expect(manager.createdRuntimeIds).toEqual([])
  })

  it('keeps killed workers terminated across restart', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const worker = await firstBoot.spawnAgent('manager', { agentId: 'Killed Worker' })
    await firstBoot.killAgent('manager', worker.agentId)

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const restored = secondBoot.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(restored?.status).toBe('terminated')
    expect(secondBoot.createdRuntimeIds).toEqual([])

    await expect(secondBoot.sendMessage('manager', worker.agentId, 'still there?')).rejects.toThrow(
      `Target agent is not running: ${worker.agentId}`,
    )
  })

  it('does not duplicate workers across repeated restarts', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const worker = await firstBoot.spawnAgent('manager', { agentId: 'Repeat Worker' })

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)
    expect(secondBoot.listAgents().filter((agent) => agent.agentId === worker.agentId)).toHaveLength(1)
    expect(secondBoot.createdRuntimeIds).toEqual([])

    const thirdBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(thirdBoot, config)
    expect(thirdBoot.listAgents().filter((agent) => agent.agentId === worker.agentId)).toHaveLength(1)
    expect(thirdBoot.createdRuntimeIds).toEqual([])
  })

  it('persists manager conversation history to disk and reloads it on restart', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    await firstBoot.handleUserMessage('persist this')
    await firstBoot.publishToUser('manager', 'saved reply', 'speak_to_user')

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const history = secondBoot.getConversationHistory('manager')
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === 'persist this' &&
          message.source === 'user_input',
      ),
    ).toBe(true)
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === 'saved reply' &&
          message.source === 'speak_to_user',
      ),
    ).toBe(true)
  })

  it('preserves persisted Claude manager resume state for lazy runtime recreation after restart', async () => {
    const config = await makeTempConfig()
    const createdAt = '2026-01-01T00:00:00.000Z'
    const sessionFile = join(config.paths.sessionsDir, 'manager.jsonl')

    await writeFile(
      config.paths.agentsStoreFile,
      JSON.stringify(
        {
          agents: [
            {
              agentId: 'manager',
              displayName: 'Manager',
              role: 'manager',
              managerId: 'manager',
              status: 'idle',
              createdAt,
              updatedAt: createdAt,
              cwd: config.defaultCwd,
              model: {
                provider: 'claude-agent-sdk',
                modelId: 'claude-opus-4-6',
                thinkingLevel: 'xhigh',
              },
              sessionFile,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const sessionManager = SessionManager.open(sessionFile)
    sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed' }],
    } as any)
    sessionManager.appendCustomEntry('swarm_claude_agent_sdk_runtime_state', { sessionId: 'claude-session-123' })
    await writeFile(`${sessionFile}.claude-runtime-state.json`, `${JSON.stringify({ sessionId: 'claude-session-123' })}\n`, 'utf8')

    const manager = new ResumeInspectingSwarmManager(config)
    await manager.boot()
    expect(manager.createdRuntimeIds).toEqual([])

    await manager.handleUserMessage('continue after restart')

    expect(manager.resumeStateByAgentId.get('manager')).toEqual({
      provider: 'claude-agent-sdk',
      resumeId: 'claude-session-123',
    })
  })

  it('preserves persisted Codex manager resume state for lazy runtime recreation after restart', async () => {
    const config = await makeTempConfig()
    const createdAt = '2026-01-01T00:00:00.000Z'
    const sessionFile = join(config.paths.sessionsDir, 'manager.jsonl')

    await writeFile(
      config.paths.agentsStoreFile,
      JSON.stringify(
        {
          agents: [
            {
              agentId: 'manager',
              displayName: 'Manager',
              role: 'manager',
              managerId: 'manager',
              status: 'idle',
              createdAt,
              updatedAt: createdAt,
              cwd: config.defaultCwd,
              model: {
                provider: 'openai-codex-app-server',
                modelId: 'gpt-5-codex',
                thinkingLevel: 'medium',
              },
              sessionFile,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const sessionManager = SessionManager.open(sessionFile)
    sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed' }],
    } as any)
    sessionManager.appendCustomEntry('swarm_codex_runtime_state', { threadId: 'codex-thread-123' })
    await writeFile(`${sessionFile}.codex-runtime-state.json`, `${JSON.stringify({ threadId: 'codex-thread-123' })}\n`, 'utf8')

    const manager = new ResumeInspectingSwarmManager(config)
    await manager.boot()
    expect(manager.createdRuntimeIds).toEqual([])

    await manager.handleUserMessage('continue after restart')

    expect(manager.resumeStateByAgentId.get('manager')).toEqual({
      provider: 'openai-codex-app-server',
      resumeId: 'codex-thread-123',
    })
  })

  it('preserves web user and speak_to_user history when internal activity overflows history limits', async () => {
    const config = await makeTempConfig()
    const createdAt = '2026-01-01T00:00:00.000Z'
    await writeFile(
      config.paths.agentsStoreFile,
      JSON.stringify(
        {
          agents: [
            {
              agentId: 'manager',
              displayName: 'Manager',
              role: 'manager',
              managerId: 'manager',
              status: 'idle',
              createdAt,
              updatedAt: createdAt,
              cwd: config.defaultCwd,
              model: config.defaultModel,
              sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const sessionManager = SessionManager.open(join(config.paths.sessionsDir, 'manager.jsonl'))
    sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed' }],
    } as any)
    sessionManager.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'user',
      text: 'web message that must persist',
      timestamp: new Date(1).toISOString(),
      source: 'user_input',
      sourceContext: {
        channel: 'web',
      },
    })
    sessionManager.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'web reply that must persist',
      timestamp: new Date(2).toISOString(),
      source: 'speak_to_user',
      sourceContext: {
        channel: 'web',
      },
    })
    for (let index = 0; index < 2_200; index += 1) {
      sessionManager.appendCustomEntry('swarm_conversation_entry', {
        type: 'agent_message',
        agentId: 'manager',
        timestamp: new Date(3 + index).toISOString(),
        source: 'agent_to_agent',
        fromAgentId: 'manager',
        toAgentId: 'worker',
        text: `internal-message-${index}`,
      })
    }

    const firstBoot = new TestSwarmManager(config)
    await firstBoot.boot()

    const inMemoryHistory = firstBoot.getConversationHistory('manager')
    expect(
      inMemoryHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'user_input' &&
          entry.text === 'web message that must persist',
      ),
    ).toBe(true)
    expect(
      inMemoryHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'speak_to_user' &&
          entry.text === 'web reply that must persist',
      ),
    ).toBe(true)
    expect(
      inMemoryHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-0'),
    ).toBe(false)
    expect(
      inMemoryHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-2199'),
    ).toBe(true)

    const secondBoot = new TestSwarmManager(config)
    await secondBoot.boot()

    const restoredHistory = secondBoot.getConversationHistory('manager')
    expect(
      restoredHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'user_input' &&
          entry.text === 'web message that must persist',
      ),
    ).toBe(true)
    expect(
      restoredHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'speak_to_user' &&
          entry.text === 'web reply that must persist',
      ),
    ).toBe(true)
    expect(
      restoredHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-0'),
    ).toBe(false)
    expect(
      restoredHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-2199'),
    ).toBe(true)
  })

  it('resetManagerSession recreates manager runtime and clears manager history', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const managerDescriptor = manager.listAgents().find((agent) => agent.agentId === 'manager')
    expect(managerDescriptor).toBeDefined()
    const managerRuntimeStateFile = `${managerDescriptor!.sessionFile}.claude-runtime-state.json`
    const codexRuntimeStateFile = `${managerDescriptor!.sessionFile}.codex-runtime-state.json`
    await writeFile(managerRuntimeStateFile, `${JSON.stringify({ sessionId: 'stale-session' })}\n`, 'utf8')
    await writeFile(codexRuntimeStateFile, `${JSON.stringify({ threadId: 'stale-thread' })}\n`, 'utf8')

    await manager.handleUserMessage('before reset')
    expect(manager.getConversationHistory('manager').some((message) => message.text === 'before reset')).toBe(true)

    const firstRuntime = manager.runtimeByAgentId.get('manager')
    expect(firstRuntime).toBeDefined()

    await manager.resetManagerSession('api_reset')

    expect(firstRuntime!.terminateCalls).toEqual([{ abort: true }])
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(2)
    expect(manager.getConversationHistory('manager')).toHaveLength(0)
    await expect(readFile(managerRuntimeStateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(codexRuntimeStateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const rebooted = new TestSwarmManager(config)
    await bootWithDefaultManager(rebooted, config)
    expect(rebooted.getConversationHistory('manager')).toHaveLength(0)
  })

  it('skips invalid persisted descriptors instead of failing boot', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'broken-worker',
          displayName: 'Broken Worker',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          sessionFile: join(config.paths.sessionsDir, 'broken-worker.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((entry) => String(entry)).join(' '))
    }

    try {
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const agentIds = manager.listAgents().map((agent) => agent.agentId)
      expect(agentIds).toEqual(['manager'])
      expect(warnings.some((entry) => entry.includes('Skipping invalid descriptor'))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  it('creates secondary managers and deletes them with owned worker cascade', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Ops Manager',
      cwd: config.defaultCwd,
    })

    expect(secondary.role).toBe('manager')
    expect(secondary.managerId).toBe(secondary.agentId)

    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Owned Worker' })
    expect(ownedWorker.managerId).toBe(secondary.agentId)

    const deleted = await manager.deleteManager('manager', secondary.agentId)

    expect(deleted.managerId).toBe(secondary.agentId)
    expect(deleted.terminatedWorkerIds).toContain(ownedWorker.agentId)
    expect(manager.listAgents().some((agent) => agent.agentId === secondary.agentId)).toBe(false)
    expect(manager.listAgents().some((agent) => agent.agentId === ownedWorker.agentId)).toBe(false)
  })

  it('does not reset manager runtime when update_manager has no effective change', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const initialDescriptor = manager.getAgent('manager')
    const initialRuntime = manager.runtimeByAgentId.get('manager')

    expect(initialDescriptor).toBeDefined()
    expect(initialRuntime).toBeDefined()

    const updated = await manager.updateManager('manager', {
      managerId: 'manager',
      model: 'claude-agent-sdk',
    })

    const finalDescriptor = manager.getAgent('manager')

    expect(updated.resetApplied).toBe(false)
    expect(initialRuntime?.terminateCalls).toEqual([])
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(1)
    expect(finalDescriptor?.updatedAt).toBe(initialDescriptor?.updatedAt)
  })

  it('applies update_manager model-first then thinking override and performs full reset', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const initialRuntime = manager.runtimeByAgentId.get('manager')
    expect(initialRuntime).toBeDefined()

    const updated = await manager.updateManager('manager', {
      managerId: 'manager',
      model: 'codex-app',
      thinkingLevel: 'low',
    })

    expect(updated.resetApplied).toBe(true)
    expect(updated.manager.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'gpt-5.4',
      thinkingLevel: 'low',
    })
    expect(initialRuntime?.terminateCalls).toEqual([{ abort: true }])
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(2)
  })

  it('applies explicit same-provider update_manager payload without resetting runtime or session state', async () => {
    const config = await makeTempConfig()
    const manager = new ResumeInspectingSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const initialRuntime = manager.runtimeByAgentId.get('manager')
    const initialDescriptor = manager.getAgent('manager')
    expect(initialRuntime).toBeDefined()
    expect(initialDescriptor).toBeDefined()

    const runtimeStateFile = `${initialDescriptor!.sessionFile}.claude-runtime-state.json`
    await writeFile(runtimeStateFile, `${JSON.stringify({ sessionId: 'claude-session-123' })}\n`, 'utf8')

    await manager.handleUserMessage('hello before explicit update')
    expect(
      manager
        .getConversationHistory('manager')
        .some((entry) => entry.type === 'conversation_message' && entry.text === 'hello before explicit update'),
    ).toBe(true)

    const updated = await manager.updateManager('manager', {
      managerId: 'manager',
      provider: 'claude-agent-sdk',
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'low',
    })

    expect(updated.resetApplied).toBe(false)
    expect(updated.manager.model).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'low',
    })
    expect(initialRuntime?.terminateCalls).toEqual([])
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(1)
    expect(
      manager
        .getConversationHistory('manager')
        .some((entry) => entry.type === 'conversation_message' && entry.text === 'hello before explicit update'),
    ).toBe(true)
    await expect(readFile(runtimeStateFile, 'utf8')).resolves.toContain('"sessionId":"claude-session-123"')

    const rebooted = new ResumeInspectingSwarmManager(config)
    await rebooted.boot()

    const restoredManager = rebooted.getAgent('manager')
    expect(restoredManager?.model).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'low',
    })
    expect(
      rebooted
        .getConversationHistory('manager')
        .some((entry) => entry.type === 'conversation_message' && entry.text === 'hello before explicit update'),
    ).toBe(true)

    await expect(rebooted.handleUserMessage('hello after explicit update')).resolves.toBeUndefined()
    expect(rebooted.resumeStateByAgentId.get('manager')).toEqual({
      provider: 'claude-agent-sdk',
      resumeId: 'claude-session-123',
    })
  })

  it('does not reset manager runtime when explicit update_manager payload has no effective change', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManager('manager', {
      managerId: 'manager',
      provider: 'claude-agent-sdk',
      modelId: 'claude-sonnet-4-5',
    })

    const runtimeAfterChange = manager.runtimeByAgentId.get('manager')
    expect(runtimeAfterChange).toBeDefined()
    const createdBeforeNoOp = manager.createdRuntimeIds.filter((id) => id === 'manager').length

    const noOp = await manager.updateManager('manager', {
      managerId: 'manager',
      provider: 'claude-agent-sdk',
      modelId: 'claude-sonnet-4-5',
    })

    expect(noOp.resetApplied).toBe(false)
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(createdBeforeNoOp)
    expect(runtimeAfterChange?.terminateCalls).toEqual([])
  })

  it('rejects unsupported explicit descriptors before manager reset and persistence mutation', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const before = manager.getAgent('manager')
    const initialRuntime = manager.runtimeByAgentId.get('manager')
    const createdBefore = manager.createdRuntimeIds.filter((id) => id === 'manager').length

    await expect(
      manager.updateManager('manager', {
        managerId: 'manager',
        provider: 'codex-app',
        modelId: 'default',
      }),
    ).rejects.toThrow('Unsupported model descriptor codex-app/default')

    const after = manager.getAgent('manager')
    expect(after?.model).toEqual(before?.model)
    expect(after?.updatedAt).toBe(before?.updatedAt)
    expect(initialRuntime?.terminateCalls).toEqual([])
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(createdBefore)
  })

  it('rejects update_manager payloads that mix preset and explicit model descriptor fields', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.updateManager('manager', {
        managerId: 'manager',
        model: 'claude-agent-sdk',
        provider: 'openai-codex-app-server',
        modelId: 'default',
      }),
    ).rejects.toThrow(
      'update_manager.model cannot be combined with update_manager.provider or update_manager.modelId',
    )
  })

  it('sets and clears manager prompt override through update_manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const promptOverride = 'You are the manager override prompt.'

    const withOverride = await manager.updateManager('manager', {
      managerId: 'manager',
      promptOverride,
    })

    expect(withOverride.resetApplied).toBe(true)
    expect(withOverride.manager.promptOverride).toBe(promptOverride)
    const overrideSystemPrompt = manager.systemPromptByAgentId.get('manager')
    expect(overrideSystemPrompt).toContain('User-facing output MUST go through speak_to_user.')
    expect(overrideSystemPrompt).toContain(
      'Use speak_to_user for every user-facing message; for non-web replies, explicitly set target.channel + target.channelId from the inbound source metadata line.',
    )
    expect(overrideSystemPrompt).toContain(
      'Delegation/subagent work MUST stay inside the Nexus swarm. The only allowed delegation primitives are spawn_agent and send_message_to_agent.',
    )
    expect(overrideSystemPrompt).toContain(promptOverride)

    const cleared = await manager.updateManager('manager', {
      managerId: 'manager',
      promptOverride: '',
    })

    expect(cleared.resetApplied).toBe(true)
    expect(cleared.manager.promptOverride).toBeUndefined()
    expect(manager.systemPromptByAgentId.get('manager')).toContain(
      'You are a PM/EM (product-engineering manager) in a multi-agent swarm.',
    )
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(3)
  })

  it('sets spawnDefaultModel via update_manager with spawnDefaultProvider/ModelId/ThinkingLevel', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const updated = await manager.updateManager('manager', {
      managerId: 'manager',
      spawnDefaultProvider: 'claude-agent-sdk',
      spawnDefaultModelId: 'claude-opus-4-6',
      spawnDefaultThinkingLevel: 'low',
    })

    expect(updated.resetApplied).toBe(false)
    expect(updated.manager.spawnDefaultModel).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'low',
    })
  })

  it('sets spawnDefaultModel without thinkingLevel, using model default', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const updated = await manager.updateManager('manager', {
      managerId: 'manager',
      spawnDefaultProvider: 'claude-agent-sdk',
      spawnDefaultModelId: 'claude-opus-4-6',
    })

    expect(updated.resetApplied).toBe(false)
    expect(updated.manager.spawnDefaultModel).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })
  })

  it('clears spawnDefaultModel when clearSpawnDefault is true', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManager('manager', {
      managerId: 'manager',
      spawnDefaultProvider: 'claude-agent-sdk',
      spawnDefaultModelId: 'claude-opus-4-6',
      spawnDefaultThinkingLevel: 'low',
    })

    const cleared = await manager.updateManager('manager', {
      managerId: 'manager',
      clearSpawnDefault: true,
    })

    expect(cleared.resetApplied).toBe(false)
    expect(cleared.manager.spawnDefaultModel).toBeUndefined()
  })

  it('returns resetApplied=false when only spawn default changes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const initialRuntime = manager.runtimeByAgentId.get('manager')
    const createdBefore = manager.createdRuntimeIds.filter((id) => id === 'manager').length

    const updated = await manager.updateManager('manager', {
      managerId: 'manager',
      spawnDefaultProvider: 'claude-agent-sdk',
      spawnDefaultModelId: 'claude-opus-4-6',
      spawnDefaultThinkingLevel: 'low',
    })

    expect(updated.resetApplied).toBe(false)
    expect(initialRuntime?.terminateCalls).toEqual([])
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(createdBefore)
  })

  it('preserves spawnDefaultModel when only manager model is updated', async () => {
    const config = await makeTempConfig()
    config.defaultModel = {
      provider: 'openai-codex-app-server',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    }
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManager('manager', {
      managerId: 'manager',
      spawnDefaultProvider: 'openai-codex-app-server',
      spawnDefaultModelId: 'gpt-5.4',
      spawnDefaultThinkingLevel: 'low',
    })

    const updated = await manager.updateManager('manager', {
      managerId: 'manager',
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
    })

    expect(updated.resetApplied).toBe(true)
    expect(updated.manager.spawnDefaultModel).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'gpt-5.4',
      thinkingLevel: 'low',
    })
  })

  it('rejects update_manager with spawnDefaultProvider but no spawnDefaultModelId', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.updateManager('manager', {
        managerId: 'manager',
        spawnDefaultProvider: 'claude-agent-sdk',
      }),
    ).rejects.toThrow(
      'update_manager.spawnDefaultProvider and update_manager.spawnDefaultModelId are required together',
    )
  })

  it('rejects update_manager with spawnDefaultModelId but no spawnDefaultProvider', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.updateManager('manager', {
        managerId: 'manager',
        spawnDefaultModelId: 'claude-opus-4-6',
      }),
    ).rejects.toThrow(
      'update_manager.spawnDefaultProvider and update_manager.spawnDefaultModelId are required together',
    )
  })

  it('rejects update_manager with spawnDefaultThinkingLevel but no spawnDefaultProvider/ModelId', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.updateManager('manager', {
        managerId: 'manager',
        spawnDefaultThinkingLevel: 'low',
      }),
    ).rejects.toThrow(
      'update_manager.spawnDefaultThinkingLevel requires update_manager.spawnDefaultProvider and update_manager.spawnDefaultModelId',
    )
  })

  it('rejects update_manager with clearSpawnDefault combined with spawnDefaultProvider', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.updateManager('manager', {
        managerId: 'manager',
        clearSpawnDefault: true,
        spawnDefaultProvider: 'claude-agent-sdk',
        spawnDefaultModelId: 'claude-opus-4-6',
      }),
    ).rejects.toThrow(
      'update_manager.clearSpawnDefault cannot be combined with update_manager.spawnDefaultProvider or update_manager.spawnDefaultModelId',
    )
  })

  it('rejects update_manager with empty/whitespace spawnDefaultProvider', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.updateManager('manager', {
        managerId: 'manager',
        spawnDefaultProvider: '  ',
        spawnDefaultModelId: 'claude-opus-4-6',
      }),
    ).rejects.toThrow('update_manager.spawnDefaultProvider must be a non-empty string when provided')
  })

  it('rejects update_manager with empty/whitespace spawnDefaultModelId', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.updateManager('manager', {
        managerId: 'manager',
        spawnDefaultProvider: 'claude-agent-sdk',
        spawnDefaultModelId: '  ',
      }),
    ).rejects.toThrow('update_manager.spawnDefaultModelId must be a non-empty string when provided')
  })

  it('persists spawnDefaultModel across saveStore/loadStore', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManager('manager', {
      managerId: 'manager',
      spawnDefaultProvider: 'claude-agent-sdk',
      spawnDefaultModelId: 'claude-opus-4-6',
      spawnDefaultThinkingLevel: 'low',
    })

    const rebooted = new TestSwarmManager(config)
    await rebooted.boot()

    const restoredManager = rebooted.getAgent('manager')
    expect(restoredManager?.spawnDefaultModel).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'low',
    })
  })

  it('maps create_manager model presets to canonical runtime models with highest reasoning', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const codexAppManager = await manager.createManager('manager', {
      name: 'Codex App Manager',
      cwd: config.defaultCwd,
      model: 'codex-app',
    })
    const claudeAgentSdkManager = await manager.createManager('manager', {
      name: 'Claude Agent SDK Manager',
      cwd: config.defaultCwd,
      model: 'claude-agent-sdk',
    })

    expect(codexAppManager.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
    expect(claudeAgentSdkManager.model).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })
  })

  it('defaults create_manager to claude-agent-sdk mapping when model is omitted', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createManager('manager', {
      name: 'Default Model Manager',
      cwd: config.defaultCwd,
    })

    expect(created.model).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })
  })

  it('creates managers from explicit provider/modelId create_manager payloads', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createManager('manager', {
      name: 'Explicit Manager',
      cwd: config.defaultCwd,
      provider: 'claude-agent-sdk',
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'high',
    })

    expect(created.model).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'high',
    })
  })

  it('rejects create_manager payloads that mix preset and explicit model descriptor fields', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.createManager('manager', {
        name: 'Invalid Mixed Manager',
        cwd: config.defaultCwd,
        model: 'codex-app',
        provider: 'claude-agent-sdk',
        modelId: 'claude-opus-4-6',
      }),
    ).rejects.toThrow(
      'create_manager.model cannot be combined with create_manager.provider or create_manager.modelId',
    )
  })

  it('rejects create_manager payloads that provide only provider or modelId in explicit mode', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.createManager('manager', {
        name: 'Missing Model Id',
        cwd: config.defaultCwd,
        provider: 'anthropic',
      }),
    ).rejects.toThrow(
      'create_manager.provider and create_manager.modelId are required together for explicit model creation',
    )

    await expect(
      manager.createManager('manager', {
        name: 'Missing Provider',
        cwd: config.defaultCwd,
        modelId: 'claude-opus-4-6',
      }),
    ).rejects.toThrow(
      'create_manager.provider and create_manager.modelId are required together for explicit model creation',
    )
  })

  it('rejects create_manager thinkingLevel when explicit provider/modelId are not provided', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.createManager('manager', {
        name: 'Thinking Without Explicit Descriptor',
        cwd: config.defaultCwd,
        thinkingLevel: 'low',
      }),
    ).rejects.toThrow(
      'create_manager.thinkingLevel is only supported with create_manager.provider and create_manager.modelId',
    )

    await expect(
      manager.createManager('manager', {
        name: 'Preset With Thinking',
        cwd: config.defaultCwd,
        model: 'codex-app',
        thinkingLevel: 'low',
      }),
    ).rejects.toThrow(
      'create_manager.thinkingLevel is only supported with create_manager.provider and create_manager.modelId',
    )
  })

  it('rejects invalid create_manager model presets with a clear error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.createManager('manager', {
        name: 'Invalid Manager',
        cwd: config.defaultCwd,
        model: 'invalid-model' as any,
      }),
    ).rejects.toThrow('create_manager.model must be one of codex-app|claude-agent-sdk')
  })

  it('maps spawn_agent model presets to canonical runtime models with highest reasoning', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const codexAppWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex App Worker',
      model: 'codex-app',
    })
    const claudeAgentSdkWorker = await manager.spawnAgent('manager', {
      agentId: 'Claude SDK Worker',
      model: 'claude-agent-sdk',
    })

    expect(codexAppWorker.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
    expect(claudeAgentSdkWorker.model).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })
  })

  it('rejects invalid spawn_agent model presets with a clear error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Invalid Worker',
        model: 'invalid-model' as any,
      }),
    ).rejects.toThrow('spawn_agent.model must be one of codex-app|claude-agent-sdk')
  })

  it('spawns a worker with explicit provider, modelId, and custom thinkingLevel', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Explicit Model Worker',
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'low',
    })

    expect(worker.model).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'low',
    })
  })

  it('spawns a worker with explicit provider and modelId using default thinkingLevel', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Explicit No Thinking Worker',
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
    })

    expect(worker.model).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })
  })

  it('rejects spawn_agent payloads that mix preset and explicit model descriptor fields', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Invalid Mixed Worker',
        model: 'codex-app',
        provider: 'claude-agent-sdk',
        modelId: 'claude-opus-4-6',
      }),
    ).rejects.toThrow(
      'spawn_agent.model cannot be combined with spawn_agent.provider or spawn_agent.modelId',
    )
  })

  it('rejects spawn_agent payloads that provide only provider or modelId in explicit mode', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Missing Model Id',
        provider: 'anthropic',
      }),
    ).rejects.toThrow(
      'spawn_agent.provider and spawn_agent.modelId are required together for explicit model selection',
    )

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Missing Provider',
        modelId: 'claude-opus-4-6',
      }),
    ).rejects.toThrow(
      'spawn_agent.provider and spawn_agent.modelId are required together for explicit model selection',
    )
  })

  it('rejects spawn_agent thinkingLevel when explicit provider/modelId are not provided', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Thinking Without Explicit Descriptor',
        thinkingLevel: 'low',
      }),
    ).rejects.toThrow(
      'spawn_agent.thinkingLevel is only supported with spawn_agent.provider and spawn_agent.modelId',
    )

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Preset With Thinking',
        model: 'codex-app',
        thinkingLevel: 'low',
      }),
    ).rejects.toThrow(
      'spawn_agent.thinkingLevel is only supported with spawn_agent.provider and spawn_agent.modelId',
    )
  })

  it('rejects spawn_agent with empty-string provider', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Empty Provider Worker',
        provider: '  ',
        modelId: 'claude-opus-4-6',
      }),
    ).rejects.toThrow('spawn_agent.provider must be a non-empty string when provided')
  })

  it('rejects spawn_agent with empty-string modelId', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Empty ModelId Worker',
        provider: 'anthropic',
        modelId: '  ',
      }),
    ).rejects.toThrow('spawn_agent.modelId must be a non-empty string when provided')
  })

  it('uses manager.model as spawn fallback when no spawn default is set', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const managerDescriptor = manager.getAgent('manager')
    expect(managerDescriptor?.spawnDefaultModel).toBeUndefined()

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Fallback Worker',
    })

    expect(worker.model).toEqual(managerDescriptor?.model)
  })

  it('uses spawnDefaultModel as spawn fallback when set on manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManager('manager', {
      managerId: 'manager',
      spawnDefaultProvider: 'claude-agent-sdk',
      spawnDefaultModelId: 'claude-opus-4-6',
      spawnDefaultThinkingLevel: 'low',
    })

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Spawn Default Worker',
    })

    expect(worker.model).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'low',
    })
  })

  it('LLM explicit model overrides spawn default', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManager('manager', {
      managerId: 'manager',
      spawnDefaultProvider: 'claude-agent-sdk',
      spawnDefaultModelId: 'claude-opus-4-6',
      spawnDefaultThinkingLevel: 'low',
    })

    const worker = await manager.spawnAgent('manager', {
      agentId: 'LLM Override Worker',
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    })

    expect(worker.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    })
  })

  it('LLM explicit preset overrides spawn default', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManager('manager', {
      managerId: 'manager',
      spawnDefaultProvider: 'claude-agent-sdk',
      spawnDefaultModelId: 'claude-opus-4-6',
      spawnDefaultThinkingLevel: 'low',
    })

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Preset Override Worker',
      model: 'codex-app',
    })

    expect(worker.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
  })

  it('allows deleting the default manager when requested', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const deleted = await manager.deleteManager('manager', 'manager')

    expect(deleted.managerId).toBe('manager')
    expect(deleted.terminatedWorkerIds).toEqual([])
    expect(manager.listAgents()).toHaveLength(0)
  })

  it('allows bootstrapping a new manager after deleting the last running manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.deleteManager('manager', 'manager')

    const recreated = await manager.createManager('manager', {
      name: 'Recreated Manager',
      cwd: config.defaultCwd,
    })

    expect(recreated.role).toBe('manager')
    expect(manager.listAgents().some((agent) => agent.agentId === recreated.agentId)).toBe(true)
  })

  it('enforces strict manager ownership for worker control operations', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Delivery Manager',
      cwd: config.defaultCwd,
    })
    const worker = await manager.spawnAgent(secondary.agentId, { agentId: 'Delivery Worker' })

    await expect(manager.killAgent('manager', worker.agentId)).rejects.toThrow(
      `Only owning manager can kill agent ${worker.agentId}`,
    )
    await expect(manager.sendMessage('manager', worker.agentId, 'cross-manager control')).rejects.toThrow(
      `Manager manager does not own worker ${worker.agentId}`,
    )

    await manager.killAgent(secondary.agentId, worker.agentId)
    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')
  })

  it('routes user-to-worker delivery through the owning manager context', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Routing Manager',
      cwd: config.defaultCwd,
    })
    const worker = await manager.spawnAgent(secondary.agentId, { agentId: 'Routing Worker' })

    await manager.handleUserMessage('hello owned worker', { targetAgentId: worker.agentId })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('hello owned worker')
  })

  it('accepts any existing directory for manager and worker creation', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const outsideDir = await mkdtemp(join(tmpdir(), 'outside-allowlist-'))

    const externalManager = await manager.createManager('manager', {
      name: 'External Manager',
      cwd: outsideDir,
    })

    const externalWorker = await manager.spawnAgent(externalManager.agentId, {
      agentId: 'External Worker',
      cwd: outsideDir,
    })

    const validation = await manager.validateDirectory(outsideDir)
    const listed = await manager.listDirectories(outsideDir)

    expect(externalManager.cwd).toBe(validation.resolvedPath)
    expect(externalWorker.cwd).toBe(validation.resolvedPath)
    expect(validation.valid).toBe(true)
    expect(validation.message).toBeUndefined()
    expect(listed.resolvedPath).toBe(validation.resolvedPath)
    expect(listed.roots).toEqual([])
  })

  // --- updateAgentModel tests ---

  it('updateAgentModel updates manager thinking level without reset', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const initialDescriptor = manager.getAgent('manager')
    expect(initialDescriptor?.model.thinkingLevel).toBe('xhigh')

    const result = await manager.updateAgentModel('manager', {
      agentId: 'manager',
      thinkingLevel: 'low',
    })

    expect(result.agent.model.thinkingLevel).toBe('low')
    expect(result.agent.model.provider).toBe('claude-agent-sdk')
    expect(result.agent.model.modelId).toBe('claude-opus-4-6')
    // Same-provider change should not create a second runtime (no reset).
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(1)
  })

  it('updateAgentModel updates manager modelId without reset when same provider', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const result = await manager.updateAgentModel('manager', {
      agentId: 'manager',
      modelId: 'claude-sonnet-4-5',
    })

    expect(result.agent.model.modelId).toBe('claude-sonnet-4-5')
    expect(result.agent.model.provider).toBe('claude-agent-sdk')
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(1)
  })

  it('updateAgentModel updates worker thinking level in place', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker' })
    expect(worker.model.thinkingLevel).toBe('xhigh')

    const result = await manager.updateAgentModel('manager', {
      agentId: worker.agentId,
      thinkingLevel: 'medium',
    })

    expect(result.agent.model.thinkingLevel).toBe('medium')
    expect(result.agent.model.provider).toBe(worker.model.provider)
    expect(result.agent.model.modelId).toBe(worker.model.modelId)
    // Worker runtimes should not be recreated.
    expect(manager.createdRuntimeIds.filter((id) => id === worker.agentId)).toHaveLength(1)
  })

  it('updateAgentModel updates worker modelId in place', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker' })

    const result = await manager.updateAgentModel('manager', {
      agentId: worker.agentId,
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'low',
    })

    expect(result.agent.model.modelId).toBe('claude-sonnet-4-5')
    expect(result.agent.model.thinkingLevel).toBe('low')
    expect(result.agent.model.provider).toBe(worker.model.provider)
  })

  it('updateAgentModel rejects when agent does not exist', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.updateAgentModel('manager', {
        agentId: 'nonexistent',
        thinkingLevel: 'low',
      }),
    ).rejects.toThrow('Unknown agent: nonexistent')
  })

  it('updateAgentModel rejects when worker is terminated', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker' })
    await manager.killAgent('manager', worker.agentId)

    await expect(
      manager.updateAgentModel('manager', {
        agentId: worker.agentId,
        thinkingLevel: 'low',
      }),
    ).rejects.toThrow(`Agent is not running: ${worker.agentId}`)
  })

  it('updateAgentModel returns current descriptor when no effective change on worker', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker' })
    const beforeUpdate = manager.getAgent(worker.agentId)

    const result = await manager.updateAgentModel('manager', {
      agentId: worker.agentId,
      modelId: worker.model.modelId,
      thinkingLevel: worker.model.thinkingLevel,
    })

    expect(result.agent.model).toEqual(worker.model)
    expect(result.agent.updatedAt).toBe(beforeUpdate?.updatedAt)
  })

  it('updateAgentModel rejects when no fields provided', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.updateAgentModel('manager', {
        agentId: 'manager',
      }),
    ).rejects.toThrow('At least one of modelId or thinkingLevel must be provided')
  })

  it('updateAgentModel rejects when called by a non-manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker' })

    await expect(
      manager.updateAgentModel(worker.agentId, {
        agentId: worker.agentId,
        thinkingLevel: 'low',
      }),
    ).rejects.toThrow('Only manager can update agent model')
  })

  describe('cross-manager messaging', () => {
    it('delivers a message from one manager to another', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      const primary = await bootWithDefaultManager(manager, config)

      const secondary = await manager.createManager(primary.agentId, {
        name: 'Peer Manager',
        cwd: config.defaultCwd,
      })

      const receipt = await manager.sendMessage(primary.agentId, secondary.agentId, 'hello peer')

      expect(receipt.targetAgentId).toBe(secondary.agentId)
      expect(receipt.deliveryId).toBeDefined()

      const secondaryRuntime = manager.runtimeByAgentId.get(secondary.agentId)
      expect(secondaryRuntime?.sendCalls.length).toBeGreaterThanOrEqual(1)
      const lastCall = secondaryRuntime?.sendCalls.at(-1)
      expect(typeof lastCall?.message === 'string' ? lastCall.message : '').toContain('hello peer')
    })

    it('records the message in both managers conversation histories', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      const primary = await bootWithDefaultManager(manager, config)

      const secondary = await manager.createManager(primary.agentId, {
        name: 'History Manager',
        cwd: config.defaultCwd,
      })

      await manager.sendMessage(primary.agentId, secondary.agentId, 'coordination msg')

      const primaryHistory = manager.getConversationHistory(primary.agentId)
      const secondaryHistory = manager.getConversationHistory(secondary.agentId)

      const primaryEvent = primaryHistory.find(
        (entry) => entry.type === 'agent_message' && 'fromAgentId' in entry && entry.fromAgentId === primary.agentId,
      )
      const secondaryEvent = secondaryHistory.find(
        (entry) => entry.type === 'agent_message' && 'fromAgentId' in entry && entry.fromAgentId === primary.agentId,
      )

      expect(primaryEvent).toBeDefined()
      expect(secondaryEvent).toBeDefined()
      expect(primaryEvent?.type).toBe('agent_message')
      expect(secondaryEvent?.type).toBe('agent_message')
    })

    it('produces a single history entry for self-messages', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      const primary = await bootWithDefaultManager(manager, config)

      await manager.sendMessage(primary.agentId, primary.agentId, 'note to self')

      const history = manager.getConversationHistory(primary.agentId)
      const selfEvents = history.filter(
        (entry) =>
          entry.type === 'agent_message' &&
          'fromAgentId' in entry &&
          entry.fromAgentId === primary.agentId &&
          'toAgentId' in entry &&
          entry.toAgentId === primary.agentId,
      )

      // Self-messages: fromAgentId === targetAgentId, so the condition `fromAgentId !== targetAgentId` in
      // sendMessage() skips agent_message emission entirely. Runtime still receives the message.
      expect(selfEvents).toHaveLength(0)

      const runtime = manager.runtimeByAgentId.get(primary.agentId)
      expect(runtime?.sendCalls.length).toBeGreaterThanOrEqual(1)
    })

    it('rejects empty messages', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      const primary = await bootWithDefaultManager(manager, config)

      const secondary = await manager.createManager(primary.agentId, {
        name: 'Empty Msg Manager',
        cwd: config.defaultCwd,
      })

      await expect(manager.sendMessage(primary.agentId, secondary.agentId, '')).rejects.toThrow(
        'Message text cannot be empty',
      )
      await expect(manager.sendMessage(primary.agentId, secondary.agentId, '   ')).rejects.toThrow(
        'Message text cannot be empty',
      )
    })

    it('rejects messages to a non-running manager', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      const primary = await bootWithDefaultManager(manager, config)

      const secondary = await manager.createManager(primary.agentId, {
        name: 'Stopped Manager',
        cwd: config.defaultCwd,
      })

      await manager.deleteManager(primary.agentId, secondary.agentId)

      await expect(manager.sendMessage(primary.agentId, secondary.agentId, 'hello')).rejects.toThrow(
        /Target agent is not running|Unknown target agent/,
      )
    })

    it('enforces cross-manager rate limit on rapid messages', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      const primary = await bootWithDefaultManager(manager, config)

      const secondary = await manager.createManager(primary.agentId, {
        name: 'Rate Limit Manager',
        cwd: config.defaultCwd,
      })

      for (let i = 0; i < 20; i++) {
        await manager.sendMessage(primary.agentId, secondary.agentId, `msg-${i}`)
      }

      await expect(manager.sendMessage(primary.agentId, secondary.agentId, 'msg-overflow')).rejects.toThrow(
        'Cross-manager message rate limit exceeded',
      )
    })

    it('tracks rate limit per directed pair independently', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      const primary = await bootWithDefaultManager(manager, config)

      const secondary = await manager.createManager(primary.agentId, {
        name: 'Bidirectional Manager',
        cwd: config.defaultCwd,
      })

      for (let i = 0; i < 15; i++) {
        await manager.sendMessage(primary.agentId, secondary.agentId, `a-to-b-${i}`)
      }
      for (let i = 0; i < 15; i++) {
        await manager.sendMessage(secondary.agentId, primary.agentId, `b-to-a-${i}`)
      }

      // Both directions stay under the 20-per-pair limit, so all 30 should succeed
      const secondaryRuntime = manager.runtimeByAgentId.get(secondary.agentId)
      const primaryRuntime = manager.runtimeByAgentId.get(primary.agentId)
      expect(secondaryRuntime?.sendCalls.length).toBeGreaterThanOrEqual(15)
      expect(primaryRuntime?.sendCalls.length).toBeGreaterThanOrEqual(15)
    })

    it('still blocks manager from messaging a foreign worker', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      const primary = await bootWithDefaultManager(manager, config)

      const secondary = await manager.createManager(primary.agentId, {
        name: 'Foreign Owner',
        cwd: config.defaultCwd,
      })
      const worker = await manager.spawnAgent(secondary.agentId, { agentId: 'Foreign Worker' })

      await expect(manager.sendMessage(primary.agentId, worker.agentId, 'cross-boundary')).rejects.toThrow(
        `Manager ${primary.agentId} does not own worker ${worker.agentId}`,
      )
    })

    it('delivers cross-manager message with SYSTEM prefix', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      const primary = await bootWithDefaultManager(manager, config)

      const secondary = await manager.createManager(primary.agentId, {
        name: 'Prefix Manager',
        cwd: config.defaultCwd,
      })

      await manager.sendMessage(primary.agentId, secondary.agentId, 'coordination request')

      const secondaryRuntime = manager.runtimeByAgentId.get(secondary.agentId)
      const lastCall = secondaryRuntime?.sendCalls.at(-1)
      const messageText = typeof lastCall?.message === 'string' ? lastCall.message : ''
      expect(messageText).toContain('SYSTEM')
      expect(messageText).toContain('coordination request')
    })
  })

  describe('dual-sided agent_message history', () => {
    it('records agent_message in both manager and worker histories when manager messages worker', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const worker = await manager.spawnAgent('manager', { agentId: 'History Worker' })
      await manager.sendMessage('manager', worker.agentId, 'task for worker')

      const managerHistory = manager.getConversationHistory('manager')
      const workerHistory = manager.getConversationHistory(worker.agentId)

      const managerEvent = managerHistory.find(
        (e) => e.type === 'agent_message' && 'fromAgentId' in e && e.fromAgentId === 'manager' && 'toAgentId' in e && e.toAgentId === worker.agentId,
      )
      const workerEvent = workerHistory.find(
        (e) => e.type === 'agent_message' && 'fromAgentId' in e && e.fromAgentId === 'manager' && 'toAgentId' in e && e.toAgentId === worker.agentId,
      )

      expect(managerEvent).toBeDefined()
      expect(workerEvent).toBeDefined()
      expect(managerEvent!.agentId).toBe('manager')
      expect(workerEvent!.agentId).toBe(worker.agentId)
    })

    it('records agent_message in both worker and manager histories when worker messages manager', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const worker = await manager.spawnAgent('manager', { agentId: 'Reporting Worker' })
      await manager.sendMessage(worker.agentId, 'manager', 'results ready')

      const managerHistory = manager.getConversationHistory('manager')
      const workerHistory = manager.getConversationHistory(worker.agentId)

      const managerEvent = managerHistory.find(
        (e) => e.type === 'agent_message' && 'fromAgentId' in e && e.fromAgentId === worker.agentId,
      )
      const workerEvent = workerHistory.find(
        (e) => e.type === 'agent_message' && 'fromAgentId' in e && e.fromAgentId === worker.agentId,
      )

      expect(managerEvent).toBeDefined()
      expect(workerEvent).toBeDefined()
      expect(managerEvent!.agentId).toBe('manager')
      expect(workerEvent!.agentId).toBe(worker.agentId)
    })

    it('does not produce duplicate agent_message in manager history for manager-to-worker sends', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const worker = await manager.spawnAgent('manager', { agentId: 'Dedup Worker' })
      await manager.sendMessage('manager', worker.agentId, 'single delivery')

      const managerHistory = manager.getConversationHistory('manager')
      const managerEvents = managerHistory.filter(
        (e) => e.type === 'agent_message' && 'text' in e && e.text === 'single delivery',
      )

      expect(managerEvents).toHaveLength(1)
    })

    it('does not emit agent_message events for user-origin worker messages', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const worker = await manager.spawnAgent('manager', { agentId: 'User Target Worker' })
      await manager.handleUserMessage('hello from user', { targetAgentId: worker.agentId })

      const managerHistory = manager.getConversationHistory('manager')
      const workerHistory = manager.getConversationHistory(worker.agentId)

      expect(managerHistory.filter((e) => e.type === 'agent_message')).toHaveLength(0)
      expect(workerHistory.filter((e) => e.type === 'agent_message')).toHaveLength(0)
    })

    it('records agent_message in both histories when spawnAgent sends an initial message', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const worker = await manager.spawnAgent('manager', {
        agentId: 'Init Worker',
        initialMessage: 'bootstrap task',
      })

      const managerHistory = manager.getConversationHistory('manager')
      const workerHistory = manager.getConversationHistory(worker.agentId)

      const managerEvent = managerHistory.find(
        (e) => e.type === 'agent_message' && 'text' in e && e.text === 'bootstrap task',
      )
      const workerEvent = workerHistory.find(
        (e) => e.type === 'agent_message' && 'text' in e && e.text === 'bootstrap task',
      )

      expect(managerEvent).toBeDefined()
      expect(workerEvent).toBeDefined()
    })
  })

  describe('handleRuntimeStatus stale runtime cleanup', () => {
    it('removes stale runtime from runtimes map when status transitions to terminated', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      seedManagerDescriptorForRuntimeEventTests(manager, config)

      const descriptor = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors.get('manager')!
      const runtimesMap = (manager as unknown as { runtimes: Map<string, unknown> }).runtimes
      const fakeRuntime = new FakeRuntime(descriptor)
      runtimesMap.set('manager', fakeRuntime as unknown as import('../swarm/runtime-types.js').SwarmAgentRuntime)

      await (manager as unknown as { handleRuntimeStatus: (agentId: string, status: string, pendingCount: number) => Promise<void> })
        .handleRuntimeStatus.call(manager, 'manager', 'terminated', 0)

      expect(runtimesMap.has('manager')).toBe(false)
      expect(descriptor.status).toBe('terminated')
    })

    it('does not remove runtime when status transitions to idle', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      seedManagerDescriptorForRuntimeEventTests(manager, config)

      const descriptor = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors.get('manager')!
      descriptor.status = 'streaming'
      const runtimesMap = (manager as unknown as { runtimes: Map<string, unknown> }).runtimes
      const fakeRuntime = new FakeRuntime(descriptor)
      runtimesMap.set('manager', fakeRuntime as unknown as import('../swarm/runtime-types.js').SwarmAgentRuntime)

      await (manager as unknown as { handleRuntimeStatus: (agentId: string, status: string, pendingCount: number) => Promise<void> })
        .handleRuntimeStatus.call(manager, 'manager', 'idle', 0)

      expect(runtimesMap.has('manager')).toBe(true)
      expect(descriptor.status).toBe('idle')
    })
  })

  describe('restartManager', () => {
    it('transitions terminated manager to idle and creates new runtime', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const previousRuntime = manager.runtimeByAgentId.get('manager')
      const createdBefore = manager.createdRuntimeIds.filter((id) => id === 'manager').length

      // Terminate the manager descriptor manually (simulating a crash)
      const descriptors = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors
      const runtimes = (manager as unknown as { runtimes: Map<string, unknown> }).runtimes
      const descriptor = descriptors.get('manager')!
      descriptor.status = 'terminated'
      runtimes.delete('manager')

      const restarted = await manager.restartManager('manager', 'manager')
      expect(restarted.status).toBe('idle')
      expect(manager.runtimeByAgentId.get('manager')).toBeDefined()
      expect(manager.runtimeByAgentId.get('manager')).not.toBe(previousRuntime)
      expect(manager.createdRuntimeIds.filter((id) => id === 'manager').length).toBe(createdBefore + 1)
    })

    it('preserves conversation history on restart', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      // Seed conversation history directly
      const conversationEntries = (manager as unknown as {
        conversationEntriesByAgentId: Map<string, unknown[]>
      }).conversationEntriesByAgentId
      conversationEntries.set('manager', [
        { type: 'conversation_message', agentId: 'manager', role: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
      ])
      expect(manager.getConversationHistory('manager').length).toBe(1)

      const descriptors = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors
      const runtimes = (manager as unknown as { runtimes: Map<string, unknown> }).runtimes
      descriptors.get('manager')!.status = 'terminated'
      runtimes.delete('manager')

      await manager.restartManager('manager', 'manager')

      // restartManager should NOT reset conversation history
      expect(manager.getConversationHistory('manager').length).toBe(1)
    })

    it('preserves session file on restart (does not delete it)', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const descriptor = manager.listAgents().find((a) => a.agentId === 'manager')!
      // Seed a session file to verify restart does not delete it
      const sentinel = '{"sentinel":true}\n'
      await writeFile(descriptor.sessionFile, sentinel, 'utf8')
      expect(existsSync(descriptor.sessionFile)).toBe(true)

      const descriptors = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors
      const runtimes = (manager as unknown as { runtimes: Map<string, unknown> }).runtimes
      descriptors.get('manager')!.status = 'terminated'
      runtimes.delete('manager')

      await manager.restartManager('manager', 'manager')
      // Session file must still exist (not deleted like resetManagerSession would)
      expect(existsSync(descriptor.sessionFile)).toBe(true)
    })

    it('cleans up stale runtime before creating new one', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const staleRuntime = manager.runtimeByAgentId.get('manager')!
      const descriptors = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors
      descriptors.get('manager')!.status = 'terminated'

      await manager.restartManager('manager', 'manager')

      expect(staleRuntime.terminateCalls.length).toBeGreaterThan(0)
      expect(manager.runtimeByAgentId.get('manager')).not.toBe(staleRuntime)
    })

    it('is a no-op for already-idle manager with live runtime', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)
      const runtimeCountBefore = manager.createdRuntimeIds.filter((id) => id === 'manager').length

      const result = await manager.restartManager('manager', 'manager')
      expect(result.status).toBe('idle')
      expect(manager.createdRuntimeIds.filter((id) => id === 'manager').length).toBe(runtimeCountBefore)
    })

    it('throws for unknown manager id', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      await expect(manager.restartManager('manager', 'nonexistent')).rejects.toThrow('Unknown manager')
    })

    it('throws for worker agent id', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const worker = await manager.spawnAgent('manager', { agentId: 'worker-1' } as any)

      await expect(manager.restartManager('manager', worker.agentId)).rejects.toThrow('Unknown manager')
    })

    it('works for stopped manager', async () => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const previousRuntime = manager.runtimeByAgentId.get('manager')
      const createdBefore = manager.createdRuntimeIds.filter((id) => id === 'manager').length

      const descriptors = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors
      const runtimes = (manager as unknown as { runtimes: Map<string, unknown> }).runtimes
      descriptors.get('manager')!.status = 'stopped'
      runtimes.delete('manager')

      const restarted = await manager.restartManager('manager', 'manager')
      expect(restarted.status).toBe('idle')
      expect(manager.runtimeByAgentId.get('manager')).toBeDefined()
      expect(manager.runtimeByAgentId.get('manager')).not.toBe(previousRuntime)
      expect(manager.createdRuntimeIds.filter((id) => id === 'manager').length).toBe(createdBefore + 1)
    })
  })
})
