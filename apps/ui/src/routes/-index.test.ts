/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByLabelText, getByRole, queryByRole, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagerModelCatalogResponse } from '@nexus/protocol'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IndexPage } from './index'

let mockSearch: Record<string, string> = {}

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => opts,
  useLocation: () => ({ pathname: '/', search: mockSearch, searchStr: '' }),
  useNavigate: () => (opts: any) => {
    if (opts?.search) {
      mockSearch = { ...opts.search }
    }
  },
}))

type ListenerMap = Record<string, Array<(event?: any) => void>>

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sentPayloads: string[] = []
  readonly listeners: ListenerMap = {}

  readyState = FakeWebSocket.OPEN

  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners[type] ??= []
    this.listeners[type].push(listener)
  }

  send(payload: string): void {
    this.sentPayloads.push(payload)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close')
  }

  emit(type: string, event?: any): void {
    const handlers = this.listeners[type] ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }
}

function emitServerEvent(socket: FakeWebSocket, event: unknown): void {
  socket.emit('message', {
    data: JSON.stringify(event),
  })
}

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

/** Scope to the first (desktop) aside to avoid dual-render duplicates. */
function sidebar(): HTMLElement {
  const el = container.querySelector('aside')
  if (!el) throw new Error('Sidebar <aside> not found')
  return el
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  flushSync(() => {
    fireEvent.change(element, {
      target: { value },
    })
  })
}

function buildManager(agentId: string, cwd: string) {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager' as const,
    status: 'idle' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function buildWorker(agentId: string, managerId: string, cwd: string) {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker' as const,
    status: 'idle' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

let container: HTMLDivElement
let root: Root | null = null

const originalWebSocket = globalThis.WebSocket
const originalFetch = globalThis.fetch
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
let fetchMock: ReturnType<typeof vi.fn>
let mockCatalogStatus = 200
let mockCatalogError = 'Catalog unavailable.'
let mockCatalogResponse: ManagerModelCatalogResponse = createDefaultCatalogResponse()

beforeEach(() => {
  FakeWebSocket.instances = []
  mockSearch = {}
  mockCatalogStatus = 200
  mockCatalogError = 'Catalog unavailable.'
  mockCatalogResponse = createDefaultCatalogResponse()
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

    if (url.endsWith('/api/models/manager-catalog')) {
      if (mockCatalogStatus !== 200) {
        return new Response(
          JSON.stringify({ error: mockCatalogError }),
          {
            status: mockCatalogStatus,
            headers: {
              'content-type': 'application/json',
            },
          },
        )
      }

      return new Response(
        JSON.stringify(mockCatalogResponse),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      )
    }

    throw new Error(`Unexpected fetch request: ${url}`)
  })

  vi.useFakeTimers()
  ;(globalThis as any).WebSocket = FakeWebSocket
  ;(globalThis as any).fetch = fetchMock
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })

  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()

  vi.useRealTimers()
  ;(globalThis as any).WebSocket = originalWebSocket
  ;(globalThis as any).fetch = originalFetch
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: originalScrollIntoView,
  })
})

async function renderPage(): Promise<FakeWebSocket> {
  root = createRoot(container)

  flushSync(() => {
    root?.render(createElement(TooltipProvider, null, createElement(IndexPage)))
  })

  await Promise.resolve()
  vi.advanceTimersByTime(60)

  const socket = FakeWebSocket.instances[0]
  expect(socket).toBeDefined()

  socket.emit('open')
  expect(JSON.parse(socket.sentPayloads.at(0) ?? '{}')).toEqual({ type: 'subscribe' })
  emitServerEvent(socket, {
    type: 'ready',
    serverTime: new Date().toISOString(),
    subscribedAgentId: 'manager',
  })

  return socket
}

