// The hooks sign-out (#9) calls on modules that keep user data on the device (ruling on #9).
// #9's `localData.ts` owns the registry; until it lands, this minimal one stands in and the two
// are reconciled when both are on `main`.

import type { UnsyncedCount } from './sessionStore.ts'

export interface LocalDataHooks {
  /** What of the signed-in user's data would be lost: unsynced sessions and queued edits. */
  countUnsynced(): Promise<UnsyncedCount>
  /** A last sync before sign-out, at most 10 s; returns at once when offline. */
  trySync(): Promise<void>
  /** Deletes the signed-in user's data from the device; other accounts' stays. */
  clear(): Promise<void>
  /**
   * A different user is signing in: keep the previous owner's finished-but-not-handed-over
   * session on the device under their id (quarantined) before the active session is cleared.
   */
  quarantine(previousOwnerId: string): Promise<void>
}

const registry = new Set<LocalDataHooks>()

/** Registers hooks; returns the function that unregisters them. */
export function registerLocalDataHooks(hooks: LocalDataHooks): () => void {
  registry.add(hooks)
  return () => {
    registry.delete(hooks)
  }
}

export function registeredLocalDataHooks(): LocalDataHooks[] {
  return [...registry]
}
