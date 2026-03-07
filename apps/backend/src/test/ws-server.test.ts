import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'
import type { SwarmAgentRuntime } from '../swarm/runtime-types.js'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { SwarmWebSocketServer } from '../ws/server.js'
import type { ServerEvent } from '@nexus/protocol'

class FakeRuntime {
  readonly descriptor: AgentDescriptor
  private readonly sessionManager: SessionManager
  compactCalls: Array<string | undefined> = []
  terminateCalls = 0
  stopInFlightCalls: Array<{ abort?: boolean } | undefined> = []
  claudeOutputStyleMetadata: { selectedStyle: string | null; availableStyles: string[] } = {
    selectedStyle: null,
    availableStyles: [],
  }
  claudeOutputStyleMetadataError: Error | null = null
  claudeOutputStyleMetadataCalls = 0

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor
    this.sessionManager = SessionManager.open(descriptor.sessionFile)
  }

  getStatus(): AgentDescriptor['status'] {
    return this.descriptor.status
  }

  getPendingCount(): number {
    return 0
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined
  }

  async sendMessage(_message: string, _delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
    } as any)

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: 'fake-delivery',
      acceptedMode: 'prompt',
    }
  }

  async terminate(): Promise<void> {
    this.terminateCalls += 1
  }

  async stopInFlight(options?: { abort?: boolean }): Promise<void> {
    this.stopInFlightCalls.push(options)
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

  async getClaudeOutputStyleMetadata(): Promise<{ selectedStyle: string | null; availableStyles: string[] }> {
    this.claudeOutputStyleMetadataCalls += 1
    if (this.claudeOutputStyleMetadataError) {
      throw this.claudeOutputStyleMetadataError
    }
    return this.claudeOutputStyleMetadata
  }
}

class TestSwarmManager extends SwarmManager {
  pickedDirectoryPath: string | null = null
  lastPickedDirectoryDefaultPath: string | undefined
  readonly runtimeByAgentId = new Map<string, FakeRuntime>()

  protected override async createRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(descriptor)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    return runtime as unknown as SwarmAgentRuntime
  }

  override async pickDirectory(defaultPath?: string): Promise<string | null> {
    this.lastPickedDirectoryDefaultPath = defaultPath
    return this.pickedDirectoryPath
  }
}

async function getAvailablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Unable to allocate port')
  }

  const port = address.port
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })

  return port
}

async function makeTempConfig(port: number, allowNonManagerSubscriptions = false): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), 'swarm-ws-test-'))
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
    allowNonManagerSubscriptions,
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

  return manager.createManager(managerId, {
    name: managerName,
    cwd: config.defaultCwd,
  })
}

async function waitForEvent(
  events: ServerEvent[],
  predicate: (event: ServerEvent) => boolean,
  timeoutMs = 2000,
): Promise<ServerEvent> {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate)
    if (found) return found

    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for websocket event')
}