describe('IndexPage create manager model selection', () => {
  it('shows dynamic Provider -> Model -> Thinking selectors and applies dependency resets', async () => {
    await renderPage()

    click(getByRole(sidebar(), 'button', { name: 'Add manager' }))
    expect(queryByText(document.body, 'Loading model catalog...')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(0)

    // The catalog is fetched once by useModelCatalog (composer) on mount, and
    // once by useManagerActions when the create-manager dialog opens.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => {
      expect(getByRole(document.body, 'combobox', { name: 'Provider' }).textContent).toContain('OpenAI Codex')
    })

    const providerSelect = getByRole(document.body, 'combobox', { name: 'Provider' })
    const modelSelect = getByRole(document.body, 'combobox', { name: 'Model' })

    expect(providerSelect.textContent).toContain('OpenAI Codex')
    expect(modelSelect.textContent).toContain('gpt-5.3-codex')

    click(providerSelect as HTMLElement)

    const optionValues = getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')
    expect(optionValues).toEqual(['OpenAI Codex', 'Anthropic', 'Claude Agent SDK'])

    click(getByRole(document.body, 'option', { name: 'Anthropic' }))
    expect(getByRole(document.body, 'combobox', { name: 'Model' }).textContent).toContain('claude-opus-4-6')
    expect(getByRole(document.body, 'combobox', { name: 'Thinking' }).textContent).toContain('high')

    click(modelSelect as HTMLElement)
    click(getByRole(document.body, 'option', { name: 'claude-sonnet-4-5' }))

    const updatedThinkingSelect = getByRole(document.body, 'combobox', { name: 'Thinking' })
    click(updatedThinkingSelect as HTMLElement)
    const thinkingOptionValues = getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')
    expect(thinkingOptionValues).toEqual(['off', 'low'])
  })

  it('sends selected explicit descriptor fields in create_manager payload', async () => {
    const socket = await renderPage()

    click(getByRole(sidebar(), 'button', { name: 'Add manager' }))
    await vi.advanceTimersByTimeAsync(0)

    changeValue(getByLabelText(document.body, 'Name') as HTMLInputElement, 'release-manager')
    changeValue(getByLabelText(document.body, 'Working directory') as HTMLInputElement, '/tmp/release')

    const providerSelect = getByRole(document.body, 'combobox', { name: 'Provider' })
    click(providerSelect as HTMLElement)
    click(getByRole(document.body, 'option', { name: 'Anthropic' }))

    const modelSelect = getByRole(document.body, 'combobox', { name: 'Model' })
    click(modelSelect as HTMLElement)
    click(getByRole(document.body, 'option', { name: 'claude-sonnet-4-5' }))

    const thinkingSelect = getByRole(document.body, 'combobox', { name: 'Thinking' })
    click(thinkingSelect as HTMLElement)
    click(getByRole(document.body, 'option', { name: 'off' }))

    click(getByRole(document.body, 'button', { name: 'Create manager' }))

    const validatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(validatePayload.type).toBe('validate_directory')
    expect(validatePayload.path).toBe('/tmp/release')

    emitServerEvent(socket, {
      type: 'directory_validated',
      requestId: validatePayload.requestId,
      path: '/tmp/release',
      valid: true,
    })

    await vi.advanceTimersByTimeAsync(0)

    const parsedPayloads = socket.sentPayloads.map((payload) => JSON.parse(payload))
    const createPayload = parsedPayloads.find((payload) => payload.type === 'create_manager')

    expect(createPayload).toMatchObject({
      type: 'create_manager',
      name: 'release-manager',
      cwd: '/tmp/release',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'off',
    })
    expect(createPayload).not.toHaveProperty('model')
    expect(typeof createPayload?.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'manager_created',
      requestId: createPayload?.requestId,
      manager: buildManager('release-manager', '/tmp/release'),
    })

    await vi.advanceTimersByTimeAsync(0)
  })

  it('blocks submit when catalog is empty and no valid descriptor can be selected', async () => {
    mockCatalogResponse = {
      fetchedAt: new Date().toISOString(),
      providers: [
        {
          provider: 'openai-codex-app-server',
          providerLabel: 'OpenAI Codex App Server',
          surfaces: ['manager_settings'],
          models: [
            {
              modelId: 'default',
              modelLabel: 'default',
              allowedThinkingLevels: ['off', 'high'],
              defaultThinkingLevel: 'high',
            },
          ],
        },
      ],
    }

    const socket = await renderPage()

    click(getByRole(sidebar(), 'button', { name: 'Add manager' }))
    await vi.advanceTimersByTimeAsync(0)

    expect(queryByText(document.body, 'No manager model options are available right now.')).not.toBeNull()

    changeValue(getByLabelText(document.body, 'Name') as HTMLInputElement, 'release-manager')
    changeValue(getByLabelText(document.body, 'Working directory') as HTMLInputElement, '/tmp/release')
    click(getByRole(document.body, 'button', { name: 'Create manager' }))

    const parsedPayloads = socket.sentPayloads.map((payload) => JSON.parse(payload))
    expect(parsedPayloads.some((payload) => payload.type === 'validate_directory')).toBe(false)
    expect(parsedPayloads.some((payload) => payload.type === 'create_manager')).toBe(false)
  })

  it('handles catalog API failures without crashing and blocks create submit', async () => {
    mockCatalogStatus = 500
    mockCatalogError = 'Catalog request failed.'

    const socket = await renderPage()

    click(getByRole(sidebar(), 'button', { name: 'Add manager' }))
    await vi.advanceTimersByTimeAsync(0)

    expect(queryByText(document.body, 'Catalog request failed.')).not.toBeNull()

    changeValue(getByLabelText(document.body, 'Name') as HTMLInputElement, 'release-manager')
    changeValue(getByLabelText(document.body, 'Working directory') as HTMLInputElement, '/tmp/release')
    click(getByRole(document.body, 'button', { name: 'Create manager' }))

    const parsedPayloads = socket.sentPayloads.map((payload) => JSON.parse(payload))
    expect(parsedPayloads.some((payload) => payload.type === 'validate_directory')).toBe(false)
    expect(parsedPayloads.some((payload) => payload.type === 'create_manager')).toBe(false)
  })

  it('hides worker tool calls in all-tab activity for the selected manager context', async () => {
    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        buildManager('manager', '/tmp/manager'),
        buildWorker('worker-owned', 'manager', '/tmp/manager'),
        buildManager('other-manager', '/tmp/other-manager'),
        buildWorker('worker-foreign', 'other-manager', '/tmp/other-manager'),
      ],
    })

    emitServerEvent(socket, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [
        {
          type: 'conversation_message',
          agentId: 'manager',
          role: 'assistant',
          text: 'manager reply',
          timestamp: new Date().toISOString(),
          source: 'speak_to_user',
        },
        {
          type: 'agent_message',
          agentId: 'manager',
          timestamp: new Date().toISOString(),
          source: 'agent_to_agent',
          fromAgentId: 'worker-owned',
          toAgentId: 'worker-owned',
          text: 'owned worker chatter',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'manager',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'spawn_agent',
          toolCallId: 'manager-call',
          text: '{"agentId":"worker-1","task":"analyze"}',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-owned',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'owned-call',
          text: '{"path":"README.md"}',
        },
        {
          type: 'agent_message',
          agentId: 'manager',
          timestamp: new Date().toISOString(),
          source: 'agent_to_agent',
          fromAgentId: 'worker-foreign',
          toAgentId: 'worker-foreign',
          text: 'foreign worker chatter',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-foreign',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'foreign-call',
          text: '{"path":"SECRET.md"}',
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(0)

    click(getByRole(container, 'button', { name: 'All' }))

    expect(queryByText(container, 'owned worker chatter')).not.toBeNull()
    expect(queryByText(container, /spawn_agent/)).not.toBeNull()
    expect(queryByText(container, /README\.md/)).toBeNull()
    expect(queryByText(container, 'foreign worker chatter')).toBeNull()
    expect(queryByText(container, /SECRET\.md/)).toBeNull()
  })

  it('shows workers in sidebar and sends messages to the selected worker thread', async () => {
    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        buildManager('manager', '/tmp/manager'),
        buildWorker('release-worker', 'manager', '/tmp/manager'),
      ],
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(queryByText(sidebar(), 'release-worker')).not.toBeNull()

    const workerRow = queryByText(sidebar(), 'release-worker')
    expect(workerRow).not.toBeNull()
    click(workerRow!.closest('button') as HTMLButtonElement)

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '{}')).toEqual({
      type: 'subscribe',
      agentId: 'release-worker',
    })

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'release-worker',
    })

    emitServerEvent(socket, {
      type: 'conversation_history',
      agentId: 'release-worker',
      messages: [
        {
          type: 'conversation_message',
          agentId: 'release-worker',
          role: 'assistant',
          text: 'worker thread online',
          timestamp: new Date().toISOString(),
          source: 'system',
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(queryByText(container, 'worker thread online')).not.toBeNull()

    const input = getByRole(container, 'textbox') as HTMLTextAreaElement
    changeValue(input, 'ship it')
    click(getByRole(container, 'button', { name: 'Send message' }))

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '{}')).toEqual({
      type: 'user_message',
      text: 'ship it',
      agentId: 'release-worker',
      delivery: 'auto',
    })
  })

  it('swaps send for stop and interrupts the active manager', async () => {
    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        buildManager('manager', '/tmp/manager'),
      ],
    })

    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'manager',
      status: 'streaming',
      pendingCount: 1,
    })

    await vi.advanceTimersByTimeAsync(0)

    click(getByRole(container, 'button', { name: 'Stop agent' }))

    const interruptPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(interruptPayload).toMatchObject({
      type: 'interrupt_agent',
      agentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'interrupt_agent_result',
      requestId: interruptPayload.requestId,
      agentId: 'manager',
      managerId: 'manager',
      interrupted: true,
    })
    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'manager',
      status: 'idle',
      pendingCount: 0,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(queryByRole(container, 'button', { name: 'Stop agent' })).toBeNull()
    expect(getByRole(container, 'button', { name: 'Send message' })).not.toBeNull()
  })

  it('still allows follow-up sends via keyboard while the stop button is shown', async () => {
    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        buildManager('manager', '/tmp/manager'),
      ],
    })

    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'manager',
      status: 'streaming',
      pendingCount: 1,
    })

    await vi.advanceTimersByTimeAsync(0)

    const input = getByRole(container, 'textbox') as HTMLTextAreaElement
    changeValue(input, 'follow up while streaming')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '{}')).toEqual({
      type: 'user_message',
      text: 'follow up while streaming',
      agentId: 'manager',
      delivery: 'steer',
    })
    expect(getByRole(container, 'button', { name: 'Stop agent' })).not.toBeNull()
  })

  it('swaps send for stop and interrupts the selected worker', async () => {
    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        buildManager('manager', '/tmp/manager'),
        buildWorker('release-worker', 'manager', '/tmp/manager'),
      ],
    })

    await vi.advanceTimersByTimeAsync(0)

    const workerRow = queryByText(sidebar(), 'release-worker')
    expect(workerRow).not.toBeNull()
    click(workerRow!.closest('button') as HTMLButtonElement)

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'release-worker',
    })
    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'release-worker',
      status: 'streaming',
      pendingCount: 1,
    })

    await vi.advanceTimersByTimeAsync(0)

    click(getByRole(container, 'button', { name: 'Stop agent' }))

    const interruptPayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(interruptPayload).toMatchObject({
      type: 'interrupt_agent',
      agentId: 'release-worker',
    })
  })

  it('tracks interrupt-in-flight state per agent so another busy thread can still be stopped', async () => {
    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        buildManager('manager', '/tmp/manager'),
        buildWorker('release-worker', 'manager', '/tmp/manager'),
      ],
    })

    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'manager',
      status: 'streaming',
      pendingCount: 1,
    })

    await vi.advanceTimersByTimeAsync(0)

    click(getByRole(container, 'button', { name: 'Stop agent' }))
    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '{}')).toMatchObject({
      type: 'interrupt_agent',
      agentId: 'manager',
    })

    const workerRow = queryByText(sidebar(), 'release-worker')
    expect(workerRow).not.toBeNull()
    click(workerRow!.closest('button') as HTMLButtonElement)

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'release-worker',
    })
    emitServerEvent(socket, {
      type: 'agent_status',
      agentId: 'release-worker',
      status: 'streaming',
      pendingCount: 1,
    })

    await vi.advanceTimersByTimeAsync(0)

    const workerStopButton = getByRole(container, 'button', { name: 'Stop agent' }) as HTMLButtonElement
    expect(workerStopButton.disabled).toBe(false)
    click(workerStopButton)

    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '{}')).toMatchObject({
      type: 'interrupt_agent',
      agentId: 'release-worker',
    })
  })
})

