import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConfig } from '../config.js'

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'SWARM_ROOT_DIR',
  'SWARM_DATA_DIR',
  'SWARM_AUTH_FILE',
  'SWARM_HOST',
  'SWARM_PORT',
  'NEXUS_HOST',
  'NEXUS_PORT',
  'NEXUS_DATA_DIR',
  'SWARM_DEBUG',
  'SWARM_ALLOW_NON_MANAGER_SUBSCRIPTIONS',
  'SWARM_MANAGER_ID',
  'SWARM_DEFAULT_CWD',
  'SWARM_MODEL_PROVIDER',
  'SWARM_MODEL_ID',
  'SWARM_THINKING_LEVEL',
  'SWARM_CWD_ALLOWLIST_ROOTS',
] as const

async function withEnv(overrides: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>>, run: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>()

  for (const key of MANAGED_ENV_KEYS) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    await run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('createConfig', () => {
  it('uses fixed defaults for non-host/port config', async () => {
    await withEnv({}, () => {
      const config = createConfig()

      expect(config.host).toBe('127.0.0.1')
      expect(config.port).toBe(47187)
      expect(config.debug).toBe(true)
      expect(config.allowNonManagerSubscriptions).toBe(true)
      expect(config.managerId).toBeUndefined()
      expect(config.defaultModel).toEqual({
        provider: 'claude-agent-sdk',
        modelId: 'claude-opus-4-6',
        thinkingLevel: 'xhigh',
      })
      expect(config.modelPresetDefinitions?.['claude-agent-sdk'].descriptor).toEqual({
        provider: 'claude-agent-sdk',
        modelId: 'claude-opus-4-6',
        thinkingLevel: 'xhigh',
      })
      expect(config.providerThinkingLevelMappings?.codexAppServer.xhigh).toBe('xhigh')
      expect(config.providerThinkingLevelMappings?.claudeAgentSdk.off).toEqual({
        thinking: 'disabled',
      })

      expect(config.paths.dataDir).toBe(resolve(homedir(), '.nexus'))
      expect(config.paths.swarmDir).toBe(resolve(homedir(), '.nexus', 'swarm'))
      expect(config.paths.sessionsDir).toBe(resolve(homedir(), '.nexus', 'sessions'))
      expect(config.paths.uploadsDir).toBe(resolve(homedir(), '.nexus', 'uploads'))
      expect(config.paths.authDir).toBe(resolve(homedir(), '.nexus', 'auth'))
      expect(config.paths.authFile).toBe(resolve(homedir(), '.nexus', 'auth', 'auth.json'))
      expect(config.paths.managerAgentDir).toBe(resolve(homedir(), '.nexus', 'agent', 'manager'))
      expect(config.paths.repoArchetypesDir).toBe(resolve(config.paths.rootDir, '.swarm', 'archetypes'))
      expect(config.paths.agentsStoreFile).toBe(resolve(homedir(), '.nexus', 'swarm', 'agents.json'))
      expect(config.paths.schedulesFile).toBeUndefined()

      expect(config.defaultCwd).toBe(config.paths.rootDir)
      expect(config.cwdAllowlistRoots).toContain(config.paths.rootDir)
      expect(config.cwdAllowlistRoots).toContain(resolve(homedir(), 'worktrees'))
    })
  })

  it('respects NEXUS_HOST and NEXUS_PORT', async () => {
    await withEnv({ NEXUS_HOST: '0.0.0.0', NEXUS_PORT: '9999' }, () => {
      const config = createConfig()
      expect(config.host).toBe('0.0.0.0')
      expect(config.port).toBe(9999)
    })
  })

  it('ignores removed SWARM_* env vars', async () => {
    await withEnv(
      {
        NODE_ENV: 'development',
        SWARM_ROOT_DIR: '/tmp/swarm-root',
        SWARM_DATA_DIR: '/tmp/swarm-data',
        SWARM_AUTH_FILE: '/tmp/swarm-auth/auth.json',
        SWARM_DEBUG: 'false',
        SWARM_ALLOW_NON_MANAGER_SUBSCRIPTIONS: 'false',
        SWARM_MANAGER_ID: 'opus-manager',
        SWARM_DEFAULT_CWD: '/tmp/swarm-cwd',
        SWARM_MODEL_PROVIDER: 'anthropic',
        SWARM_MODEL_ID: 'claude-opus-4-6',
        SWARM_THINKING_LEVEL: 'low',
        SWARM_CWD_ALLOWLIST_ROOTS: '/tmp/swarm-allowlist',
      },
      () => {
        const config = createConfig()

        expect(config.paths.dataDir).toBe(resolve(homedir(), '.nexus'))
        expect(config.paths.authFile).toBe(resolve(homedir(), '.nexus', 'auth', 'auth.json'))
        expect(config.debug).toBe(true)
        expect(config.allowNonManagerSubscriptions).toBe(true)
        expect(config.managerId).toBeUndefined()
        expect(config.defaultCwd).toBe(config.paths.rootDir)
        expect(config.defaultModel).toEqual({
          provider: 'claude-agent-sdk',
          modelId: 'claude-opus-4-6',
          thinkingLevel: 'xhigh',
        })
        expect(config.modelPresetDefinitions?.['claude-agent-sdk'].descriptor.modelId).toBe('claude-opus-4-6')
        expect(config.cwdAllowlistRoots).not.toContain('/tmp/swarm-allowlist')
      }
    )
  })
})
