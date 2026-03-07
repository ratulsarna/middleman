/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSidebar } from './AgentSidebar'
import type { AgentDescriptor, AgentStatus } from '@nexus/protocol'

function manager(
  agentId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
      ...modelOverrides,
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function worker(
  agentId: string,
  managerId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    ...manager(agentId, modelOverrides),
    managerId,
    role: 'worker',
  }
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
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
})

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

/** Scope queries to the first (desktop) aside to avoid dual-render duplicates. */
function sidebar(): HTMLElement {
  const el = container.querySelector('aside')
  if (!el) throw new Error('Sidebar <aside> not found')
  return el
}

function renderSidebar({
  agents,
  selectedAgentId = null,
  onSelectAgent = vi.fn(),
  onDeleteAgent = vi.fn(),
  onDeleteManager = vi.fn(),
  onOpenSettings = vi.fn(),
  isSettingsActive = false,
  statuses = {},
}: {
  agents: AgentDescriptor[]
  selectedAgentId?: string | null
  onSelectAgent?: (agentId: string) => void
  onDeleteAgent?: (agentId: string) => void
  onDeleteManager?: (managerId: string) => void
  onOpenSettings?: () => void
  isSettingsActive?: boolean
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>
}) {
  if (!root) {
    root = createRoot(container)
  }

  flushSync(() => {
    root?.render(
      createElement(AgentSidebar, {
        connected: true,
        agents,
        statuses,
        selectedAgentId,
        onAddManager: vi.fn(),
        onSelectAgent,
        onDeleteAgent,
        onDeleteManager,
        onOpenSettings,
        isSettingsActive,
      }),
    )
  })
}

describe('AgentSidebar', () => {
  it('shows workers expanded by default and toggles collapse/expand per manager', () => {
    renderSidebar({ agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')] })

    expect(queryByText(sidebar(), 'worker-alpha')).toBeTruthy()

    click(getByRole(sidebar(), 'button', { name: 'Collapse manager manager-alpha' }))
    expect(queryByText(sidebar(), 'worker-alpha')).toBeNull()

    click(getByRole(sidebar(), 'button', { name: 'Expand manager manager-alpha' }))
    expect(queryByText(sidebar(), 'worker-alpha')).toBeTruthy()
  })

  it('auto-expands a collapsed manager when worker count increases', () => {
    renderSidebar({ agents: [manager('manager-alpha')] })

    click(getByRole(sidebar(), 'button', { name: 'Collapse manager manager-alpha' }))
    expect(getByRole(sidebar(), 'button', { name: 'Expand manager manager-alpha' })).toBeTruthy()
    expect(queryByText(sidebar(), 'worker-alpha')).toBeNull()

    renderSidebar({
      agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')],
    })

    expect(queryByText(sidebar(), 'worker-alpha')).toBeTruthy()
    expect(getByRole(sidebar(), 'button', { name: 'Collapse manager manager-alpha' })).toBeTruthy()

    click(getByRole(sidebar(), 'button', { name: 'Collapse manager manager-alpha' }))
    expect(getByRole(sidebar(), 'button', { name: 'Expand manager manager-alpha' })).toBeTruthy()

    renderSidebar({
      agents: [
        manager('manager-alpha'),
        worker('worker-alpha', 'manager-alpha'),
        worker('worker-beta', 'manager-alpha'),
      ],
    })

    expect(queryByText(sidebar(), 'worker-alpha')).toBeTruthy()
    expect(queryByText(sidebar(), 'worker-beta')).toBeTruthy()
    expect(getByRole(sidebar(), 'button', { name: 'Collapse manager manager-alpha' })).toBeTruthy()
  })

  it('shows runtime icons and compact model labels from model presets', () => {
    renderSidebar({
      agents: [
        manager('manager-claude', { provider: 'claude-agent-sdk', modelId: 'claude-opus-4-6' }),
        worker('worker-codex', 'manager-claude', { provider: 'openai-codex-app-server', modelId: 'default' }),
      ],
    })

    // manager-claude (claude-agent-sdk): claude-logo
    // worker-codex (codex-app): codex-app-logo + codex-logo
    expect(sidebar().querySelectorAll('img[src="/agents/codex-logo.svg"]').length).toBe(1)
    expect(sidebar().querySelector('img[src="/agents/claude-logo.svg"]')).toBeTruthy()
    expect(sidebar().querySelector('img[src="/agents/codex-app-logo.svg"]')).toBeTruthy()
  })

  it('keeps manager selection behavior working while collapse state changes', () => {
    const onSelectAgent = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')],
      onSelectAgent,
    })

    const getManagerRowButton = () => getByText(sidebar(), 'manager-alpha').closest('button') as HTMLButtonElement
    expect(getManagerRowButton()).toBeTruthy()

    click(getManagerRowButton())
    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenLastCalledWith('manager-alpha')

    click(getByRole(sidebar(), 'button', { name: 'Collapse manager manager-alpha' }))
    expect(onSelectAgent).toHaveBeenCalledTimes(1)

    click(getManagerRowButton())
    expect(onSelectAgent).toHaveBeenCalledTimes(2)
    expect(onSelectAgent).toHaveBeenLastCalledWith('manager-alpha')
  })

  it('preserves existing delete controls for managers and workers', () => {
    const onDeleteAgent = vi.fn()
    const onDeleteManager = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')],
      onDeleteAgent,
      onDeleteManager,
    })

    // Delete is now in context menus — right-click trigger to open, then click "Delete"
    function openContextMenu(trigger: HTMLElement) {
      flushSync(() => {
        fireEvent.pointerDown(trigger, { button: 2, pointerType: 'mouse' })
        // Radix also listens for the native contextmenu event
        fireEvent.contextMenu(trigger)
      })
    }

    const managerTrigger = getByText(sidebar(), 'manager-alpha').closest('[data-slot="context-menu-trigger"]') as HTMLElement
    openContextMenu(managerTrigger)
    click(getByText(document.body, 'Delete'))
    expect(onDeleteManager).toHaveBeenCalledTimes(1)
    expect(onDeleteManager).toHaveBeenCalledWith('manager-alpha')

    const workerTrigger = getByText(sidebar(), 'worker-alpha').closest('[data-slot="context-menu-trigger"]') as HTMLElement
    openContextMenu(workerTrigger)
    const deleteItems = document.body.querySelectorAll('[data-slot="context-menu-item"]')
    const lastDelete = deleteItems[deleteItems.length - 1] as HTMLElement
    click(lastDelete)
    expect(onDeleteAgent).toHaveBeenCalledTimes(1)
    expect(onDeleteAgent).toHaveBeenCalledWith('worker-alpha')
  })

  it('calls onOpenSettings when the settings button is clicked', () => {
    const onOpenSettings = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha')],
      onOpenSettings,
    })

    click(getByRole(sidebar(), 'button', { name: 'Settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

})
