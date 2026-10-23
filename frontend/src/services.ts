// Wires the app's device stores, the sessions API and the timer together.

import { notifySessionExpired, signedInUserId, type LocalDataHook } from './auth/localData.ts'
import {
  HttpSessionsApi,
  IndexedDbSessionStore,
  OwnedActiveSessionStore,
  SyncEngine,
  clearParked,
  deviceSaver,
  drainParked,
  parkedFor,
  quarantinePendingRecord,
  type SessionStore,
} from './sync/index.ts'
import { LocalActiveSessionStore, TimerController } from './timer/index.ts'

export interface AppServices {
  controller: TimerController
  sync: SyncEngine | null
  /** Sign-out hook (#9) for the session store; `main.tsx` registers it before anything renders. */
  hook: LocalDataHook | null
  /** Moves sessions parked by a failed quarantine into the store; run at start-up. */
  drainParked?: () => Promise<void>
}

export interface SessionHookOptions {
  sessions: SessionStore
  sync: SyncEngine
  active: OwnedActiveSessionStore
  currentOwner: () => string | null
}

/** The sign-out hook for the session store, scoped to whoever is signed in when it is called. */
export function sessionDataHook({
  sessions,
  sync,
  active,
  currentOwner,
}: SessionHookOptions): LocalDataHook {
  return {
    countUnsynced: async () => {
      const owner = currentOwner()
      const stored = await sessions.countUnsynced(owner)
      // Parked ones may also have landed in the store already; overcounting is the safe side.
      return { ...stored, sessions: stored.sessions + parkedFor(owner).length }
    },
    trySync: () => sync.trySync(),
    clear: async () => {
      const owner = currentOwner()
      // Unknown user: clear nothing rather than someone else's (or nobody's) sessions.
      if (owner === null) return
      clearParked(owner)
      await sessions.clearOwner(owner)
    },
    quarantine: (previousOwnerId) => quarantinePendingRecord(active, sessions, previousOwnerId),
  }
}

export function createAppServices(currentOwner: () => string | null = signedInUserId): AppServices {
  const sessions = new IndexedDbSessionStore()
  const sync = new SyncEngine({
    store: sessions,
    api: new HttpSessionsApi(),
    currentOwner,
    // The sign-in expired: AuthGate re-checks it and shows sign-in, keeping the data (AC1.3).
    onUnauthorized: notifySessionExpired,
  })
  const active = new OwnedActiveSessionStore(new LocalActiveSessionStore(), currentOwner)
  const controller = new TimerController({
    store: active,
    // On the device first (AC13.2), under the user who started the session; the network call
    // starts only once the write has landed.
    saveRecord: deviceSaver({
      store: sessions,
      ownerOf: (record) => {
        const owner = active.ownerOf(record.id)
        return owner === undefined ? currentOwner() : owner
      },
      afterSave: () => void sync.syncNow(),
    }),
  })
  return {
    controller,
    sync,
    hook: sessionDataHook({ sessions, sync, active, currentOwner }),
    // Start-up: sessions parked during an earlier sign-in go into the store under their owners.
    drainParked: async () => {
      if ((await drainParked(sessions)) > 0) void sync.syncNow()
    },
  }
}
