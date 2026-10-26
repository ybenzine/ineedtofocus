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
  finishedRecordOf,
  parkedFor,
  quarantinePendingRecord,
  type SessionStore,
} from './sync/index.ts'
import { LocalActiveSessionStore, TimerController } from './timer/index.ts'

export interface AppServices {
  controller: TimerController
  sync: SyncEngine | null
  /** The device's finished sessions, shown in History (#20). */
  sessions?: SessionStore | null
  /** Sign-out hook (#9) for the session store; `main.tsx` registers it before anything renders. */
  hook: LocalDataHook | null
  /**
   * Moves sessions parked by a failed quarantine into the store. Run at start-up, on a timer
   * while the app is open, and after each successful save.
   */
  drainParked?: () => Promise<void>
  /**
   * True if the stored session was started by a different user than the one signed in now: its
   * summary is not shown to them (the record stays filed under its owner). Ask before restoring,
   * which clears the owner once the record is handed over.
   */
  isForeignSession?: () => boolean
  /**
   * Removes a session still running that a different user started, so their goal and tag can
   * never reach the timer screen. A finished one is left for the hand-off. Call it before
   * restoring. Returns true if something was removed.
   */
  discardForeignRunning?: () => boolean
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
      await clearParked(owner)
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
  let draining: Promise<void> | null = null
  const drain = (): Promise<void> => {
    // One pass at a time in this tab. Another tab may run its own pass and write the same entry
    // too: harmless, since saving is idempotent by id. The parked list's lock keeps the list
    // itself consistent (and sign-out out of the middle of a move), not the passes apart.
    draining ??= drainParked(sessions)
      .then((moved) => {
        if (moved > 0) void sync.syncNow()
      })
      .catch(() => undefined)
      .finally(() => {
        draining = null
      })
    return draining
  }
  const active = new OwnedActiveSessionStore(new LocalActiveSessionStore(), currentOwner)
  const controller = new TimerController({
    store: active,
    // On the device first (AC13.2), under the user who started the session; the network call
    // starts only once the write has landed.
    saveRecord: deviceSaver({
      store: sessions,
      ownerOf: (record) => {
        // The recorded owner, else the one captured at the first save attempt (the record
        // could not be written, #286), else whoever is signed in. Not `ownerOf()` alone:
        // `save` and `isForeignSession` rely on it reporting a missing key.
        const owner = active.ownerOf(record.id) ?? active.firstOwnerOf(record.id)
        return owner === undefined ? currentOwner() : owner
      },
      afterSave: () => {
        void sync.syncNow()
        void drain()
      },
    }),
  })
  const isForeignSession = (): boolean => {
    const stored = active.load()
    if (stored === null) return false
    const sessionId = stored.pendingRecord?.id ?? stored.session.id
    const recorded = active.ownerOf(sessionId)
    const now = currentOwner()
    return typeof recorded === 'string' && now !== null && recorded !== now
  }
  return {
    controller,
    sync,
    sessions,
    hook: sessionDataHook({ sessions, sync, active, currentOwner }),
    // Sessions parked during an earlier sign-in go into the store under their owners.
    drainParked: drain,
    isForeignSession,
    discardForeignRunning: () => {
      if (!isForeignSession()) return false
      // A finished one (a pending record, or a countdown past its end) is handed over under its
      // owner instead; only a session still running is dropped, as a sign-in as a different
      // user does.
      if (finishedRecordOf(active.load(), Date.now()) !== null) return false
      try {
        active.clear()
      } catch {
        return false
      }
      return true
    },
  }
}
