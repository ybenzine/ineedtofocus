// Who local data belongs to (ruling on #9): the signed-in user's id, and the owner of the session
// that is running or finished-but-not-yet-stored, so it is stored under the right account even
// if someone else signs in before it is handed over.

import type { ActiveSessionStore, StoredTimer } from '../timer/store.ts'
import { finishedRecordOf, parkSession } from './parked.ts'
import { SAVE_TIMEOUT_MS, withTimeout } from './saveRecord.ts'
import type { SessionStore } from './sessionStore.ts'

// The signed-in user comes from the accounts UI (#9): `signedInUserId()` in `auth/localData.ts`.

/** `{ sessionId, ownerId }` of the session in the active-session store. */
export const ACTIVE_OWNER_KEY = 'ineedtofocus.activeSessionOwner'

function readJson(storage: Storage, key: string): unknown {
  try {
    const raw = storage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

/**
 * Wraps the timer's active-session store and remembers who was signed in when the session
 * started. The owner travels with the session until it is cleared.
 */
export class OwnedActiveSessionStore implements ActiveSessionStore {
  readonly #inner: ActiveSessionStore
  readonly #currentOwner: () => string | null
  readonly #storage: Storage

  constructor(
    inner: ActiveSessionStore,
    currentOwner: () => string | null,
    storage: Storage = window.localStorage,
  ) {
    this.#inner = inner
    this.#currentOwner = currentOwner
    this.#storage = storage
  }

  load(): StoredTimer | null {
    return this.#inner.load()
  }

  save(state: StoredTimer): void {
    if (this.ownerOf(state.session.id) === undefined) {
      this.#storage.setItem(
        ACTIVE_OWNER_KEY,
        JSON.stringify({ sessionId: state.session.id, ownerId: this.#currentOwner() }),
      )
    }
    this.#inner.save(state)
  }

  clear(): void {
    this.#inner.clear()
    this.#storage.removeItem(ACTIVE_OWNER_KEY)
  }

  /** The owner recorded for this session: an id, `null` (nobody), or `undefined` if unknown. */
  ownerOf(sessionId: string): string | null | undefined {
    const value = readJson(this.#storage, ACTIVE_OWNER_KEY)
    if (typeof value !== 'object' || value === null) return undefined
    const { sessionId: recorded, ownerId } = value as Record<string, unknown>
    if (recorded !== sessionId) return undefined
    return typeof ownerId === 'string' ? ownerId : null
  }
}

/**
 * For a different user signing in (#9): keeps the previous owner's finished session (a
 * `pendingRecord`, or a countdown/Pomodoro that ended while the app was closed, AC6.5) under
 * `ownerId` instead of dropping it or giving it to the new account. It goes into the session
 * store if that works within `timeoutMs`; otherwise it is parked in localStorage and moved into
 * the store at the next start-up. Only then is it cleared from the timer. Throws only if it
 * could be neither stored nor parked; then the timer's copy is left in place.
 */
export async function quarantinePendingRecord(
  active: ActiveSessionStore,
  sessions: SessionStore,
  ownerId: string,
  options: { now?: () => number; timeoutMs?: number; storage?: Storage } = {},
): Promise<void> {
  const { now = () => Date.now(), timeoutMs = SAVE_TIMEOUT_MS, storage } = options
  const record = finishedRecordOf(active.load(), now())
  if (record === null) return
  try {
    await withTimeout(sessions.save(record, ownerId), timeoutMs)
  } catch {
    parkSession(ownerId, record, storage)
  }
  const stored = active.load()
  const still = stored?.pendingRecord?.id ?? stored?.session.id
  if (still === record.id) active.clear()
}