function createDefaultCatalogResponse(): ManagerModelCatalogResponse {
  return {
    fetchedAt: '2026-01-01T00:00:00.000Z',
    providers: [
      {
        provider: 'openai-codex',
        providerLabel: 'OpenAI Codex',
        surfaces: ['create_manager', 'manager_settings'],
        models: [
          {
            modelId: 'gpt-5.3-codex',
            modelLabel: 'gpt-5.3-codex',
            allowedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
            defaultThinkingLevel: 'xhigh',
          },
          {
            modelId: 'gpt-5.3-mini',
            modelLabel: 'gpt-5.3-mini',
            allowedThinkingLevels: ['off', 'low', 'medium'],
            defaultThinkingLevel: 'medium',
          },
        ],
      },
      {
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        surfaces: ['create_manager', 'manager_settings'],
        models: [
          {
            modelId: 'claude-opus-4-6',
            modelLabel: 'claude-opus-4-6',
            allowedThinkingLevels: ['off', 'high'],
            defaultThinkingLevel: 'high',
          },
          {
            modelId: 'claude-sonnet-4-5',
            modelLabel: 'claude-sonnet-4-5',
            allowedThinkingLevels: ['off', 'low'],
            defaultThinkingLevel: 'low',
          },
        ],
      },
      {
        provider: 'claude-agent-sdk',
        providerLabel: 'Claude Agent SDK',
        surfaces: ['create_manager', 'manager_settings'],
        models: [
          {
            modelId: 'claude-opus-4-6',
            modelLabel: 'claude-opus-4-6',
            allowedThinkingLevels: ['off', 'minimal', 'medium', 'high'],
            defaultThinkingLevel: 'high',
          },
        ],
      },
      {
        provider: 'openai-codex-app-server',
        providerLabel: 'OpenAI Codex App Server',
        surfaces: ['manager_settings'],
        models: [
          {
            modelId: 'default',
            modelLabel: 'default',
            allowedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
            defaultThinkingLevel: 'xhigh',
          },
        ],
      },
    ],
  }
}
