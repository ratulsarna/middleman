import { useEffect, useState } from 'react'
import {
  createEmptyCreateManagerCatalog,
  fetchManagerModelCatalog,
  toManagerSettingsCatalog,
  type CreateManagerCatalog,
} from '@/lib/manager-model-catalog-api'

export function useModelCatalog(wsUrl: string): {
  catalog: CreateManagerCatalog | null
  isLoading: boolean
  error: string | null
} {
  const [catalog, setCatalog] = useState<CreateManagerCatalog | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    setIsLoading(true)
    setError(null)

    fetchManagerModelCatalog(wsUrl)
      .then((response) => {
        if (cancelled) return
        const parsed = toManagerSettingsCatalog(response)
        setCatalog(parsed.providers.length > 0 ? parsed : createEmptyCreateManagerCatalog())
        setIsLoading(false)
      })
      .catch((fetchError) => {
        if (cancelled) return
        setError(fetchError instanceof Error ? fetchError.message : 'Failed to load model catalog')
        setCatalog(null)
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [wsUrl])

  return { catalog, isLoading, error }
}
