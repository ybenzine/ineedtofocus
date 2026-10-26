// Finished sessions on the device (IndexedDB through Dexie, AC13.2), with their sync state.
//
// A session is written here before any network call and stays here: `pending` until the server
// has it, `synced` once it has, or `rejected` if the server refused it (kept on the device, not
// retried automatically, shown as "Couldn't sync"; AC10.9, AC13.5). Tag/goal edits made on the
// device are kept apart from the session as a pending edit, so they reach the server as a
// `PATCH` and never as a re-save (AC11.4).
//
// Every session (and so its queued edit) belongs to the user who was signed in when it finished.
// Reads and sync take that owner: another account's sessions stay quarantined on the device,
// never shown to or synced into a different account, until their owner signs in again here.
// A session finished with nobody known to be signed in has no owner (`null`) and is never synced.

import Dexie, { type EntityTable } from 'dexie'
import type { SessionRecord } from '../timer/engine.ts'
import type { ApiError, ServerSession, SessionEdit } from './api.ts'

export type SyncState = 'pending' | 'synced' | 'rejected'
export type EditState = 'pending' | 'rejected'

export interface StoredSession {
  id: string
  /** The user id the session belongs to; `null` if nobody was known to be signed in. */
  ownerId: string | null
  /** The session as finished on the device; tag and goal follow the server's copy once synced. */
  record: SessionRecord
  syncState: SyncState
  /** Why the server refused the session (`syncState: 'rejected'`). */
  rejection: ApiError | null
  /** A tag/goal change made on the device that the server hasn't confirmed yet. */
  edit: SessionEdit | null
  editState: EditState | null
  /** Why the server refused the edit (`editState: 'rejected'`). */
  editRejection: ApiError | null
  /** Bumped on every edit, so a reply to an older edit can't clear a newer one. */
  editVersion: number
  /** From the server's copy: set if the session was archived (on any device). */
  archivedAt: string | null
  /** When it was saved on this device (ms since the epoch); the upload order. */
  savedAt: number
  /**
   * Set (ms since the epoch) when an online load found a synced session in neither the History
   * answer nor the Archive list (#227): it is hidden at once, and deleted only when a later load
   * pair that started after this moment still misses it. Absent in older records.
   */
  goneOnServer?: number | null
}

/** What history shows for a session (AC10.9). */
export type SyncIndicator = 'synced' | 'not-synced-yet' | 'couldnt-sync'

export interface DeviceSession {
  /** The session with any pending edit applied: what the user sees. */
  record: SessionRecord
  syncState: SyncState
  /** The tag/goal change the server hasn't confirmed, if any (already applied in `record`). */
  edit: SessionEdit | null
  editState: EditState | null
  indicator: SyncIndicator
  archivedAt: string | null
  /** The server seems not to have it (#227): hidden from History, kept until a load confirms. */
  goneOnServer: boolean
}

export function indicatorOf(entry: StoredSession): SyncIndicator {
  if (entry.syncState === 'rejected' || entry.editState === 'rejected') return 'couldnt-sync'
  if (entry.syncState === 'pending' || entry.editState === 'pending') return 'not-synced-yet'
  return 'synced'
}

export function toDeviceSession(entry: StoredSession): DeviceSession {
  return {
    record: { ...entry.record, ...entry.edit },
    syncState: entry.syncState,
    edit: entry.edit,
    editState: entry.editState,
    indicator: indicatorOf(entry),
    archivedAt: entry.archivedAt,
    goneOnServer: (entry.goneOnServer ?? null) !== null,
  }
}

/** What would be lost if one user's data were deleted from the device now. */
// Sign-out (#9) owns the shape: sessions "not synced yet" or "Couldn't sync", and edits.
export type { UnsyncedCount } from '../auth/localData.ts'
import type { UnsyncedCount } from '../auth/localData.ts'

