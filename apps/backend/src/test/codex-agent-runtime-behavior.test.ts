import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeErrorEvent, RuntimeSessionEvent } from '../swarm/runtime-types.js'
import type { AgentDescriptor, AgentStatus } from '../swarm/types.js'

const rpcMockState = vi.hoisted(() => ({
  requestImpl: vi.fn<(...args: [any, string, unknown?]) => Promise<unknown>>(async () => ({})),
  instances: [] as any[],
}))

vi.mock('../swarm/codex-jsonrpc-client.js', () => ({
  CodexJsonRpcClient: class MockCodexJsonRpcClient {
    readonly options: {
      onNotification?: (notification: unknown) => Promise<void> | void
      onRequest?: (request: unknown) => Promise<unknown>
      onExit?: (error: Error) => void
    }

    readonly requestCalls: Array<{ method: string; params: unknown }> = []
    readonly notifyCalls: Array<{ method: string; params: unknown }> = []
    disposed = false

    constructor(options: {
      onNotification?: (notification: unknown) => Promise<void> | void
      onRequest?: (request: unknown) => Promise<unknown>
      onExit?: (error: Error) => void
    }) {
      this.options = options
      rpcMockState.instances.push(this)
    }

    async request(method: string, params?: unknown): Promise<unknown> {
      this.requestCalls.push({ method, params })
      return await rpcMockState.requestImpl(this, method, params)
    }

    notify(method: string, params?: unknown): void {
      this.notifyCalls.push({ method, params })
    }

    dispose(): void {
      this.disposed = true
    }

    async emitNotification(notification: unknown): Promise<void> {
      await this.options.onNotification?.(notification)
    }

    emitExit(error: Error): void {
      this.options.onExit?.(error)
    }
  },
}))

import { CodexAgentRuntime } from '../swarm/codex-agent-runtime.js'

function makeDescriptor(
  baseDir: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    agentId: 'codex-worker',
    displayName: 'Codex Worker',
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: baseDir,
    model: {
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
      ...modelOverrides,
    },
    sessionFile: join(baseDir, 'sessions', 'codex-worker.jsonl'),
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })

  return { promise, resolve }
}

beforeEach(() => {
  rpcMockState.instances.length = 0
  rpcMockState.requestImpl.mockReset()
  rpcMockState.requestImpl.mockImplementation(async () => ({}))
})