describe('SwarmWebSocketServer', () => {
  it('connect + subscribe + user_message yields manager feed events', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))

    await waitForEvent(events, (event) => event.type === 'ready')
    await waitForEvent(events, (event) => event.type === 'agents_snapshot')
    await waitForEvent(events, (event) => event.type === 'conversation_history')

    client.send(JSON.stringify({ type: 'user_message', text: 'hello manager' }))

    const userEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'hello manager',
    )

    expect(userEvent.type).toBe('conversation_message')
    if (userEvent.type === 'conversation_message') {
      expect(userEvent.sourceContext).toEqual({ channel: 'web' })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('accepts POST /api/reboot and signals the daemon pid asynchronously', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const daemonPid = 54321
    const repoHash = createHash('sha1').update(config.paths.rootDir).digest('hex').slice(0, 10)
    const pidFile = join(tmpdir(), `swarm-prod-daemon-${repoHash}.pid`)
    await writeFile(pidFile, `${daemonPid}\n`, 'utf8')

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'POST',
      })

      expect(response.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect(killSpy).toHaveBeenCalledWith(daemonPid, 0)
      expect(killSpy).toHaveBeenCalledWith(daemonPid, 'SIGUSR1')
    } finally {
      killSpy.mockRestore()
      await rm(pidFile, { force: true })
      await server.stop()
    }
  })

  it('compacts manager context through POST /api/agents/:agentId/compact', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/agents/manager/compact`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          customInstructions: 'Preserve unresolved TODOs in the summary.',
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        ok: boolean
        agentId: string
        result: { status: string; customInstructions: string | null }
      }

      expect(payload.ok).toBe(true)
      expect(payload.agentId).toBe('manager')
      expect(payload.result).toEqual({
        status: 'ok',
        customInstructions: 'Preserve unresolved TODOs in the summary.',
      })

      const runtime = manager.runtimeByAgentId.get('manager')
      expect(runtime?.compactCalls).toEqual(['Preserve unresolved TODOs in the summary.'])

      const history = manager.getConversationHistory('manager')
      expect(
        history.some(
          (event) =>
            event.type === 'conversation_message' &&
            event.source === 'system' &&
            event.text === 'Compacting manager context...',
        ),
      ).toBe(true)
      expect(
        history.some(
          (event) =>
            event.type === 'conversation_message' &&
            event.source === 'system' &&
            event.text === 'Compaction complete.',
        ),
      ).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('reads allowed files through POST /api/read-file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const artifactPath = join(config.paths.rootDir, 'artifact.md')
    const artifactContent = '# Artifact\n\nHello from Swarm.\n'
    await writeFile(artifactPath, artifactContent, 'utf8')

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/read-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: artifactPath,
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as { path: string; content: string }

      expect(payload.path).toBe(artifactPath)
      expect(payload.content).toBe(artifactContent)
    } finally {
      await server.stop()
    }
  })

  it('rejects disallowed files through POST /api/read-file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const outsideFile =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts'

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/read-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: outsideFile,
        }),
      })

      expect(response.status).toBe(403)

      const payload = (await response.json()) as { error: string }
      expect(payload.error).toContain('outside allowed roots')
    } finally {
      await server.stop()
    }
  })

  it('returns schedules through GET /api/managers/:managerId/schedules', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()
    await mkdir(dirname(config.paths.schedulesFile!), { recursive: true })

    await writeFile(
      config.paths.schedulesFile!,
      JSON.stringify(
        {
          schedules: [
            {
              id: 'daily-standup',
              name: 'Daily standup',
              cron: '0 9 * * *',
              message: 'Post standup summary to the team.',
              oneShot: false,
              timezone: 'America/Los_Angeles',
              createdAt: '2026-02-20T08:00:00.000Z',
              nextFireAt: '2026-02-21T17:00:00.000Z',
            },
            {
              id: '',
              name: 'invalid',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/managers/manager/schedules`)
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        schedules: Array<{
          id: string
          name: string
          cron: string
          message: string
          oneShot: boolean
          timezone: string
          createdAt: string
          nextFireAt: string
        }>
      }

      expect(payload.schedules).toEqual([
        {
          id: 'daily-standup',
          name: 'Daily standup',
          cron: '0 9 * * *',
          message: 'Post standup summary to the team.',
          oneShot: false,
          timezone: 'America/Los_Angeles',
          createdAt: '2026-02-20T08:00:00.000Z',
          nextFireAt: '2026-02-21T17:00:00.000Z',
        },
      ])
    } finally {
      await server.stop()
    }
  })

  it('returns manager-scoped schedules through GET /api/managers/:managerId/schedules', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const secondaryManager = await manager.createManager('manager', {
      name: 'release-manager',
      cwd: config.paths.rootDir,
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()
    const secondaryManagerScheduleFile = getScheduleFilePath(config.paths.dataDir, secondaryManager.agentId)
    await mkdir(dirname(secondaryManagerScheduleFile), { recursive: true })

    await writeFile(
      secondaryManagerScheduleFile,
      JSON.stringify(
        {
          schedules: [
            {
              id: 'weekly-check',
              name: 'Weekly release check',
              cron: '0 10 * * 1',
              message: 'Review release readiness.',
              oneShot: false,
              timezone: 'America/Los_Angeles',
              createdAt: '2026-02-20T08:00:00.000Z',
              nextFireAt: '2026-02-23T18:00:00.000Z',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(secondaryManager.agentId)}/schedules`,
      )
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        schedules: Array<{
          id: string
          name: string
          cron: string
          message: string
          oneShot: boolean
          timezone: string
          createdAt: string
          nextFireAt: string
        }>
      }

      expect(payload.schedules).toEqual([
        {
          id: 'weekly-check',
          name: 'Weekly release check',
          cron: '0 10 * * 1',
          message: 'Review release readiness.',
          oneShot: false,
          timezone: 'America/Los_Angeles',
          createdAt: '2026-02-20T08:00:00.000Z',
          nextFireAt: '2026-02-23T18:00:00.000Z',
        },
      ])
    } finally {
      await server.stop()
    }
  })

  it('returns 404 for unknown manager schedule routes', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/unknown-manager/schedules`,
      )
      expect(response.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('returns an empty schedule list when the manager schedule file is missing', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/managers/manager/schedules`)
      expect(response.status).toBe(200)

      const payload = (await response.json()) as { schedules: unknown[] }
      expect(payload.schedules).toEqual([])
    } finally {
      await server.stop()
    }
  })

  it('does not expose removed /api/settings/env endpoint', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/settings/env`)
      expect(response.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('manages auth settings through REST endpoints', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const initialResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`)
      expect(initialResponse.status).toBe(200)
      const initialPayload = (await initialResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean }>
      }

      expect(initialPayload.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: 'anthropic', configured: false }),
          expect.objectContaining({ provider: 'openai-codex', configured: false }),
          expect.objectContaining({ provider: 'claude-agent-sdk', configured: false }),
        ]),
      )

      const updateResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          anthropic: 'sk-ant-test-1234',
          'openai-codex': 'sk-openai-test-5678',
        }),
      })

      expect(updateResponse.status).toBe(200)
      const updatedPayload = (await updateResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean; maskedValue?: string }>
      }

      const anthropic = updatedPayload.providers.find((entry) => entry.provider === 'anthropic')
      const openai = updatedPayload.providers.find((entry) => entry.provider === 'openai-codex')
      const claudeAgentSdk = updatedPayload.providers.find((entry) => entry.provider === 'claude-agent-sdk')

      expect(anthropic?.configured).toBe(true)
      expect(anthropic?.maskedValue).toBe('********1234')
      expect(openai?.configured).toBe(true)
      expect(openai?.maskedValue).toBe('********5678')
      expect(claudeAgentSdk?.configured).toBe(false)

      const storedAuth = JSON.parse(await readFile(config.paths.authFile, 'utf8')) as Record<
        string,
        { type: string; key?: string; access?: string }
      >

      expect(storedAuth.anthropic).toMatchObject({
        type: 'api_key',
      })
      expect(storedAuth.anthropic.key ?? storedAuth.anthropic.access).toBe('sk-ant-test-1234')
      expect(storedAuth['openai-codex']).toMatchObject({
        type: 'api_key',
      })
      expect(storedAuth['openai-codex'].key ?? storedAuth['openai-codex'].access).toBe('sk-openai-test-5678')
      expect(storedAuth['claude-agent-sdk']).toBeUndefined()

      const deleteResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth/openai-codex`, {
        method: 'DELETE',
      })
      expect(deleteResponse.status).toBe(200)

      const afterDeletePayload = (await deleteResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean }>
      }
      expect(afterDeletePayload.providers.find((entry) => entry.provider === 'openai-codex')?.configured).toBe(false)

      const afterDeleteAuth = JSON.parse(await readFile(config.paths.authFile, 'utf8')) as Record<string, unknown>
      expect(afterDeleteAuth['openai-codex']).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('rejects API-key writes for claude-agent-sdk auth provider', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const updateResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          'claude-agent-sdk': 'sk-claude-agent-test-9012',
        }),
      })

      expect(updateResponse.status).toBe(400)
      const updatePayload = (await updateResponse.json()) as { error?: string }
      expect(updatePayload.error).toContain('claude-agent-sdk auth must be configured via OAuth login flow.')

      const providersResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`)
      expect(providersResponse.status).toBe(200)
      const providersPayload = (await providersResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean }>
      }
      expect(providersPayload.providers.find((entry) => entry.provider === 'claude-agent-sdk')?.configured).toBe(
        false,
      )
    } finally {
      await server.stop()
    }
  })

  it('treats stale non-OAuth claude-agent-sdk credentials as unconfigured', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await writeFile(
      config.paths.authFile,
      JSON.stringify(
        {
          'claude-agent-sdk': {
            type: 'api_key',
            key: 'stale-claude-key',
            access: 'stale-claude-key',
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const providersResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`)
      expect(providersResponse.status).toBe(200)
      const payload = (await providersResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean; authType?: string; maskedValue?: string }>
      }

      const claudeProvider = payload.providers.find((entry) => entry.provider === 'claude-agent-sdk')
      expect(claudeProvider).toMatchObject({
        provider: 'claude-agent-sdk',
        configured: false,
        authType: 'api_key',
      })
      expect(claudeProvider?.maskedValue).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('reports claude-agent-sdk OAuth credentials as configured', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await writeFile(
      config.paths.authFile,
      JSON.stringify(
        {
          'claude-agent-sdk': {
            type: 'oauth',
            access: 'claude-oauth-access-token',
            refresh: 'claude-oauth-refresh-token',
            expires: String(Date.now() + 60_000),
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const providersResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`)
      expect(providersResponse.status).toBe(200)
      const payload = (await providersResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean; authType?: string; maskedValue?: string }>
      }

      const claudeProvider = payload.providers.find((entry) => entry.provider === 'claude-agent-sdk')
      expect(claudeProvider).toMatchObject({
        provider: 'claude-agent-sdk',
        configured: true,
        authType: 'oauth',
      })
      expect(typeof claudeProvider?.maskedValue).toBe('string')
    } finally {
      await server.stop()
    }
  })

  it('accepts attachment-only user messages and broadcasts attachments', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'user_message',
        text: '',
        attachments: [
          {
            mimeType: 'image/png',
            data: 'aGVsbG8=',
            fileName: 'diagram.png',
          },
        ],
      }),
    )

    const userEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_message' && event.source === 'user_input',
    )

    expect(userEvent.type).toBe('conversation_message')
    if (userEvent.type === 'conversation_message') {
      expect(userEvent.text).toBe('')
      expect(userEvent.attachments).toHaveLength(1)
      const persistedAttachment = userEvent.attachments?.[0]
      expect(persistedAttachment).toMatchObject({
        mimeType: 'image/png',
        data: 'aGVsbG8=',
        fileName: 'diagram.png',
      })
      expect(typeof persistedAttachment?.filePath).toBe('string')

      if (persistedAttachment?.filePath) {
        expect(persistedAttachment.filePath.startsWith(config.paths.uploadsDir)).toBe(true)
        const content = await readFile(persistedAttachment.filePath)
        expect(content.toString('utf8')).toBe('hello')
      }
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('accepts text and binary attachments in websocket user messages', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'user_message',
        text: '',
        attachments: [
          {
            type: 'text',
            mimeType: 'text/markdown',
            text: '# Notes',
            fileName: 'notes.md',
          },
          {
            type: 'binary',
            mimeType: 'application/pdf',
            data: 'aGVsbG8=',
            fileName: 'design.pdf',
          },
        ],
      }),
    )

    const userEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        Array.isArray(event.attachments) &&
        event.attachments.length === 2,
    )

    expect(userEvent.type).toBe('conversation_message')
    if (userEvent.type === 'conversation_message') {
      expect(userEvent.attachments).toHaveLength(2)

      const textAttachment = userEvent.attachments?.[0]
      expect(textAttachment).toMatchObject({
        type: 'text',
        mimeType: 'text/markdown',
        text: '# Notes',
        fileName: 'notes.md',
      })
      expect(typeof textAttachment?.filePath).toBe('string')

      const binaryAttachment = userEvent.attachments?.[1]
      expect(binaryAttachment).toMatchObject({
        type: 'binary',
        mimeType: 'application/pdf',
        data: 'aGVsbG8=',
        fileName: 'design.pdf',
      })
      expect(typeof binaryAttachment?.filePath).toBe('string')

      if (textAttachment?.filePath) {
        expect(textAttachment.filePath.startsWith(config.paths.uploadsDir)).toBe(true)
        const textContent = await readFile(textAttachment.filePath, 'utf8')
        expect(textContent).toBe('# Notes')
      }

      if (binaryAttachment?.filePath) {
        expect(binaryAttachment.filePath.startsWith(config.paths.uploadsDir)).toBe(true)
        const binaryContent = await readFile(binaryAttachment.filePath)
        expect(binaryContent.toString('utf8')).toBe('hello')
      }
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('replays manager conversation history on reconnect', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const clientA = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsA: ServerEvent[] = []
    clientA.on('message', (raw) => {
      eventsA.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientA, 'open')
    clientA.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(eventsA, (event) => event.type === 'conversation_history')

    clientA.send(JSON.stringify({ type: 'user_message', text: 'remember this' }))
    await waitForEvent(
      eventsA,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'remember this',
    )

    clientA.close()
    await once(clientA, 'close')

    const clientB = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsB: ServerEvent[] = []
    clientB.on('message', (raw) => {
      eventsB.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientB, 'open')
    clientB.send(JSON.stringify({ type: 'subscribe' }))

    const historyEvent = await waitForEvent(eventsB, (event) => event.type === 'conversation_history')
    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(historyEvent.messages.some((message) => message.text === 'remember this')).toBe(true)
    }

    clientB.close()
    await once(clientB, 'close')
    await server.stop()
  })

  it('handles /new via websocket by resetting manager session and clearing history', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const clientA = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsA: ServerEvent[] = []
    clientA.on('message', (raw) => {
      eventsA.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientA, 'open')
    clientA.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(eventsA, (event) => event.type === 'conversation_history')

    clientA.send(JSON.stringify({ type: 'user_message', text: 'keep this' }))
    await waitForEvent(
      eventsA,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'keep this',
    )

    clientA.send(JSON.stringify({ type: 'user_message', text: '/new' }))
    const resetEvent = await waitForEvent(eventsA, (event) => event.type === 'conversation_reset')
    expect(resetEvent.type).toBe('conversation_reset')
    if (resetEvent.type === 'conversation_reset') {
      expect(resetEvent.reason).toBe('user_new_command')
      expect(resetEvent.agentId).toBe('manager')
    }

    expect(
      eventsA.some(
        (event) => event.type === 'conversation_message' && event.source === 'user_input' && event.text === '/new',
      ),
    ).toBe(false)

    clientA.close()
    await once(clientA, 'close')

    const clientB = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsB: ServerEvent[] = []
    clientB.on('message', (raw) => {
      eventsB.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientB, 'open')
    clientB.send(JSON.stringify({ type: 'subscribe' }))
    const historyEvent = await waitForEvent(eventsB, (event) => event.type === 'conversation_history')

    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(historyEvent.messages).toHaveLength(0)
    }

    clientB.close()
    await once(clientB, 'close')
    await server.stop()
  })

  it('handles /compact via websocket by compacting manager context', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'conversation_history')

    client.send(
      JSON.stringify({
        type: 'user_message',
        text: '/compact Keep unresolved work items in the summary.',
      }),
    )

    await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'system' &&
        event.text === 'Compacting manager context...',
    )
    await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' && event.source === 'system' && event.text === 'Compaction complete.',
    )

    expect(
      events.some(
        (event) =>
          event.type === 'conversation_message' &&
          event.source === 'user_input' &&
          event.text.trim().toLowerCase().startsWith('/compact'),
      ),
    ).toBe(false)

    const runtime = manager.runtimeByAgentId.get('manager')
    expect(runtime?.compactCalls).toEqual(['Keep unresolved work items in the summary.'])

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports worker subscriptions and direct user messaging to the selected worker', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker Thread' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: worker.agentId }))

    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === worker.agentId,
    )
    await waitForEvent(
      events,
      (event) => event.type === 'conversation_history' && event.agentId === worker.agentId,
    )

    client.send(JSON.stringify({ type: 'user_message', text: 'hello worker' }))

    const workerEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.agentId === worker.agentId &&
        event.source === 'user_input' &&
        event.text === 'hello worker',
    )

    expect(workerEvent.type).toBe('conversation_message')

    const rawToolName = 'extract_document'
    const rawToolCallId = 'call-edge|item with spaces/and-symbols'

    ;(manager as any).conversationProjector.emitConversationLog({
      type: 'conversation_log',
      agentId: worker.agentId,
      timestamp: new Date().toISOString(),
      source: 'runtime_log',
      kind: 'tool_execution_start',
      toolName: rawToolName,
      toolCallId: rawToolCallId,
      text: '{"command":"ls"}',
    })

    const logEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_log' &&
        event.agentId === worker.agentId &&
        event.kind === 'tool_execution_start' &&
        event.toolName === rawToolName,
    )

    expect(logEvent.type).toBe('conversation_log')
    if (logEvent.type === 'conversation_log') {
      expect(logEvent.toolName).toBe(rawToolName)
      expect(logEvent.toolCallId).toBe(rawToolCallId)
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('kills a worker via kill_agent command and emits updated status + snapshot events', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Disposable Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))

    await waitForEvent(events, (event) => event.type === 'ready')
    await waitForEvent(events, (event) => event.type === 'agents_snapshot')

    client.send(JSON.stringify({ type: 'kill_agent', agentId: worker.agentId }))

    const statusEvent = await waitForEvent(
      events,
      (event) => event.type === 'agent_status' && event.agentId === worker.agentId && event.status === 'terminated',
    )
    expect(statusEvent.type).toBe('agent_status')

    const snapshotEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some((agent) => agent.agentId === worker.agentId && agent.status === 'terminated'),
    )
    expect(snapshotEvent.type).toBe('agents_snapshot')

    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('stops all agents over websocket by cancelling work and keeping agents alive', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stop-All Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(JSON.stringify({ type: 'stop_all_agents', managerId: 'manager' }))

    const resultEvent = await waitForEvent(
      events,
      (event) => event.type === 'stop_all_agents_result' && event.managerId === 'manager',
    )
    expect(resultEvent.type).toBe('stop_all_agents_result')
    if (resultEvent.type === 'stop_all_agents_result') {
      expect(resultEvent.stoppedWorkerIds).toEqual([worker.agentId])
      expect(resultEvent.managerStopped).toBe(true)
      expect(resultEvent.terminatedWorkerIds).toEqual([worker.agentId])
      expect(resultEvent.managerTerminated).toBe(true)
    }

    const snapshotEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some((agent) => agent.agentId === 'manager' && agent.status === 'idle') &&
        event.agents.some((agent) => agent.agentId === worker.agentId && agent.status === 'idle'),
    )
    expect(snapshotEvent.type).toBe('agents_snapshot')

    expect(managerRuntime?.stopInFlightCalls).toEqual([{ abort: true }])
    expect(workerRuntime?.stopInFlightCalls).toEqual([{ abort: true }])
    expect(managerRuntime?.terminateCalls).toBe(0)
    expect(workerRuntime?.terminateCalls).toBe(0)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('creates managers over websocket with model presets and broadcasts manager_created', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Review Manager',
        cwd: config.defaultCwd,
        model: 'claude-agent-sdk',
      }),
    )

    const createdEvent = await waitForEvent(events, (event) => event.type === 'manager_created')
    expect(createdEvent.type).toBe('manager_created')
    if (createdEvent.type === 'manager_created') {
      expect(createdEvent.manager.role).toBe('manager')
      expect(createdEvent.manager.managerId).toBe(createdEvent.manager.agentId)
      expect(createdEvent.manager.model).toEqual({
        provider: 'claude-agent-sdk',
        modelId: 'claude-opus-4-6',
        thinkingLevel: 'xhigh',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('creates codex-app managers over websocket', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Codex App Manager',
        cwd: config.defaultCwd,
        model: 'codex-app',
      }),
    )

    const createdEvent = await waitForEvent(events, (event) => event.type === 'manager_created')
    expect(createdEvent.type).toBe('manager_created')
    if (createdEvent.type === 'manager_created') {
      expect(createdEvent.manager.model).toEqual({
        provider: 'openai-codex-app-server',
        modelId: 'default',
        thinkingLevel: 'xhigh',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('creates managers over websocket with explicit provider/modelId payloads', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Explicit Manager',
        cwd: config.defaultCwd,
        provider: 'claude-agent-sdk',
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: 'high',
      }),
    )

    const createdEvent = await waitForEvent(events, (event) => event.type === 'manager_created')
    expect(createdEvent.type).toBe('manager_created')
    if (createdEvent.type === 'manager_created') {
      expect(createdEvent.manager.model).toEqual({
        provider: 'claude-agent-sdk',
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: 'high',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('rejects invalid create_manager model presets at websocket protocol validation time', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Invalid Manager',
        cwd: config.defaultCwd,
        model: 'gpt-4o',
      }),
    )

    const errorEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'error' &&
        event.code === 'INVALID_COMMAND' &&
        event.message.includes('create_manager.model must be one of codex-app|claude-agent-sdk'),
    )

    expect(errorEvent.type).toBe('error')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('rejects mixed and partial explicit create_manager payloads at websocket protocol validation time', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    const expectInvalidCreateManager = async (
      payload: Record<string, unknown>,
      expectedMessageFragment: string,
    ): Promise<void> => {
      // Reset buffered events so each assertion is causally tied to one command.
      events.length = 0
      client.send(
        JSON.stringify({
          type: 'create_manager',
          ...payload,
        }),
      )
      const errorEvent = await waitForEvent(
        events,
        (event) =>
          event.type === 'error' &&
          event.code === 'INVALID_COMMAND' &&
          event.message.includes(expectedMessageFragment),
      )

      expect(errorEvent.type).toBe('error')
    }

    await expectInvalidCreateManager(
      {
        name: 'Mixed Manager',
        cwd: config.defaultCwd,
        model: 'codex-app',
        provider: 'claude-agent-sdk',
        modelId: 'claude-opus-4-6',
      },
      'create_manager.model cannot be combined with create_manager.provider or create_manager.modelId',
    )

    await expectInvalidCreateManager(
      {
        name: 'Partial Explicit Manager',
        cwd: config.defaultCwd,
        provider: 'anthropic',
      },
      'create_manager.provider and create_manager.modelId are required together for explicit model creation',
    )

    await expectInvalidCreateManager(
      {
        name: 'Thinking Without Explicit Descriptor',
        cwd: config.defaultCwd,
        thinkingLevel: 'low',
      },
      'create_manager.thinkingLevel is only supported with create_manager.provider and create_manager.modelId',
    )

    await expectInvalidCreateManager(
      {
        name: 'Preset With Thinking',
        cwd: config.defaultCwd,
        model: 'codex-app',
        thinkingLevel: 'low',
      },
      'create_manager.thinkingLevel is only supported with create_manager.provider and create_manager.modelId',
    )

    await expectInvalidCreateManager(
      {
        name: 'Explicit With Invalid Thinking',
        cwd: config.defaultCwd,
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        thinkingLevel: 'ultra',
      },
      'create_manager.thinkingLevel must be one of off|minimal|low|medium|high|xhigh',
    )

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('updates managers over websocket and emits manager_updated with reset metadata', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'update_manager',
        managerId: 'manager',
        model: 'claude-agent-sdk',
        requestId: 'req-noop',
      }),
    )

    const noOpUpdated = await waitForEvent(
      events,
      (event) => event.type === 'manager_updated' && event.requestId === 'req-noop',
    )
    expect(noOpUpdated.type).toBe('manager_updated')
    if (noOpUpdated.type === 'manager_updated') {
      expect(noOpUpdated.resetApplied).toBe(false)
      expect(noOpUpdated.manager.agentId).toBe('manager')
      expect(noOpUpdated.manager.promptOverride).toBeUndefined()
    }

    client.send(
      JSON.stringify({
        type: 'update_manager',
        managerId: 'manager',
        promptOverride: 'You are the websocket override.',
        requestId: 'req-change',
      }),
    )

    const changedUpdated = await waitForEvent(
      events,
      (event) => event.type === 'manager_updated' && event.requestId === 'req-change',
    )
    expect(changedUpdated.type).toBe('manager_updated')
    if (changedUpdated.type === 'manager_updated') {
      expect(changedUpdated.resetApplied).toBe(true)
      expect(changedUpdated.manager.promptOverride).toBe('You are the websocket override.')
    }

    client.send(
      JSON.stringify({
        type: 'update_manager',
        managerId: 'manager',
        provider: 'claude-agent-sdk',
        modelId: 'claude-sonnet-4-5',
        requestId: 'req-explicit',
      }),
    )

    const explicitUpdated = await waitForEvent(
      events,
      (event) => event.type === 'manager_updated' && event.requestId === 'req-explicit',
    )
    expect(explicitUpdated.type).toBe('manager_updated')
    if (explicitUpdated.type === 'manager_updated') {
      expect(explicitUpdated.resetApplied).toBe(true)
      expect(explicitUpdated.manager.model).toEqual({
        provider: 'claude-agent-sdk',
        modelId: 'claude-sonnet-4-5',
        thinkingLevel: 'xhigh',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('rejects invalid update_manager payloads at websocket protocol validation time', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'update_manager',
        managerId: 'manager',
        model: 'invalid-model',
      }),
    )

    const invalidModelError = await waitForEvent(
      events,
      (event) =>
        event.type === 'error' &&
        event.code === 'INVALID_COMMAND' &&
        event.message.includes('update_manager.model must be one of codex-app|claude-agent-sdk'),
    )

    expect(invalidModelError.type).toBe('error')

    client.send(
      JSON.stringify({
        type: 'update_manager',
        managerId: 'manager',
        model: 'codex-app',
        provider: 'claude-agent-sdk',
        modelId: 'claude-opus-4-6',
      }),
    )

    const mixedPayloadError = await waitForEvent(
      events,
      (event) =>
        event.type === 'error' &&
        event.code === 'INVALID_COMMAND' &&
        event.message.includes(
          'update_manager.model cannot be combined with update_manager.provider or update_manager.modelId',
        ),
    )

    expect(mixedPayloadError.type).toBe('error')

    client.send(
      JSON.stringify({
        type: 'update_manager',
        managerId: 'manager',
        provider: 'anthropic',
      }),
    )

    const missingModelIdError = await waitForEvent(
      events,
      (event) =>
        event.type === 'error' &&
        event.code === 'INVALID_COMMAND' &&
        event.message.includes(
          'update_manager.provider and update_manager.modelId are required together for explicit model updates',
        ),
    )

    expect(missingModelIdError.type).toBe('error')

    client.send(
      JSON.stringify({
        type: 'update_manager',
        managerId: 'manager',
        provider: 'codex-app',
        modelId: 'default',
      }),
    )

    const unsupportedDescriptorError = await waitForEvent(
      events,
      (event) =>
        event.type === 'error' &&
        event.code === 'UPDATE_MANAGER_FAILED' &&
        event.message.includes('Unsupported model descriptor codex-app/default'),
    )

    expect(unsupportedDescriptorError.type).toBe('error')
    expect(manager.getAgent('manager')?.model).toEqual({
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('deletes managers over websocket and emits manager_deleted', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Delete Me Manager',
      cwd: config.defaultCwd,
    })
    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Delete Me Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'delete_manager', managerId: secondary.agentId }))

    const deletedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_deleted' && event.managerId === secondary.agentId,
    )
    expect(deletedEvent.type).toBe('manager_deleted')
    if (deletedEvent.type === 'manager_deleted') {
      expect(deletedEvent.terminatedWorkerIds).toContain(ownedWorker.agentId)
    }

    expect(manager.listAgents().some((agent) => agent.agentId === secondary.agentId)).toBe(false)
    expect(manager.listAgents().some((agent) => agent.agentId === ownedWorker.agentId)).toBe(false)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports deleting the selected last manager and creating a replacement manager', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(JSON.stringify({ type: 'delete_manager', managerId: 'manager' }))

    const deletedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_deleted' && event.managerId === 'manager',
    )
    expect(deletedEvent.type).toBe('manager_deleted')

    const emptySnapshot = await waitForEvent(
      events,
      (event) => event.type === 'agents_snapshot' && event.agents.length === 0,
    )
    expect(emptySnapshot.type).toBe('agents_snapshot')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Recovered Manager',
        cwd: config.defaultCwd,
      }),
    )

    const recreatedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_created' && event.manager.agentId === 'recovered-manager',
    )
    expect(recreatedEvent.type).toBe('manager_created')

    expect(manager.listAgents().some((agent) => agent.agentId === 'recovered-manager')).toBe(true)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('enforces strict ownership for kill_agent based on selected manager context', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Owner Manager',
      cwd: config.defaultCwd,
    })
    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Owned Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'kill_agent', agentId: ownedWorker.agentId }))

    const denied = await waitForEvent(
      events,
      (event) => event.type === 'error' && event.code === 'KILL_AGENT_FAILED',
    )
    expect(denied.type).toBe('error')

    client.send(JSON.stringify({ type: 'subscribe', agentId: secondary.agentId }))
    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === secondary.agentId,
    )

    client.send(JSON.stringify({ type: 'kill_agent', agentId: ownedWorker.agentId }))

    const statusEvent = await waitForEvent(
      events,
      (event) => event.type === 'agent_status' && event.agentId === ownedWorker.agentId && event.status === 'terminated',
    )
    expect(statusEvent.type).toBe('agent_status')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('/new resets the currently selected manager session only', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Resettable Manager',
      cwd: config.defaultCwd,
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: secondary.agentId }))
    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === secondary.agentId,
    )

    client.send(JSON.stringify({ type: 'user_message', text: '/new' }))

    const resetEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_reset' && event.agentId === secondary.agentId,
    )
    expect(resetEvent.type).toBe('conversation_reset')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports directory picker protocol commands', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const outsideDir = await mkdtemp(join(tmpdir(), 'ws-outside-allowlist-'))
    const rootValidation = await manager.validateDirectory(config.paths.rootDir)
    const expectedRoot = rootValidation.resolvedPath ?? config.paths.rootDir

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'list_directories', path: config.paths.rootDir }))

    const listed = await waitForEvent(events, (event) => event.type === 'directories_listed')
    expect(listed.type).toBe('directories_listed')
    if (listed.type === 'directories_listed') {
      expect(listed.roots).toEqual([])
      expect(listed.resolvedPath).toBe(expectedRoot)
    }

    client.send(JSON.stringify({ type: 'validate_directory', path: outsideDir }))

    const validated = await waitForEvent(
      events,
      (event) => event.type === 'directory_validated' && event.requestedPath === outsideDir,
    )
    expect(validated.type).toBe('directory_validated')
    if (validated.type === 'directory_validated') {
      expect(validated.valid).toBe(true)
      expect(validated.message).toBeUndefined()
      expect(validated.roots).toEqual([])
    }

    manager.pickedDirectoryPath = outsideDir
    client.send(JSON.stringify({ type: 'pick_directory', defaultPath: expectedRoot, requestId: 'pick-1' }))

    const picked = await waitForEvent(
      events,
      (event) => event.type === 'directory_picked' && event.requestId === 'pick-1',
    )
    expect(picked.type).toBe('directory_picked')
    if (picked.type === 'directory_picked') {
      expect(picked.path).toBe(outsideDir)
    }
    expect(manager.lastPickedDirectoryDefaultPath).toBe(expectedRoot)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('rejects non-manager subscription with explicit error', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'worker-1' }))

    const errorEvent = await waitForEvent(events, (event) => event.type === 'error')
    expect(errorEvent.type).toBe('error')
    if (errorEvent.type === 'error') {
      expect(errorEvent.code).toBe('SUBSCRIPTION_NOT_SUPPORTED')
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports Claude output-style GET/PUT and persists to project-local settings', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const claudeManager = await manager.createManager('manager', {
      name: 'Claude Style Manager',
      cwd: config.defaultCwd,
      model: 'claude-agent-sdk',
    })

    const runtime = manager.runtimeByAgentId.get(claudeManager.agentId)
    if (!runtime) {
      throw new Error('Expected runtime for Claude manager')
    }
    runtime.claudeOutputStyleMetadata = {
      selectedStyle: 'default',
      availableStyles: ['default', 'concise', 'technical'],
    }
    const initialRuntime = runtime

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    try {
      const getBeforeResponse = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(claudeManager.agentId)}/claude/output-style`,
      )
      expect(getBeforeResponse.status).toBe(200)
      const getBeforePayload = (await getBeforeResponse.json()) as {
        managerId: string
        selectedStyle: string | null
        availableStyles: string[]
      }
      expect(getBeforePayload.managerId).toBe(claudeManager.agentId)
      expect(getBeforePayload.selectedStyle).toBe('default')
      expect(getBeforePayload.availableStyles).toEqual(['default', 'concise', 'technical'])

      const putResponse = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(claudeManager.agentId)}/claude/output-style`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ outputStyle: 'technical' }),
        },
      )
      expect(putResponse.status).toBe(200)

      const settingsLocalPath = join(claudeManager.cwd, '.claude', 'settings.local.json')
      const settingsLocal = JSON.parse(await readFile(settingsLocalPath, 'utf8')) as { outputStyle?: string }
      expect(settingsLocal.outputStyle).toBe('technical')

      const postUpdateRuntime = manager.runtimeByAgentId.get(claudeManager.agentId)
      expect(postUpdateRuntime).toBeDefined()
      expect(postUpdateRuntime).not.toBe(initialRuntime)

      const getAfterResponse = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(claudeManager.agentId)}/claude/output-style`,
      )
      expect(getAfterResponse.status).toBe(200)
      const getAfterPayload = (await getAfterResponse.json()) as { selectedStyle: string | null }
      expect(getAfterPayload.selectedStyle).toBe('technical')
    } finally {
      await server.stop()
    }
  })

  it('returns deterministic warning when settings.local is malformed during Claude output-style GET', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const claudeManager = await manager.createManager('manager', {
      name: 'Claude Warning Manager',
      cwd: config.defaultCwd,
      model: 'claude-agent-sdk',
    })

    const runtime = manager.runtimeByAgentId.get(claudeManager.agentId)
    if (!runtime) {
      throw new Error('Expected runtime for Claude manager')
    }
    runtime.claudeOutputStyleMetadata = {
      selectedStyle: 'concise',
      availableStyles: ['concise', 'detailed'],
    }

    const settingsDir = join(claudeManager.cwd, '.claude')
    await mkdir(settingsDir, { recursive: true })
    await writeFile(join(settingsDir, 'settings.local.json'), '{"outputStyle":', 'utf8')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(claudeManager.agentId)}/claude/output-style`,
      )
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        selectedStyle: string | null
        availableStyles: string[]
        warning?: string
      }
      expect(payload.selectedStyle).toBe('concise')
      expect(payload.availableStyles).toEqual(['concise', 'detailed'])
      expect(payload.warning).toContain('Failed to parse')
    } finally {
      await server.stop()
    }
  })

  it('returns warning fallback when Claude runtime metadata is unavailable during output-style GET', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const claudeManager = await manager.createManager('manager', {
      name: 'Claude Runtime Warning Manager',
      cwd: config.defaultCwd,
      model: 'claude-agent-sdk',
    })

    const runtime = manager.runtimeByAgentId.get(claudeManager.agentId)
    if (!runtime) {
      throw new Error('Expected runtime for Claude manager')
    }
    runtime.claudeOutputStyleMetadataError = new Error('runtime metadata unavailable')

    const settingsDir = join(claudeManager.cwd, '.claude')
    await mkdir(settingsDir, { recursive: true })
    await writeFile(join(settingsDir, 'settings.local.json'), JSON.stringify({ outputStyle: 'technical' }), 'utf8')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(claudeManager.agentId)}/claude/output-style`,
      )
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        selectedStyle: string | null
        availableStyles: string[]
        warning?: string
      }
      expect(payload.selectedStyle).toBe('technical')
      expect(payload.availableStyles).toEqual([])
      expect(payload.warning).toContain('Unable to load runtime output styles')
    } finally {
      await server.stop()
    }
  })

  it('lazily recreates an idle Claude manager runtime when output-style metadata is requested', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const claudeManager = await manager.createManager('manager', {
      name: 'Claude Lazy Runtime Manager',
      cwd: config.defaultCwd,
      model: 'claude-agent-sdk',
    })

    const initialRuntime = manager.runtimeByAgentId.get(claudeManager.agentId)
    if (!initialRuntime) {
      throw new Error('Expected runtime for Claude manager')
    }

    const runtimes = (manager as unknown as { runtimes: Map<string, SwarmAgentRuntime> }).runtimes
    runtimes.delete(claudeManager.agentId)

    const settingsDir = join(claudeManager.cwd, '.claude')
    await mkdir(settingsDir, { recursive: true })
    await writeFile(join(settingsDir, 'settings.local.json'), JSON.stringify({ outputStyle: 'technical' }), 'utf8')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(claudeManager.agentId)}/claude/output-style`,
      )
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        selectedStyle: string | null
        availableStyles: string[]
        warning?: string
      }

      expect(payload.selectedStyle).toBe('technical')
      expect(payload.warning).toBeUndefined()

      const recreatedRuntime = manager.runtimeByAgentId.get(claudeManager.agentId)
      expect(recreatedRuntime).toBeDefined()
      expect(recreatedRuntime).not.toBe(initialRuntime)
      expect(recreatedRuntime?.claudeOutputStyleMetadataCalls).toBe(1)
    } finally {
      await server.stop()
    }
  })

  it('returns immediate fallback warning during output-style GET when manager is streaming', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const claudeManager = await manager.createManager('manager', {
      name: 'Claude Busy Manager',
      cwd: config.defaultCwd,
      model: 'claude-agent-sdk',
    })

    const runtime = manager.runtimeByAgentId.get(claudeManager.agentId)
    if (!runtime) {
      throw new Error('Expected runtime for Claude manager')
    }
    runtime.claudeOutputStyleMetadata = {
      selectedStyle: 'concise',
      availableStyles: ['concise', 'detailed'],
    }

    const descriptors = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors
    const descriptor = descriptors.get(claudeManager.agentId)
    if (!descriptor) {
      throw new Error('Expected descriptor for Claude manager')
    }
    descriptor.status = 'streaming'

    const settingsDir = join(claudeManager.cwd, '.claude')
    await mkdir(settingsDir, { recursive: true })
    await writeFile(join(settingsDir, 'settings.local.json'), JSON.stringify({ outputStyle: 'technical' }), 'utf8')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(claudeManager.agentId)}/claude/output-style`,
      )
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        selectedStyle: string | null
        availableStyles: string[]
        warning?: string
      }
      expect(payload.selectedStyle).toBe('technical')
      expect(payload.availableStyles).toEqual([])
      expect(payload.warning).toContain('manager is busy processing a turn')
      expect(runtime.claudeOutputStyleMetadataCalls).toBe(0)
    } finally {
      await server.stop()
    }
  })

  it('fails Claude output-style PUT when settings.local is malformed and does not reset manager', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const claudeManager = await manager.createManager('manager', {
      name: 'Claude Strict Manager',
      cwd: config.defaultCwd,
      model: 'claude-agent-sdk',
    })

    const initialRuntime = manager.runtimeByAgentId.get(claudeManager.agentId)
    if (!initialRuntime) {
      throw new Error('Expected runtime for Claude manager')
    }

    const settingsDir = join(claudeManager.cwd, '.claude')
    const settingsLocalPath = join(settingsDir, 'settings.local.json')
    await mkdir(settingsDir, { recursive: true })
    await writeFile(settingsLocalPath, '{"outputStyle":', 'utf8')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(claudeManager.agentId)}/claude/output-style`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ outputStyle: 'technical' }),
        },
      )
      expect(response.status).toBe(500)
      const payload = (await response.json()) as { error?: string }
      expect(payload.error).toContain('Failed to parse')

      const rawFile = await readFile(settingsLocalPath, 'utf8')
      expect(rawFile).toBe('{"outputStyle":')

      const currentRuntime = manager.runtimeByAgentId.get(claudeManager.agentId)
      expect(currentRuntime).toBe(initialRuntime)
    } finally {
      await server.stop()
    }
  })
})