/** The store as the timer and the sync engine use it; the app's is IndexedDB. */
export interface SessionStore {
  /**
   * Saves a finished session for `ownerId`. Idempotent by id: saving one that is already here
   * changes nothing (not even its owner).
   */
  save(record: SessionRecord, ownerId: string | null): Promise<void>
  get(id: string): Promise<StoredSession | undefined>
  /** The owner's sessions on the device, most recent first, with their sync state (AC10.9). */
  list(ownerId: string): Promise<DeviceSession[]>
  /** What of the owner's data hasn't reached the server: sessions and queued edits. */
  countUnsynced(ownerId: string | null): Promise<UnsyncedCount>
  /** True while anything of the owner's hasn't reached the server. */
  hasUnsynced(ownerId: string | null): Promise<boolean>
  /**
   * Records a tag/goal change to one of the owner's sessions; it is sent as a `PATCH` once the
   * session is on the server. Does nothing for another account's session.
   */
  edit(ownerId: string, id: string, change: SessionEdit): Promise<void>
  /**
   * Records that the server archived (`archivedAt`) or restored (`null`) the session, so the
   * device's copy follows. Does nothing for another account's session.
   */
  setArchived(ownerId: string, id: string, archivedAt: string | null): Promise<void>
  /**
   * Archives a session the server rejected on this device only: nothing is sent to the server,
   * which never had it. It leaves History and totals, and stays counted as unsynced until
   * deleted. Does nothing for a session the server has, or for another account's.
   */
  archiveOnDevice(ownerId: string, id: string): Promise<void>
  /** Puts a device-only archived session back in History, otherwise unchanged. */
  restoreOnDevice(ownerId: string, id: string): Promise<void>
  /**
   * Discards a tag/goal edit the server refused (`editState: 'rejected'`): the session keeps the
   * tag and goal it last synced with. A pending edit, or another account's, is left alone.
   */
  discardEdit(ownerId: string, id: string): Promise<void>
  /**
   * Forgets the owner's archived sessions on the device (the server just deleted them all),
   * including the ones archived on this device only (the server never had those), and the synced
   * ones in `alsoIds` (archived on another device, so not yet marked here).
   */
  removeArchived(ownerId: string, alsoIds?: readonly string[]): Promise<void>
  /**
   * `ids` are the owner's synced sessions that a load pair (History answer and Archive list) which
   * started at `loadStartedAt` (ms) found in neither (#227). One not marked yet is marked
   * `goneOnServer` (hidden, kept). One marked before `loadStartedAt` is deleted: this pair
   * started after the mark, so it confirms. One marked later is left as it is. Never touches
   * a session the server hasn't accepted (including device-only archived ones), another
   * account's, or one with a pending edit.
   */
  markGone(ownerId: string, ids: readonly string[], loadStartedAt: number): Promise<void>
  /** The server lists these sessions again: clear their `goneOnServer` mark. */
  clearGone(ownerId: string, ids: readonly string[]): Promise<void>
  /** Deletes every session (and edit) of this owner from the device; others' stay. */
  clearOwner(ownerId: string | null): Promise<void>

  // For the sync engine.
  /** The owner's pending sessions, oldest first, at most `limit`. */
  uploadQueue(ownerId: string, limit: number): Promise<StoredSession[]>
  /** The owner's synced sessions that have a pending edit. */
  editQueue(ownerId: string): Promise<StoredSession[]>
  markSynced(id: string, server: ServerSession | null): Promise<void>
  markRejected(id: string, error: ApiError | null): Promise<void>
  /** The server applied the edit made at `version`. */
  resolveEdit(id: string, version: number, server: ServerSession): Promise<void>
  /** The edit made at `version` can never apply (archived elsewhere, 409): forget it. */
  dropEdit(id: string, version: number): Promise<void>
  /** The server refused the edit made at `version`: keep it, stop retrying. */
  rejectEdit(id: string, version: number, error: ApiError | null): Promise<void>
}

export const SESSION_DB_NAME = 'ineedtofocus'

type FocusDatabase = Dexie & { sessions: EntityTable<StoredSession, 'id'> }

function openDatabase(name: string): FocusDatabase {
  const db = new Dexie(name) as FocusDatabase
  db.version(1).stores({ sessions: 'id, ownerId, syncState, editState' })
  return db
}

function fromServer(record: SessionRecord, server: ServerSession): SessionRecord {
  return { ...record, tag: server.tag, goal: server.goal }
}