describe('CodexAgentRuntime behavior', () => {
  it('persists codex runtime state custom entry to session file during bootstrap', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-bootstrap' } }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    const persistedSession = await readFile(descriptor.sessionFile, 'utf8')
    expect(persistedSession).toContain('"type":"session"')
    expect(persistedSession).toContain('"customType":"swarm_codex_runtime_state"')
    expect(persistedSession).toContain('"threadId":"thread-bootstrap"')

    await runtime.terminate({ abort: false })
  })

  it('resumes persisted codex thread id across runtime restart', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir, {
      modelId: 'restart-model',
    })
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    let phase: 'first-run' | 'second-run' = 'first-run'
    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (phase === 'first-run' && method === 'thread/start') {
        expect(params).toMatchObject({
          model: 'restart-model',
        })
        return { thread: { id: 'thread-first' } }
      }

      if (phase === 'second-run' && method === 'thread/resume') {
        expect(params).toMatchObject({
          threadId: 'thread-first',
          model: 'restart-model',
        })
        return { thread: { id: 'thread-first' } }
      }

      throw new Error(`Unexpected method in ${phase}: ${method}`)
    })

    const runtime1 = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })
    await runtime1.terminate({ abort: false })

    phase = 'second-run'

    const runtime2 = await CodexAgentRuntime.create({
      descriptor: {
        ...descriptor,
        status: 'idle',
      },
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })
    await runtime2.terminate({ abort: false })

    const firstInstance = rpcMockState.instances[0]
    const secondInstance = rpcMockState.instances[1]
    expect(firstInstance.requestCalls.some((entry: { method: string }) => entry.method === 'thread/start')).toBe(true)
    expect(firstInstance.requestCalls.some((entry: { method: string }) => entry.method === 'thread/resume')).toBe(false)
    expect(secondInstance.requestCalls.some((entry: { method: string }) => entry.method === 'thread/resume')).toBe(true)
    expect(secondInstance.requestCalls.some((entry: { method: string }) => entry.method === 'thread/start')).toBe(false)
  })

  it('authenticates with CODEX_API_KEY and resumes a persisted thread', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const runtimePrototype = CodexAgentRuntime.prototype as any
    const originalReadPersistedState = runtimePrototype.readPersistedRuntimeState
    runtimePrototype.readPersistedRuntimeState = () => ({
      threadId: 'persisted-thread',
    })

    const previousApiKey = process.env.CODEX_API_KEY
    process.env.CODEX_API_KEY = 'sk-test-key'

    try {
      let accountReadCalls = 0

      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          accountReadCalls += 1
          if (accountReadCalls === 1) {
            return { requiresOpenaiAuth: true, account: null }
          }

          return { requiresOpenaiAuth: true, account: { id: 'acct-1' } }
        }

        if (method === 'account/login/start') {
          expect(params).toMatchObject({
            type: 'apiKey',
            apiKey: 'sk-test-key',
          })
          return { ok: true }
        }

        if (method === 'thread/resume') {
          expect(params).toMatchObject({
            threadId: 'persisted-thread',
            cwd: descriptor.cwd,
            model: descriptor.model.modelId,
          })
          return { thread: { id: 'resumed-thread' } }
        }

        throw new Error(`Unexpected method: ${method}`)
      })

      const runtime = await CodexAgentRuntime.create({
        descriptor,
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a test codex runtime.',
        tools: [],
      })

      const instance = rpcMockState.instances[0]
      const calledMethods = instance.requestCalls.map((entry: { method: string }) => entry.method)

      expect(calledMethods).toContain('account/login/start')
      expect(calledMethods).toContain('thread/resume')
      expect(calledMethods).not.toContain('thread/start')

      await runtime.terminate({ abort: false })
    } finally {
      runtimePrototype.readPersistedRuntimeState = originalReadPersistedState
      if (previousApiKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = previousApiKey
      }
    }
  })

  it('falls back to thread/start when thread/resume fails and throws when auth is still missing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const runtimePrototype = CodexAgentRuntime.prototype as any
    const originalReadPersistedState = runtimePrototype.readPersistedRuntimeState
    runtimePrototype.readPersistedRuntimeState = () => ({
      threadId: 'stale-thread',
    })

    try {
      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          return { requiresOpenaiAuth: false, account: { id: 'acct-2' } }
        }

        if (method === 'thread/resume') {
          throw new Error('resume failed')
        }

        if (method === 'thread/start') {
          expect(params).toMatchObject({
            model: 'default',
          })
          return { thread: { id: 'new-thread' } }
        }

        throw new Error(`Unexpected method: ${method}`)
      })

      const runtime = await CodexAgentRuntime.create({
        descriptor: makeDescriptor(tempDir),
        callbacks: {
          onStatusChange: async () => {},
        },
        systemPrompt: 'You are a test codex runtime.',
        tools: [],
      })

      const instance = rpcMockState.instances[0]
      const calledMethods = instance.requestCalls.map((entry: { method: string }) => entry.method)
      expect(calledMethods).toContain('thread/resume')
      expect(calledMethods).toContain('thread/start')

      await runtime.terminate({ abort: false })

      rpcMockState.instances.length = 0
      rpcMockState.requestImpl.mockReset()
      rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
        if (method === 'initialize') {
          return {}
        }

        if (method === 'account/read') {
          return { requiresOpenaiAuth: true, account: null }
        }

        return {}
      })

      await expect(
        CodexAgentRuntime.create({
          descriptor: makeDescriptor(tempDir),
          callbacks: {
            onStatusChange: async () => {},
          },
          systemPrompt: 'You are a test codex runtime.',
          tools: [],
        }),
      ).rejects.toThrow('Codex runtime requires authentication.')

      const failedInstance = rpcMockState.instances[0]
      expect(failedInstance.disposed).toBe(true)
    } finally {
      runtimePrototype.readPersistedRuntimeState = originalReadPersistedState
    }
  })

  it('queues steer while turn/start is pending and flushes steers in order once start resolves', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const turnStartDeferred = createDeferred<{ turn: { id: string } }>()

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      if (method === 'model/list') {
        return {
          data: [
            {
              id: 'default',
              model: 'default',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'low' },
                { reasoningEffort: 'xhigh', description: 'xhigh' },
              ],
            },
          ],
        }
      }

      if (method === 'turn/start') {
        expect(params).toMatchObject({
          model: 'default',
          effort: 'xhigh',
        })
        return await turnStartDeferred.promise
      }

      if (method === 'turn/steer') {
        return {
          accepted: true,
          input: params,
        }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    const firstPromise = runtime.sendMessage('first prompt')
    await Promise.resolve()

    const queuedOne = await runtime.sendMessage('queued steer one')
    const queuedTwo = await runtime.sendMessage('queued steer two')
    expect(queuedOne.acceptedMode).toBe('steer')
    expect(queuedTwo.acceptedMode).toBe('steer')

    turnStartDeferred.resolve({ turn: { id: 'turn-1' } })

    const first = await firstPromise
    expect(first.acceptedMode).toBe('prompt')

    const instance = rpcMockState.instances[0]
    const requestMethods = instance.requestCalls.map((entry: { method: string }) => entry.method)
    const steerCalls = instance.requestCalls.filter((entry: { method: string }) => entry.method === 'turn/steer')

    expect(requestMethods).toEqual(expect.arrayContaining(['turn/start', 'turn/steer', 'turn/steer']))
    expect(steerCalls).toHaveLength(2)
    expect(steerCalls[0]?.params).toMatchObject({
      expectedTurnId: 'turn-1',
    })
    expect(steerCalls[1]?.params).toMatchObject({
      expectedTurnId: 'turn-1',
    })

    await runtime.terminate({ abort: false })
  })

  it('translates turn notifications, handles runtime exit, and reports terminated status', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    const statuses: AgentStatus[] = []
    const sessionEvents: RuntimeSessionEvent[] = []
    const runtimeErrors: RuntimeErrorEvent[] = []
    let agentEndCalls = 0

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      return {}
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (_agentId, status) => {
          statuses.push(status)
        },
        onSessionEvent: async (_agentId, event) => {
          sessionEvents.push(event)
        },
        onRuntimeError: async (_agentId, event) => {
          runtimeErrors.push(event)
        },
        onAgentEnd: async () => {
          agentEndCalls += 1
        },
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    const instance = rpcMockState.instances[0]
    await instance.emitNotification({
      method: 'turn/started',
      params: {
        turn: { id: 'turn-42' },
      },
    })
    await instance.emitNotification({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'Hello from codex',
      },
    })
    await instance.emitNotification({
      method: 'turn/completed',
    })

    expect(statuses).toContain('streaming')
    expect(statuses).toContain('idle')
    expect(agentEndCalls).toBe(1)
    expect(sessionEvents).toContainEqual(
      expect.objectContaining({
        type: 'message_update',
        message: {
          role: 'assistant',
          content: 'Hello from codex',
        },
      }),
    )

    instance.emitExit(new Error('app-server crashed'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtimeErrors).toContainEqual(
      expect.objectContaining({
        phase: 'runtime_exit',
        message: 'app-server crashed',
      }),
    )
    expect(runtime.getStatus()).toBe('terminated')
    expect(statuses.at(-1)).toBe('terminated')
    expect(sessionEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool_execution_end',
        toolName: 'codex-app-server',
        isError: true,
      }),
    )
    await expect(runtime.sendMessage('after exit')).rejects.toThrow('is terminated')
  })

  it('interrupts active turns during terminate() and clears pending queues', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir)
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } }
      }

      if (method === 'model/list') {
        return {
          data: [
            {
              id: 'default',
              model: 'default',
              supportedReasoningEfforts: [
                { reasoningEffort: 'minimal', description: 'minimal' },
                { reasoningEffort: 'high', description: 'high' },
              ],
            },
          ],
        }
      }

      if (method === 'turn/start') {
        return { turn: { id: 'turn-1' } }
      }

      if (method === 'turn/steer') {
        return { ok: true }
      }

      if (method === 'turn/interrupt') {
        return { interrupted: true }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    await runtime.sendMessage('start a turn')
    await runtime.sendMessage('queue while active')
    expect(runtime.getPendingCount()).toBe(1)

    await runtime.terminate()

    const instance = rpcMockState.instances[0]
    expect(
      instance.requestCalls.some(
        (entry: { method: string; params: { turnId?: string } }) =>
          entry.method === 'turn/interrupt' && entry.params?.turnId === 'turn-1',
      ),
    ).toBe(true)
    expect(runtime.getPendingCount()).toBe(0)
    expect(runtime.getStatus()).toBe('terminated')
  })

  it('clamps unsupported requested effort to nearest supported lower effort', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir, {
      modelId: 'gpt-floor',
      thinkingLevel: 'xhigh',
    })
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        expect(params).toMatchObject({
          model: 'gpt-floor',
        })
        return { thread: { id: 'thread-floor' } }
      }

      if (method === 'model/list') {
        return {
          data: [
            {
              id: 'gpt-floor',
              model: 'gpt-floor',
              supportedReasoningEfforts: [
                { reasoningEffort: 'minimal', description: 'minimal' },
                { reasoningEffort: 'medium', description: 'medium' },
              ],
            },
          ],
        }
      }

      if (method === 'turn/start') {
        expect(params).toMatchObject({
          model: 'gpt-floor',
          effort: 'medium',
        })
        return { turn: { id: 'turn-floor' } }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    await runtime.sendMessage('trigger floor clamp')
    await runtime.terminate({ abort: false })
  })

  it('uses the minimum supported effort when requested effort is below all supported efforts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir, {
      modelId: 'gpt-minimum',
      thinkingLevel: 'off',
    })
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-min' } }
      }

      if (method === 'model/list') {
        return {
          data: [
            {
              id: 'gpt-minimum',
              model: 'gpt-minimum',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'low' },
                { reasoningEffort: 'high', description: 'high' },
              ],
            },
          ],
        }
      }

      if (method === 'turn/start') {
        expect(params).toMatchObject({
          model: 'gpt-minimum',
          effort: 'low',
        })
        return { turn: { id: 'turn-min' } }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    await runtime.sendMessage('trigger minimum clamp')
    await runtime.terminate({ abort: false })
  })

  it('falls back to mapped effort when model/list is unavailable', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir, {
      modelId: 'gpt-fallback',
      thinkingLevel: 'high',
    })
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-fallback' } }
      }

      if (method === 'model/list') {
        throw new Error('model list unavailable')
      }

      if (method === 'turn/start') {
        expect(params).toMatchObject({
          model: 'gpt-fallback',
          effort: 'high',
        })
        return { turn: { id: 'turn-fallback' } }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    await runtime.sendMessage('trigger fallback')
    await runtime.terminate({ abort: false })
  })

  it('retries model/list after transient failure and clamps recovered effort on next turn', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'swarm-codex-runtime-'))
    const descriptor = makeDescriptor(tempDir, {
      modelId: 'gpt-recover',
      thinkingLevel: 'xhigh',
    })
    await mkdir(dirname(descriptor.sessionFile), { recursive: true })

    let modelListCalls = 0
    let turnStartCalls = 0

    rpcMockState.requestImpl.mockImplementation(async (_client: any, method: string, params: unknown) => {
      if (method === 'initialize') {
        return {}
      }

      if (method === 'account/read') {
        return { requiresOpenaiAuth: false, account: { id: 'acct-1' } }
      }

      if (method === 'thread/start') {
        return { thread: { id: 'thread-recover' } }
      }

      if (method === 'model/list') {
        modelListCalls += 1
        if (modelListCalls === 1) {
          throw new Error('transient model/list failure')
        }

        return {
          data: [
            {
              id: 'gpt-recover',
              model: 'gpt-recover',
              supportedReasoningEfforts: [
                { reasoningEffort: 'minimal', description: 'minimal' },
                { reasoningEffort: 'medium', description: 'medium' },
              ],
            },
          ],
        }
      }

      if (method === 'turn/start') {
        turnStartCalls += 1
        if (turnStartCalls === 1) {
          expect(params).toMatchObject({
            model: 'gpt-recover',
            effort: 'xhigh',
          })
          return { turn: { id: 'turn-recover-1' } }
        }

        expect(params).toMatchObject({
          model: 'gpt-recover',
          effort: 'medium',
        })
        return { turn: { id: 'turn-recover-2' } }
      }

      throw new Error(`Unexpected method: ${method}`)
    })

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async () => {},
      },
      systemPrompt: 'You are a test codex runtime.',
      tools: [],
    })

    await runtime.sendMessage('first turn falls back to mapped effort')
    const client = rpcMockState.instances[0]
    await client.emitNotification({
      method: 'turn/completed',
      params: {},
    })

    await runtime.sendMessage('second turn should clamp from refreshed capabilities')
    expect(modelListCalls).toBe(2)
    await runtime.terminate({ abort: false })
  })
})
