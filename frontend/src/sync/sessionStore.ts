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
}

/** What history shows for a session (AC10.9). */
export type SyncIndicator = 'synced' | 'not-synced-yet' | 'couldnt-sync'

export interface DeviceSession {
  /** The session with any pending edit applied: what the user sees. */
  record: SessionRecord
  syncState: SyncState
  editState: EditState | null
  indicator: SyncIndicator
  archivedAt: string | null
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
    editState: entry.editState,
    indicator: indicatorOf(entry),
    archivedAt: entry.archivedAt,
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
