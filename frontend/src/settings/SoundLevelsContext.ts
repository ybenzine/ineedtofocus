import { createContext, useContext, useSyncExternalStore } from 'react'
import { SoundLevelsStore, type SoundLevels } from './soundLevels.ts'

// Outside a provider (tests of single screens) the levels live in memory only.
const fallback = new SoundLevelsStore()

export const SoundLevelsContext = createContext<SoundLevelsStore>(fallback)

export function useSoundLevelsStore(): SoundLevelsStore {
  return useContext(SoundLevelsContext)
}

/** The device's alert and background levels; re-renders on change. */
export function useSoundLevels(): SoundLevels {
  const store = useSoundLevelsStore()
  return useSyncExternalStore(store.subscribe, store.getState)
}
