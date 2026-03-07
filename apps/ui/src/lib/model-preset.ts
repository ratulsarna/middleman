import type { AgentDescriptor, ManagerModelPreset } from '@nexus/protocol'

export function inferModelPreset(agent: AgentDescriptor): ManagerModelPreset | undefined {
  const provider = agent.model.provider.trim().toLowerCase()
  const modelId = agent.model.modelId.trim().toLowerCase()

  if (provider === 'openai-codex-app-server' && modelId === 'default') {
    return 'codex-app'
  }

  // Legacy codex-app model id aliases.
  if (provider === 'openai-codex-app-server' && (modelId === 'codex-app' || modelId === 'codex-app-server')) {
    return 'codex-app'
  }

  if (provider === 'claude-agent-sdk' && modelId === 'claude-opus-4-6') {
    return 'claude-agent-sdk'
  }

  return undefined
}
