import { useCallback, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../store/use-settings-store'
import { errorMessage } from '../lib/utils'
import type { ApiKeyName } from '../../preload/index'

type Drafts = Record<ApiKeyName, string>

const EMPTY: Drafts = {
  openrouterApiKey: '',
  zernioApiKey: '',
  opencodeZenApiKey: '',
  opencodeGoApiKey: '',
  planningCustomApiKey: '',
  planningLocalApiKey: ''
}

/** Keep edited key fields local until saved; never persist untouched stale keys. */
export function useProviderKeyDrafts(): {
  drafts: Drafts
  setDraft: (key: ApiKeyName, value: string) => void
  persist: () => Promise<void>
  remove: (key: ApiKeyName) => Promise<void>
  savedAt: number | null
  error: string | null
} {
  const replaceApiKey = useSettingsStore((s) => s.replaceApiKey)
  const [drafts, setDrafts] = useState<Drafts>(EMPTY)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dirty = useRef(new Set<ApiKeyName>())
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts

  const persist = useCallback(async (): Promise<void> => {
    const next = [...dirty.current].filter((key) => draftsRef.current[key].trim())
    if (next.length === 0) return
    try {
      for (const key of next) {
        const value = draftsRef.current[key].trim()
        await replaceApiKey(key, value)
        if (draftsRef.current[key].trim() === value) {
          dirty.current.delete(key)
          draftsRef.current = { ...draftsRef.current, [key]: '' }
          setDrafts(draftsRef.current)
        }
      }
      setError(null)
      setSavedAt(Date.now())
    } catch (err) {
      setError(errorMessage(err, 'Could not save your API keys'))
    }
  }, [replaceApiKey])

  useEffect(() => {
    const timeout = setTimeout(() => void persist(), 600)
    return () => clearTimeout(timeout)
  }, [drafts, persist])

  // Navigation may unmount this form before the debounce fires.
  useEffect(() => () => { void persist() }, [persist])

  const setDraft = useCallback((key: ApiKeyName, value: string) => {
    dirty.current.add(key)
    draftsRef.current = { ...draftsRef.current, [key]: value }
    setDrafts(draftsRef.current)
  }, [])

  const remove = useCallback(async (key: ApiKeyName): Promise<void> => {
    try {
      await persist()
      await replaceApiKey(key, '')
      dirty.current.delete(key)
      draftsRef.current = { ...draftsRef.current, [key]: '' }
      setDrafts(draftsRef.current)
      setError(null)
      setSavedAt(Date.now())
    } catch (err) {
      setError(errorMessage(err, 'Could not remove the API key'))
    }
  }, [persist, replaceApiKey])

  return { drafts, setDraft, persist, remove, savedAt, error }
}
