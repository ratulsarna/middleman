import { describe, expect, it } from 'vitest'
import { buildManagerTreeRows, chooseFallbackAgentId, getPrimaryManagerId } from './agent-hierarchy'
import type { AgentDescriptor } from '@nexus/protocol'

function manager(agentId: string, managerId = agentId): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: `2026-01-01T00:00:0${agentId.endsWith('2') ? '1' : '0'}.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function worker(agentId: string, managerId: string): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker',
    status: 'idle',
    createdAt: '2026-01-01T00:00:02.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

describe('agent-hierarchy', () => {
  it('groups workers under owning managers', () => {
    const agents: AgentDescriptor[] = [
      manager('manager'),
      manager('manager-2', 'manager'),
      worker('worker-a', 'manager'),
      worker('worker-b', 'manager-2'),
      worker('worker-orphan', 'missing-manager'),
    ]

    const { managerRows, orphanWorkers } = buildManagerTreeRows(agents)

    expect(managerRows).toHaveLength(2)
    expect(managerRows[0]?.manager.agentId).toBe('manager')
    expect(managerRows[0]?.workers.map((entry) => entry.agentId)).toEqual(['worker-a'])
    expect(managerRows[1]?.manager.agentId).toBe('manager-2')
    expect(managerRows[1]?.workers.map((entry) => entry.agentId)).toEqual(['worker-b'])
    expect(orphanWorkers.map((entry) => entry.agentId)).toEqual(['worker-orphan'])
  })

  it('prefers the legacy default manager id when choosing a primary manager', () => {
    const agents: AgentDescriptor[] = [manager('manager'), manager('manager-2', 'manager')]
    expect(getPrimaryManagerId(agents)).toBe('manager')
  })

  it('falls back to created-order manager selection when no legacy manager id exists', () => {
    const agents: AgentDescriptor[] = [manager('beta'), manager('alpha')]
    expect(getPrimaryManagerId(agents)).toBe('alpha')
  })

  it('chooses fallback target preferring a primary manager', () => {
    const agents: AgentDescriptor[] = [
      manager('manager'),
      manager('manager-2', 'manager'),
      worker('worker-a', 'manager-2'),
    ]

    expect(chooseFallbackAgentId(agents, 'worker-a')).toBe('worker-a')
    expect(chooseFallbackAgentId(agents, 'missing-agent')).toBe('manager')
  })

  it('treats stopped and errored agents as inactive for fallback/primary selection', () => {
    const stoppedManager = { ...manager('manager-stopped'), status: 'stopped' as const }
    const erroredWorker = { ...worker('worker-error', 'manager-stopped'), status: 'error' as const }

    expect(getPrimaryManagerId([stoppedManager])).toBeNull()
    // With no preferred agent, only active agents are candidates — neither is active
    expect(chooseFallbackAgentId([stoppedManager, erroredWorker], null)).toBeNull()
  })

  it('preserves preferred agent selection for terminated/stopped managers (no selection thrash)', () => {
    const activeManager = manager('mgr-active')
    const terminatedManager = { ...manager('mgr-terminated'), status: 'terminated' as const }

    // User clicked on a terminated manager — should stay selected, not thrash to active one
    expect(chooseFallbackAgentId([activeManager, terminatedManager], 'mgr-terminated')).toBe('mgr-terminated')

    // Stopped too
    const stoppedManager = { ...manager('mgr-stopped'), status: 'stopped' as const }
    expect(chooseFallbackAgentId([activeManager, stoppedManager], 'mgr-stopped')).toBe('mgr-stopped')

    // Error agents are hidden from sidebar — should NOT be preserved
    const errorManager = { ...manager('mgr-error'), status: 'error' as const }
    expect(chooseFallbackAgentId([activeManager, errorManager], 'mgr-error')).toBe('mgr-active')
  })

  it('does not preserve terminated/stopped workers as preferred (they are hidden from sidebar)', () => {
    const activeManager = manager('mgr-active')
    const terminatedWorker = { ...worker('w-dead', 'mgr-active'), status: 'terminated' as const }

    // Terminated worker is not visible in sidebar tree — should fall back to active manager
    expect(chooseFallbackAgentId([activeManager, terminatedWorker], 'w-dead')).toBe('mgr-active')

    // Active worker is visible — should be preserved
    const activeWorker = worker('w-live', 'mgr-active')
    expect(chooseFallbackAgentId([activeManager, activeWorker], 'w-live')).toBe('w-live')
  })

  it('includes terminated managers in sidebar rows', () => {
    const agents = [{ ...manager('mgr'), status: 'terminated' as const }]
    const { managerRows } = buildManagerTreeRows(agents)
    expect(managerRows).toHaveLength(1)
    expect(managerRows[0]?.manager.agentId).toBe('mgr')
  })

  it('includes stopped managers in sidebar rows', () => {
    const agents = [{ ...manager('mgr'), status: 'stopped' as const }]
    const { managerRows } = buildManagerTreeRows(agents)
    expect(managerRows).toHaveLength(1)
  })

  it('excludes error-status managers from sidebar rows', () => {
    const agents = [{ ...manager('mgr'), status: 'error' as const }]
    const { managerRows } = buildManagerTreeRows(agents)
    expect(managerRows).toHaveLength(0)
  })

  it('sorts active managers before non-active managers', () => {
    const agents = [
      { ...manager('mgr-dead'), status: 'terminated' as const },
      manager('mgr-live'),
    ]
    const { managerRows } = buildManagerTreeRows(agents)
    expect(managerRows[0]?.manager.agentId).toBe('mgr-live')
    expect(managerRows[1]?.manager.agentId).toBe('mgr-dead')
  })

  it('does not consider terminated managers for getPrimaryManagerId', () => {
    expect(getPrimaryManagerId([{ ...manager('mgr'), status: 'terminated' as const }])).toBeNull()
  })

  it('does not consider terminated managers for chooseFallbackAgentId', () => {
    expect(chooseFallbackAgentId([{ ...manager('mgr'), status: 'terminated' as const }])).toBeNull()
  })

  it('excludes terminated workers from sidebar rows', () => {
    const agents = [
      manager('mgr'),
      { ...worker('w1', 'mgr'), status: 'terminated' as const },
    ]
    const { managerRows } = buildManagerTreeRows(agents)
    expect(managerRows[0]?.workers).toHaveLength(0)
  })
})
