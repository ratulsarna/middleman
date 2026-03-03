// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor } from '@nexus/protocol'
import { SettingsGeneral } from './SettingsGeneral'
import * as settingsApi from './settings-api'
import type { ClaudeOutputStyleState } from './settings-types'
import type { UpdateManagerInput, UpdateManagerResult } from '@/lib/ws-client'

vi.mock('./settings-api', async () => {
  const actual = await vi.importActual<typeof import('./settings-api')>('./settings-api')
  return {
    ...actual,
    fetchClaudeOutputStyle: vi.fn(),
    updateClaudeOutputStyle: vi.fn(),
  }
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createClaudeManager(agentId: string, displayName: string): AgentDescriptor {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    agentId,
    managerId: agentId,
    displayName,
    role: 'manager',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    cwd: `/tmp/${agentId}`,
    model: {
      provider: 'claude-agent-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'medium',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function createManager(
  agentId: string,
  displayName: string,
  model: AgentDescriptor['model'],
  promptOverride?: string,
): AgentDescriptor {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    agentId,
    managerId: agentId,
    displayName,
    role: 'manager',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    cwd: `/tmp/${agentId}`,
    model,
    promptOverride,
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function createUpdateManagerMock(
  implementation?: (input: UpdateManagerInput) => Promise<UpdateManagerResult>,
) {
  return vi.fn(
    implementation ??
      (async () => {
        throw new Error('Unexpected manager update call in test.')
      }),
  )
}

describe('SettingsGeneral', () => {
  const originalResizeObserver = globalThis.ResizeObserver
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

  beforeEach(() => {
    class MockResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    ;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: () => {},
    })
  })

  afterEach(() => {
    cleanup()
    ;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = originalResizeObserver
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: originalScrollIntoView,
    })
    vi.resetAllMocks()
  })

  it('ignores stale style-load responses from a previously selected manager', async () => {
    const managerA = createClaudeManager('manager-a', 'Manager A')
    const managerB = createClaudeManager('manager-b', 'Manager B')

    const deferredA = createDeferred<ClaudeOutputStyleState>()
    const deferredB = createDeferred<ClaudeOutputStyleState>()

    vi.mocked(settingsApi.fetchClaudeOutputStyle).mockImplementation((_wsUrl, managerId) => {
      if (managerId === managerA.agentId) {
        return deferredA.promise
      }
      if (managerId === managerB.agentId) {
        return deferredB.promise
      }
      throw new Error(`Unexpected manager id: ${managerId}`)
    })

    const { rerender } = render(
      <SettingsGeneral
        wsUrl="ws://127.0.0.1:47187"
        managers={[managerA, managerB]}
        onUpdateManager={createUpdateManagerMock()}
      />,
    )

    await waitFor(() => {
      expect(vi.mocked(settingsApi.fetchClaudeOutputStyle)).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        managerA.agentId,
      )
    })

    rerender(
      <SettingsGeneral
        wsUrl="ws://127.0.0.1:47187"
        managers={[managerB]}
        onUpdateManager={createUpdateManagerMock()}
      />,
    )

    await waitFor(() => {
      expect(vi.mocked(settingsApi.fetchClaudeOutputStyle)).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        managerB.agentId,
      )
    })

    await act(async () => {
      deferredB.resolve({
        managerId: managerB.agentId,
        selectedStyle: 'concise',
        availableStyles: ['concise'],
        warning: 'warning-from-b',
      })
      await Promise.resolve()
    })

    await screen.findByText('warning-from-b')

    await act(async () => {
      deferredA.resolve({
        managerId: managerA.agentId,
        selectedStyle: 'default',
        availableStyles: ['default'],
        warning: 'warning-from-a',
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.queryByText('warning-from-a')).toBeNull()
    })
    expect(screen.getByText('warning-from-b')).toBeTruthy()
  })

  it('clears saving lock when switching managers during an in-flight style save', async () => {
    const managerA = createClaudeManager('manager-a', 'Manager A')
    const managerB = createClaudeManager('manager-b', 'Manager B')
    const saveDeferred = createDeferred<ClaudeOutputStyleState>()

    vi.mocked(settingsApi.fetchClaudeOutputStyle).mockImplementation(async (_wsUrl, managerId) => ({
      managerId,
      selectedStyle: null,
      availableStyles: ['concise', 'technical'],
    }))
    vi.mocked(settingsApi.updateClaudeOutputStyle).mockImplementation(async (_wsUrl, managerId) => {
      if (managerId !== managerA.agentId) {
        throw new Error(`Unexpected save manager id: ${managerId}`)
      }
      return saveDeferred.promise
    })

    render(
      <SettingsGeneral
        wsUrl="ws://127.0.0.1:47187"
        managers={[managerA, managerB]}
        onUpdateManager={createUpdateManagerMock()}
      />,
    )

    await waitFor(() => {
      expect(vi.mocked(settingsApi.fetchClaudeOutputStyle)).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        managerA.agentId,
      )
    })

    const refreshButton = screen.getByRole('button', { name: 'Refresh styles' })
    await waitFor(() => {
      expect((refreshButton as HTMLButtonElement).disabled).toBe(false)
    })

    const managerSelect = screen.getByRole('combobox', { name: 'Claude manager' })
    const outputStyleSelect = screen.getByRole('combobox', { name: 'Claude output style' })
    fireEvent.click(outputStyleSelect)
    fireEvent.click(await screen.findByRole('option', { name: 'concise' }))

    await waitFor(() => {
      expect(vi.mocked(settingsApi.updateClaudeOutputStyle)).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        managerA.agentId,
        'concise',
      )
    })

    expect((refreshButton as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(managerSelect)
    fireEvent.click(await screen.findByRole('option', { name: 'Manager B' }))

    await waitFor(() => {
      expect(vi.mocked(settingsApi.fetchClaudeOutputStyle)).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        managerB.agentId,
      )
    })

    await waitFor(() => {
      expect((refreshButton as HTMLButtonElement).disabled).toBe(false)
    })

    await act(async () => {
      saveDeferred.resolve({
        managerId: managerA.agentId,
        selectedStyle: 'concise',
        availableStyles: ['concise', 'technical'],
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect((refreshButton as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('saves manager runtime settings with explicit descriptor fields and no-reset feedback', async () => {
    const manager = createManager(
      'manager-a',
      'Manager A',
      {
        provider: 'openai-codex',
        modelId: 'gpt-5.3-codex',
        thinkingLevel: 'high',
      },
      'Current override',
    )

    const onUpdateManager = createUpdateManagerMock(async () => ({
      manager: {
        ...manager,
        promptOverride: 'Current override',
      },
      resetApplied: false,
    }))

    render(
      <SettingsGeneral
        wsUrl="ws://127.0.0.1:47187"
        managers={[manager]}
        onUpdateManager={onUpdateManager}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save manager settings' }))

    await waitFor(() => {
      expect(onUpdateManager).toHaveBeenCalledTimes(1)
    })

    expect(onUpdateManager).toHaveBeenCalledWith({
      managerId: 'manager-a',
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    })

    expect(
      screen.getByText('Manager settings saved. No runtime reset was needed.'),
    ).toBeTruthy()
  })

  it('preserves runtime save feedback after same-manager props refresh', async () => {
    const manager = createManager(
      'manager-a',
      'Manager A',
      {
        provider: 'openai-codex',
        modelId: 'gpt-5.3-codex',
        thinkingLevel: 'high',
      },
      'Current override',
    )
    const updatedManager: AgentDescriptor = {
      ...manager,
      updatedAt: '2026-01-01T00:00:01.000Z',
    }

    const onUpdateManager = createUpdateManagerMock(async () => ({
      manager: updatedManager,
      resetApplied: true,
    }))

    const { rerender } = render(
      <SettingsGeneral
        wsUrl="ws://127.0.0.1:47187"
        managers={[manager]}
        onUpdateManager={onUpdateManager}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save manager settings' }))

    await waitFor(() => {
      expect(onUpdateManager).toHaveBeenCalledTimes(1)
    })

    await screen.findByText('Manager settings saved. Runtime was reset.')

    rerender(
      <SettingsGeneral
        wsUrl="ws://127.0.0.1:47187"
        managers={[
          {
            ...updatedManager,
            updatedAt: '2026-01-01T00:00:02.000Z',
          },
        ]}
        onUpdateManager={onUpdateManager}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Manager settings saved. Runtime was reset.')).toBeTruthy()
    })
  })

  it('preserves no-reset runtime save feedback after same-manager props refresh', async () => {
    const manager = createManager(
      'manager-a',
      'Manager A',
      {
        provider: 'openai-codex',
        modelId: 'gpt-5.3-codex',
        thinkingLevel: 'high',
      },
      'Current override',
    )
    const updatedManager: AgentDescriptor = {
      ...manager,
      updatedAt: '2026-01-01T00:00:01.000Z',
    }

    const onUpdateManager = createUpdateManagerMock(async () => ({
      manager: updatedManager,
      resetApplied: false,
    }))

    const { rerender } = render(
      <SettingsGeneral
        wsUrl="ws://127.0.0.1:47187"
        managers={[manager]}
        onUpdateManager={onUpdateManager}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save manager settings' }))

    await waitFor(() => {
      expect(onUpdateManager).toHaveBeenCalledTimes(1)
    })

    await screen.findByText('Manager settings saved. No runtime reset was needed.')

    rerender(
      <SettingsGeneral
        wsUrl="ws://127.0.0.1:47187"
        managers={[
          {
            ...updatedManager,
            updatedAt: '2026-01-01T00:00:02.000Z',
          },
        ]}
        onUpdateManager={onUpdateManager}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Manager settings saved. No runtime reset was needed.')).toBeTruthy()
    })
  })

  it('blocks manager runtime save when selected descriptor is unsupported', async () => {
    const unsupportedManager = createManager(
      'manager-unsupported',
      'Unsupported Manager',
      {
        provider: 'custom-provider',
        modelId: 'custom-model',
        thinkingLevel: 'medium',
      },
    )
    const onUpdateManager = createUpdateManagerMock()

    render(
      <SettingsGeneral
        wsUrl="ws://127.0.0.1:47187"
        managers={[unsupportedManager]}
        onUpdateManager={onUpdateManager}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save manager settings' }))

    await waitFor(() => {
      expect(
        screen.getByText('Current model is unsupported in this editor. Choose a supported model to save.'),
      ).toBeTruthy()
    })
    expect(onUpdateManager).not.toHaveBeenCalled()
  })
})