export class IndexedDbSessionStore implements SessionStore {
  readonly #db: FocusDatabase
  readonly #now: () => number

  constructor(options: { name?: string; now?: () => number } = {}) {
    this.#db = openDatabase(options.name ?? SESSION_DB_NAME)
    this.#now = options.now ?? (() => Date.now())
  }

  close(): void {
    this.#db.close()
  }

  async save(record: SessionRecord, ownerId: string | null): Promise<void> {
    const sessions = this.#db.sessions
    await this.#db.transaction('rw', sessions, async () => {
      if ((await sessions.get(record.id)) !== undefined) return
      await sessions.add({
        id: record.id,
        ownerId,
        record,
        syncState: 'pending',
        rejection: null,
        edit: null,
        editState: null,
        editRejection: null,
        editVersion: 0,
        archivedAt: null,
        savedAt: this.#now(),
      })
    })
  }

  get(id: string): Promise<StoredSession | undefined> {
    return this.#db.sessions.get(id)
  }

  async list(ownerId: string): Promise<DeviceSession[]> {
    const mine = await this.#owned(ownerId)
    return mine
      .map(toDeviceSession)
      .sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt))
  }

  async countUnsynced(ownerId: string | null): Promise<UnsyncedCount> {
    const mine = await this.#owned(ownerId)
    return {
      sessions: mine.filter((entry) => entry.syncState !== 'synced').length,
      edits: mine.filter((entry) => entry.syncState === 'synced' && entry.editState !== null)
        .length,
    }
  }

  async hasUnsynced(ownerId: string | null): Promise<boolean> {
    const { sessions, edits } = await this.countUnsynced(ownerId)
    return sessions + edits > 0
  }

  async edit(ownerId: string, id: string, change: SessionEdit): Promise<void> {
    await this.#update(id, (entry) =>
      entry.ownerId !== ownerId
        ? {}
        : {
            edit: { ...entry.edit, ...change },
            editState: 'pending',
            editRejection: null,
            editVersion: entry.editVersion + 1,
          },
    )
  }

  async setArchived(ownerId: string, id: string, archivedAt: string | null): Promise<void> {
    // Only the server's archive state is followed here: a device-only archive (a rejected
    // session) is never changed by it.
    await this.#update(id, (entry) =>
      entry.ownerId === ownerId && entry.syncState === 'synced'
        ? {
            ...(entry.archivedAt !== archivedAt && { archivedAt }),
            // The server lists it (live or archived): it isn't gone.
            ...((entry.goneOnServer ?? null) !== null && { goneOnServer: null }),
          }
        : {},
    )
  }

  async archiveOnDevice(ownerId: string, id: string): Promise<void> {
    await this.#update(id, (entry) =>
      entry.ownerId === ownerId && entry.syncState === 'rejected' && entry.archivedAt === null
        ? { archivedAt: new Date(this.#now()).toISOString() }
        : {},
    )
  }

  async restoreOnDevice(ownerId: string, id: string): Promise<void> {
    await this.#update(id, (entry) =>
      entry.ownerId === ownerId && entry.syncState === 'rejected' && entry.archivedAt !== null
        ? { archivedAt: null }
        : {},
    )
  }

  async discardEdit(ownerId: string, id: string): Promise<void> {
    await this.#update(id, (entry) =>
      entry.ownerId === ownerId && entry.editState === 'rejected'
        ? { edit: null, editState: null, editRejection: null }
        : {},
    )
  }

  async removeArchived(ownerId: string, alsoIds: readonly string[] = []): Promise<void> {
    const extra = new Set(alsoIds)
    const sessions = this.#db.sessions
    await this.#db.transaction('rw', sessions, async () => {
      const ids = (await this.#owned(ownerId))
        .filter(
          (entry) =>
            // Device-only archived sessions (rejected) go too: the server never had them.
            (entry.syncState === 'rejected' && entry.archivedAt !== null) ||
            (entry.syncState === 'synced' && (entry.archivedAt !== null || extra.has(entry.id))),
        )
        .map((entry) => entry.id)
      await sessions.bulkDelete(ids)
    })
  }

  async markGone(ownerId: string, ids: readonly string[], loadStartedAt: number): Promise<void> {
    const wanted = new Set(ids)
    const sessions = this.#db.sessions
    await this.#db.transaction('rw', sessions, async () => {
      const now = this.#now()
      const confirmed: string[] = []
      for (const entry of await this.#owned(ownerId)) {
        if (
          !wanted.has(entry.id) ||
          entry.syncState !== 'synced' ||
          entry.editState === 'pending'
        ) {
          continue
        }
        const mark = entry.goneOnServer ?? null
        if (mark === null) await sessions.put({ ...entry, goneOnServer: now })
        else if (mark < loadStartedAt) confirmed.push(entry.id)
      }
      await sessions.bulkDelete(confirmed)
    })
  }

  async clearGone(ownerId: string, ids: readonly string[]): Promise<void> {
    const wanted = new Set(ids)
    const sessions = this.#db.sessions
    await this.#db.transaction('rw', sessions, async () => {
      for (const entry of await this.#owned(ownerId)) {
        if (wanted.has(entry.id) && (entry.goneOnServer ?? null) !== null) {
          await sessions.put({ ...entry, goneOnServer: null })
        }
      }
    })
  }

  async clearOwner(ownerId: string | null): Promise<void> {
    const sessions = this.#db.sessions
    await this.#db.transaction('rw', sessions, async () => {
      const ids = (await this.#owned(ownerId)).map((entry) => entry.id)
      await sessions.bulkDelete(ids)
    })
  }

  async uploadQueue(ownerId: string, limit: number): Promise<StoredSession[]> {
    const pending = (await this.#owned(ownerId)).filter((entry) => entry.syncState === 'pending')
    return pending.sort((a, b) => a.savedAt - b.savedAt).slice(0, limit)
  }

  async editQueue(ownerId: string): Promise<StoredSession[]> {
    return (await this.#owned(ownerId)).filter(
      (entry) => entry.syncState === 'synced' && entry.editState === 'pending',
    )
  }

  /** The owner's sessions. `null` owners aren't indexed by IndexedDB, so those are filtered. */
  #owned(ownerId: string | null): Promise<StoredSession[]> {
    if (ownerId === null) {
      return this.#db.sessions.filter((entry) => entry.ownerId === null).toArray()
    }
    return this.#db.sessions.where('ownerId').equals(ownerId).toArray()
  }

  async markSynced(id: string, server: ServerSession | null): Promise<void> {
    await this.#update(id, (entry) => ({
      syncState: 'synced',
      rejection: null,
      ...(server && {
        record: fromServer(entry.record, server),
        archivedAt: server.archivedAt,
      }),
    }))
  }

  async markRejected(id: string, error: ApiError | null): Promise<void> {
    await this.#update(id, (entry) =>
      entry.syncState === 'pending' ? { syncState: 'rejected', rejection: error } : {},
    )
  }

  async resolveEdit(id: string, version: number, server: ServerSession): Promise<void> {
    await this.#update(id, (entry) => ({
      record: fromServer(entry.record, server),
      archivedAt: server.archivedAt,
      ...(entry.editVersion === version && {
        edit: null,
        editState: null,
        editRejection: null,
      }),
    }))
  }

  async dropEdit(id: string, version: number): Promise<void> {
    await this.#update(id, (entry) =>
      entry.editVersion === version ? { edit: null, editState: null, editRejection: null } : {},
    )
  }

  async rejectEdit(id: string, version: number, error: ApiError | null): Promise<void> {
    await this.#update(id, (entry) =>
      entry.editVersion === version ? { editState: 'rejected', editRejection: error } : {},
    )
  }

  /** Reads and writes one session in a single transaction, so concurrent changes can't interleave. */
  async #update(
    id: string,
    change: (entry: StoredSession) => Partial<StoredSession>,
  ): Promise<void> {
    const sessions = this.#db.sessions
    await this.#db.transaction('rw', sessions, async () => {
      const entry = await sessions.get(id)
      if (entry === undefined) return
      const next = change(entry)
      if (Object.keys(next).length > 0) await sessions.put({ ...entry, ...next })
    })
  }
}
