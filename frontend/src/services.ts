// Wires the app's device stores, the sessions API and the timer together.

import { signedInUserId, type LocalDataHook } from './auth/localData.ts'
import {
  HttpSessionsApi,
  IndexedDbSessionStore,
  OwnedActiveSessionStore,
  SyncEngine,
  deviceSaver,
  quarantinePendingRecord,
  type SessionStore,
} from './sync/index.ts'
import { LocalActiveSessionStore, TimerController } from './timer/index.ts'

export interface AppServices {
  controller: TimerController
  sync: SyncEngine | null
  /** Sign-out hook (#9) for the session store; `main.tsx` registers it before anything renders. */
  hook: LocalDataHook | null
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
    countUnsynced: () => sessions.countUnsynced(currentOwner()),
    trySync: () => sync.trySync(),
    clear: () => sessions.clearOwner(currentOwner()),
    quarantine: (previousOwnerId) => quarantinePendingRecord(active, sessions, previousOwnerId),
  }
}

export function createAppServices(currentOwner: () => string | null = signedInUserId): AppServices {
  const sessions = new IndexedDbSessionStore()
  const sync = new SyncEngine({ store: sessions, api: new HttpSessionsApi(), currentOwner })
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
  return { controller, sync, hook: sessionDataHook({ sessions, sync, active, currentOwner }) }
}
