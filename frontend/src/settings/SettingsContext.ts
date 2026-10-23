import { createContext, useContext, useSyncExternalStore } from 'react'
import { SettingsStore, type SettingsState } from './store.ts'

// Outside a provider (tests of single screens) settings live in memory only.
const fallback = new SettingsStore()

export const SettingsContext = createContext<SettingsStore>(fallback)

export function useSettingsStore(): SettingsStore {
  return useContext(SettingsContext)
}

/** The current settings and what is still waiting to reach the server; re-renders on change. */
export function useSettingsState(): SettingsState {
  const store = useSettingsStore()
  return useSyncExternalStore(store.subscribe, store.getState)
}
