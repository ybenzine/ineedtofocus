// Who local data belongs to (ruling on #9): the signed-in user's id, and the owner of the session
// that is running or finished-but-not-yet-stored, so it is stored under the right account even
// if someone else signs in before it is handed over.

import type { ActiveSessionStore, StoredTimer } from '../timer/store.ts'
import type { SessionStore } from './sessionStore.ts'

/** The signed-in user, cached on the device by the accounts UI (#9). */
export const USER_KEY = 'ineedtofocus.user'
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

/** The cached signed-in user's id, or `null` if nobody is signed in on this device. */
export function cachedUserId(storage: Storage = window.localStorage): string | null {
  const user = readJson(storage, USER_KEY)
  if (typeof user !== 'object' || user === null) return null
  const id = (user as Record<string, unknown>).id
  return typeof id === 'string' && id !== '' ? id : null
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
 * Moves a finished session that the timer hasn't handed over yet into the session store under
 * `ownerId`, then clears it from the timer. For a different user signing in (#9): the previous
 * owner's session is kept, quarantined, instead of being dropped or given to the new account.
 */
export async function quarantinePendingRecord(
  active: ActiveSessionStore,
  sessions: SessionStore,
  ownerId: string,
): Promise<void> {
  const record = active.load()?.pendingRecord
  if (!record) return
  await sessions.save(record, ownerId)
  if (active.load()?.pendingRecord?.id === record.id) active.clear()
}
