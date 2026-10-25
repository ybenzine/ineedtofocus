import type { LocalDataHook } from '../auth/localData.ts'
import type { SettingsStore } from './store.ts'

/**
 * The sign-out hook for settings (#129): sends pending edits first (at most 10 s, skipped
 * offline), and reports the ones the server still hasn't accepted so the confirmation can name
 * them. Nothing to clear here: the cache is one of the keys sign-out removes.
 */
export function settingsDataHook(store: SettingsStore): LocalDataHook {
  return {
    countUnsynced: async () => ({ sessions: 0, edits: 0, settings: store.countUnsynced() }),
    trySync: () => store.trySync(),
    clear: async () => undefined,
  }
}
