// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor } from '@nexus/protocol'
import { SettingsGeneral } from './SettingsGeneral'
import * as settingsApi from './settings-api'
import type { ClaudeOutputStyleState } from './settings-types'

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

    const { rerender } = render(<SettingsGeneral wsUrl="ws://127.0.0.1:47187" managers={[managerA, managerB]} />)

    await waitFor(() => {
      expect(vi.mocked(settingsApi.fetchClaudeOutputStyle)).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        managerA.agentId,
      )
    })

    rerender(<SettingsGeneral wsUrl="ws://127.0.0.1:47187" managers={[managerB]} />)

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

    render(<SettingsGeneral wsUrl="ws://127.0.0.1:47187" managers={[managerA, managerB]} />)

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

    const allComboboxes = screen.getAllByRole('combobox')
    const managerSelect = allComboboxes[1]
    const outputStyleSelect = allComboboxes[2]
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
})
