// A last-resort shelf for a previous owner's finished session when it couldn't be written to
// IndexedDB during a different user's sign-in (failed or stalled). It is never deleted there:
// it is parked in localStorage under its owner, outside the per-user keys, and moved into the
// session store at the next start-up and while the app is open (F13; owner ruling on #9). Parked sessions belong to their
// owner: not shown to or synced into anyone else, counted and cleared with that owner's data.

import { advance, finishSession, type SessionRecord } from '../timer/engine.ts'
import type { StoredTimer } from '../timer/store.ts'
import { SAVE_TIMEOUT_MS, withTimeout } from './saveRecord.ts'
import type { SessionStore } from './sessionStore.ts'

export const PARKED_KEY = 'ineedtofocus.quarantine.pending'

export interface ParkedSession {
  ownerId: string
  record: SessionRecord
}

function isParked(value: unknown): value is ParkedSession {
  if (typeof value !== 'object' || value === null) return false
  const { ownerId, record } = value as Record<string, unknown>
  return (
    typeof ownerId === 'string' &&
    typeof record === 'object' &&
    record !== null &&
    typeof (record as Record<string, unknown>).id === 'string'
  )
}

export function loadParked(storage: Storage = window.localStorage): ParkedSession[] {
  try {
    const raw = storage.getItem(PARKED_KEY)
    const value: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(value) ? value.filter(isParked) : []
  } catch {
    return []
  }
}

/** Throws if the device can't store it, so the caller knows not to delete the original. */
function writeParked(list: ParkedSession[], storage: Storage): void {
  if (list.length === 0) storage.removeItem(PARKED_KEY)
  else storage.setItem(PARKED_KEY, JSON.stringify(list))
}

export const PARKED_LOCK = 'ineedtofocus-parked'

/**
 * Runs a read-modify-write of the parked list alone across tabs (Web Locks), so two tabs can't
 * overwrite each other's entries. Without Web Locks (older browsers, jsdom) it just runs: the
 * read and the write then happen in one synchronous step, which is as close as localStorage gets.
 */
export function withParkedLock<T>(run: () => T | Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) return Promise.resolve().then(run)
  return locks.request(PARKED_LOCK, async () => run())
}

/** Parks a session for its owner (once per id). Rejects if localStorage refuses the write. */
export function parkSession(
  ownerId: string,
  record: SessionRecord,
  storage: Storage = window.localStorage,
): Promise<void> {
  return withParkedLock(() => {
    const list = loadParked(storage)
    if (list.some((parked) => parked.record.id === record.id)) return
    writeParked([...list, { ownerId, record }], storage)
  })
}

async function removeParked(
  keep: (parked: ParkedSession) => boolean,
  storage: Storage = window.localStorage,
): Promise<void> {
  try {
    await withParkedLock(() => writeParked(loadParked(storage).filter(keep), storage))
  } catch {
    // Nothing removed: it will be tried again.
  }
}

/** The owner's parked sessions. */
export function parkedFor(ownerId: string | null, storage?: Storage): ParkedSession[] {
  return ownerId === null ? [] : loadParked(storage).filter((parked) => parked.ownerId === ownerId)
}

/** Explicit sign-out of `ownerId`: forget their parked sessions; other owners' stay. */
export function clearParked(ownerId: string, storage?: Storage): Promise<void> {
  return removeParked((parked) => parked.ownerId !== ownerId, storage)
}

/**
 * Moves parked sessions into the session store under their owners. Each leaves the shelf only
 * after its write has landed; a failed or stalled write leaves it for next time.
 */
export async function drainParked(
  sessions: SessionStore,
  options: { storage?: Storage; timeoutMs?: number } = {},
): Promise<number> {
  const { storage = window.localStorage, timeoutMs = SAVE_TIMEOUT_MS } = options
  let moved = 0
  for (const { record } of loadParked(storage)) {
    // Looked at again under the lock, and held until the write has landed and the entry is off
    // the shelf: a sign-out (`clearParked`, in this tab or another) waits its turn, so it can
    // neither lose an entry mid-move nor leave a later one to be saved after its data was
    // cleared. A stalled write holds the lock for at most `timeoutMs`.
    try {
      const done = await withParkedLock(async () => {
        const entry = loadParked(storage).find((other) => other.record.id === record.id)
        if (entry === undefined) return false
        await withTimeout(sessions.save(entry.record, entry.ownerId), timeoutMs)
        writeParked(
          loadParked(storage).filter((other) => other.record.id !== record.id),
          storage,
        )
        return true
      })
      if (done) moved += 1
    } catch {
      // A failed or stalled write, or a refused removal: it stays on the shelf for next time.
    }
  }
  return moved
}

/**
 * The finished session held in the active-session store, if any: a `pendingRecord`, or a
 * countdown or Pomodoro that reached its end while the app was closed (Completed, AC6.5).
 * A session still running has none: it can't move between accounts.
 */
export function finishedRecordOf(stored: StoredTimer | null, now: number): SessionRecord | null {
  if (stored === null) return null
  if (stored.pendingRecord !== null) return stored.pendingRecord
  const { session, endedAt } = advance(stored.session, now)
  if (endedAt === null) return null
  const outcome = finishSession(session, endedAt, 'completed')
  return outcome.kind === 'saved' ? outcome.record : null
}
