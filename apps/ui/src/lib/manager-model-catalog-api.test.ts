import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEmptyCreateManagerCatalog,
  fetchManagerModelCatalog,
  getCatalogAllowedThinkingLevels,
  getCatalogDefaultModelForProvider,
  getCatalogDefaultThinkingLevel,
  getCatalogModelOptions,
  getCatalogProviderOptions,
  getDefaultCatalogSelection,
  isCatalogDescriptorSupported,
  toCreateManagerCatalog,
} from './manager-model-catalog-api'

describe('manager-model-catalog-api', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    ;(globalThis as { fetch?: typeof fetch }).fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('normalizes create-manager providers and models from backend catalog', () => {
    const catalog = toCreateManagerCatalog({
      fetchedAt: '2026-01-01T00:00:00.000Z',
      providers: [
        {
          provider: 'openai-codex',
          providerLabel: 'OpenAI Codex',
          surfaces: ['create_manager', 'manager_settings'],
          models: [
            {
              modelId: 'gpt-5',
              modelLabel: 'GPT-5',
              allowedThinkingLevels: ['off', 'high', 'xhigh', 'unknown'],
              defaultThinkingLevel: 'xhigh',
            },
            {
              modelId: 'gpt-5',
              modelLabel: 'Duplicate',
              allowedThinkingLevels: ['off'],
              defaultThinkingLevel: 'off',
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
              allowedThinkingLevels: ['off', 'high'],
              defaultThinkingLevel: 'high',
            },
          ],
        },
      ],
      warnings: ['warning-a', 'warning-a', ''],
    } as unknown as Parameters<typeof toCreateManagerCatalog>[0])

    expect(getCatalogProviderOptions(catalog)).toEqual([
      { value: 'openai-codex', label: 'OpenAI Codex' },
    ])
    expect(getCatalogModelOptions(catalog, 'openai-codex')).toEqual([
      { value: 'gpt-5', label: 'GPT-5' },
    ])
    expect(getCatalogAllowedThinkingLevels(catalog, 'openai-codex', 'gpt-5')).toEqual([
      'off',
      'high',
      'xhigh',
    ])
    expect(getCatalogDefaultThinkingLevel(catalog, 'openai-codex', 'gpt-5')).toBe('xhigh')
    expect(catalog.warnings).toEqual(['warning-a'])
  })

  it('handles malformed and empty payload entries safely', () => {
    const malformedCatalog = toCreateManagerCatalog({
      fetchedAt: '2026-01-01T00:00:00.000Z',
      providers: [
        null as unknown as never,
        {
          provider: 'anthropic',
          providerLabel: 'Anthropic',
          surfaces: ['create_manager'],
          models: [
            { modelId: '', allowedThinkingLevels: ['off'], defaultThinkingLevel: 'off' },
            { modelId: 'claude-opus', allowedThinkingLevels: [], defaultThinkingLevel: 'off' },
          ],
        },
      ] as unknown as never[],
      warnings: [123 as unknown as string],
    })

    expect(malformedCatalog).toEqual(createEmptyCreateManagerCatalog())
    expect(getDefaultCatalogSelection(malformedCatalog)).toBeNull()
    expect(isCatalogDescriptorSupported(malformedCatalog, 'anthropic', 'claude-opus')).toBe(false)
  })

  it('returns catalog defaults and descriptor support checks for valid data', () => {
    const catalog = toCreateManagerCatalog({
      fetchedAt: '2026-01-01T00:00:00.000Z',
      providers: [
        {
          provider: 'anthropic',
          providerLabel: 'Anthropic',
          surfaces: ['create_manager'],
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
      ],
    })

    expect(getDefaultCatalogSelection(catalog)).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
    expect(getCatalogDefaultModelForProvider(catalog, 'anthropic')).toBe('claude-opus-4-6')
    expect(isCatalogDescriptorSupported(catalog, 'anthropic', 'claude-sonnet-4-5')).toBe(true)
    expect(isCatalogDescriptorSupported(catalog, 'anthropic', 'missing')).toBe(false)
  })

  it('surfaces non-ok and invalid fetch responses', async () => {
    ;(globalThis as { fetch?: typeof fetch }).fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: 'Catalog request failed.' }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    await expect(fetchManagerModelCatalog('ws://127.0.0.1:47187')).rejects.toThrow(
      'Catalog request failed.',
    )

    ;(globalThis as { fetch?: typeof fetch }).fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ fetchedAt: '2026-01-01T00:00:00.000Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    await expect(fetchManagerModelCatalog('ws://127.0.0.1:47187')).rejects.toThrow(
      'Invalid manager model catalog response.',
    )
  })

  it('preserves plain-text non-JSON API error bodies', async () => {
    ;(globalThis as { fetch?: typeof fetch }).fetch = vi.fn(async () => {
      return new Response(
        'upstream gateway timeout while reading catalog',
        { status: 502, headers: { 'content-type': 'text/plain' } },
      )
    }) as unknown as typeof fetch

    await expect(fetchManagerModelCatalog('ws://127.0.0.1:47187')).rejects.toThrow(
      'upstream gateway timeout while reading catalog',
    )
  })
})
