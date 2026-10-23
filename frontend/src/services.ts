// Wires the app's device stores, the sessions API and the timer together.

import {
  HttpSessionsApi,
  IndexedDbSessionStore,
  OwnedActiveSessionStore,
  SyncEngine,
  cachedUserId,
  deviceSaver,
  quarantinePendingRecord,
  type LocalDataHooks,
  type SessionStore,
} from './sync/index.ts'
import { LocalActiveSessionStore, TimerController } from './timer/index.ts'

export interface AppServices {
  controller: TimerController
  sync: SyncEngine | null
  /** Sign-out hooks (#9) for the session store; the app registers them while it runs. */
  hooks: LocalDataHooks | null
}

export interface SessionServicesOptions {
  sessions: SessionStore
  sync: SyncEngine
  active: OwnedActiveSessionStore
  currentOwner: () => string | null
}

/** The sign-out hooks for the session store, scoped to whoever is signed in when called. */
export function sessionDataHooks({
  sessions,
  sync,
  active,
  currentOwner,
}: SessionServicesOptions): LocalDataHooks {
  return {
    countUnsynced: () => sessions.countUnsynced(currentOwner()),
    trySync: () => sync.trySync(),
    clear: () => sessions.clearOwner(currentOwner()),
    quarantine: (previousOwnerId) => quarantinePendingRecord(active, sessions, previousOwnerId),
  }
}

export function createAppServices(): AppServices {
  const currentOwner = () => cachedUserId()
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
  return {
    controller,
    sync,
    hooks: sessionDataHooks({ sessions, sync, active, currentOwner }),
  }
}
