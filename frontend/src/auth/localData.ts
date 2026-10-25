import { AUDIO_SOURCE_KEY, YOUTUBE_LINK_KEY } from '../sounds/audioSource.ts'
import { SETTINGS_KEY } from '../settings/store.ts'
import { ACTIVE_OWNER_KEY } from '../sync/owner.ts'
import { finishedRecordOf, parkSession } from '../sync/parked.ts'
import { SAVE_TIMEOUT_MS, withTimeout } from '../sync/saveRecord.ts'
import { ACTIVE_SESSION_KEY, parseStoredTimer } from '../timer/store.ts'
import type { User } from './api.ts'

export const USER_KEY = 'ineedtofocus.user'
/** Id of the user whose data is on this device; survives an involuntary sign-out. */
export const OWNER_KEY = 'ineedtofocus.owner'

/** How long a different user's sign-in waits for each hook's `quarantine` (plus a margin). */
export const QUARANTINE_TIMEOUT_MS = SAVE_TIMEOUT_MS + 1_000

/**
 * Keys of earlier versions (device-local preferences, keep-awake, alert volume). Nothing reads
 * them any more and their values are not migrated; they are only removed, so an old per-user
 * value doesn't linger on the device after sign-out.
 */
const LEGACY_USER_DATA_KEYS = [
  'ineedtofocus.preferences',
  'ineedtofocus.keepAwake',
  'ineedtofocus.alertVolume',
]

/** Data that belongs to one user. Cleared on sign-out and when a different user signs in. */
const USER_DATA_KEYS = [
  SETTINGS_KEY,
  ACTIVE_SESSION_KEY,
  ACTIVE_OWNER_KEY,
  AUDIO_SOURCE_KEY,
  YOUTUBE_LINK_KEY,
  ...LEGACY_USER_DATA_KEYS,
]

/** What would be lost if this user's data were deleted from the device now. */
export interface UnsyncedCount {
  /** Finished sessions "not synced yet" or "Couldn't sync" (including one not stored yet). */
  sessions: number
  /** Changes to synced sessions (tag/goal) the server hasn't applied. */
  edits: number
}

/**
 * What other modules (the session store, #19) register so sign-out can handle the data they
 * own: count what hasn't synced, try to sync it, and clear it. Nothing is cleared unless it is
 * listed here or in `USER_DATA_KEYS`; sign-out never wipes "everything". IndexedDB is only
 * touched through these hooks.
 */
export interface LocalDataHook {
  /** The signed-in user's unsynced data. */
  countUnsynced(): Promise<UnsyncedCount>
  /** A last sync before sign-out; bounded in time, returns at once when offline. */
  trySync(): Promise<void>
  /** Deletes the signed-in user's data; called while the user is still on record. */
  clear(): Promise<void>
  /**
   * A different user is signing in: keep the previous owner's finished session that wasn't
   * handed over yet (`pendingRecord`), quarantined under their id, before it is removed here.
   */
  quarantine?(previousOwnerId: string): Promise<void>
}

const hooks = new Set<LocalDataHook>()

export function registerLocalDataHook(hook: LocalDataHook): () => void {
  hooks.add(hook)
  return () => hooks.delete(hook)
}

export function registeredLocalDataHooks(): LocalDataHook[] {
  return [...hooks]
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Nothing to remove if storage is blocked.
  }
}

export const ACTIVE_TIMER_MESSAGE = 'End your session before signing out.'

/** The confirmation's wording (ruling on #9, AC on #19). */
export function unsyncedWarning({ sessions, edits }: UnsyncedCount): string {
  const parts: string[] = []
  if (sessions > 0) {
    parts.push(
      sessions === 1
        ? "1 session hasn't synced and will be deleted from this device."
        : `${sessions} sessions haven't synced and will be deleted from this device.`,
    )
  }
  if (edits > 0) {
    parts.push(
      sessions > 0
        ? "Some changes to sessions haven't synced either."
        : "Some changes to sessions haven't synced and will be deleted from this device.",
    )
  }
  return parts.join(' ')
}

/** A running or paused session (not a finished one waiting to be handed over). */
export function hasActiveTimer(): boolean {
  const stored = parseStoredTimer(read(ACTIVE_SESSION_KEY))
  return stored !== null && stored.pendingRecord === null
}

/** A finished session still waiting for the session store, plus what registered hooks report. */
export async function countUnsynced(): Promise<UnsyncedCount> {
  const stored = parseStoredTimer(read(ACTIVE_SESSION_KEY))
  const total: UnsyncedCount = { sessions: stored?.pendingRecord ? 1 : 0, edits: 0 }
  for (const hook of hooks) {
    try {
      const { sessions, edits } = await hook.countUnsynced()
      total.sessions += sessions
      total.edits += edits
    } catch {
      // Unknown: count it as one unsynced session so the user is still asked.
      total.sessions += 1
    }
  }
  return total
}

export async function trySyncAll(): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook.trySync()
    } catch {
      // Still unsynced: it is counted and the user is asked.
    }
  }
}

/** The last signed-in user, kept so the app opens offline (F13). */
export function loadCachedUser(): User | null {
  try {
    const raw = read(USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

/**
 * The signed-in user's id, for the session store and sync (#19): the cached user, provided the
 * device's data is bound to them (`OWNER_KEY` unset or the same id). `null` otherwise.
 */
export function signedInUserId(): string | null {
  const user = loadCachedUser()
  if (!user || typeof user.id !== 'string' || user.id === '') return null
  const owner = read(OWNER_KEY)
  return owner === null || owner === user.id ? user.id : null
}

export function cacheUser(user: User): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  } catch {
    // Storage full or blocked: the app still works for this visit.
  }
}

export function forgetCachedUser(): void {
  remove(USER_KEY)
}

/**
 * Binds the device's local data to `user`. If it belonged to someone else, that user's finished
 * session not handed over yet is first moved into the session store under their id (quarantined,
 * #19); then their settings (with any edits not yet sent) and active session are removed, so
 * nothing of theirs is shown to or saved into this account.
 */
export async function claimLocalData(user: User): Promise<void> {
  const owner = read(OWNER_KEY)
  if (owner !== null && owner !== user.id) {
    for (const hook of hooks) {
      if (!hook.quarantine) continue
      try {
        // Bounded, so a stalled IndexedDB can't hold sign-in (or start-up) on "Loading…".
        await withTimeout(hook.quarantine(owner), QUARANTINE_TIMEOUT_MS)
      } catch {
        // Handled below: whatever finished session is still here gets parked, never deleted.
      }
    }
    // Safety net (F13): a finished session of the previous owner still in the timer's store is
    // parked under them in localStorage, outside the per-user keys, and moved into the session
    // store at the next start-up. If even that fails, the timer's copy is not removed.
    let keepActive = false
    const finished = finishedRecordOf(parseStoredTimer(read(ACTIVE_SESSION_KEY)), Date.now())
    if (finished !== null) {
      try {
        await parkSession(owner, finished)
      } catch {
        keepActive = true
      }
    }
    for (const key of USER_DATA_KEYS) {
      if (keepActive && (key === ACTIVE_SESSION_KEY || key === ACTIVE_OWNER_KEY)) continue
      remove(key)
    }
  }
  try {
    localStorage.setItem(OWNER_KEY, user.id)
  } catch {
    // Without storage there is nothing to bind.
  }
}

/**
 * Explicit sign-out: removes this user's app-owned data from the device, nothing else. Hooks run
 * first, while the user is still on record, since they clear only that user's data. A hook that
 * fails doesn't stop the rest, and nothing about the failure is logged (it could be personal).
 */
export async function clearLocalUserData(): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook.clear()
    } catch {
      // Keep going: the rest is still cleared and the user is still signed out.
    }
  }
  for (const key of [...USER_DATA_KEYS, USER_KEY, OWNER_KEY]) remove(key)
}

/** Fired when a data request (sync, #19) gets 401: AuthGate re-checks the sign-in. */
export const SESSION_EXPIRED_EVENT = 'ineedtofocus:session-expired'

export function notifySessionExpired(): void {
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
}

/**
 * Set when sign-out couldn't reach the server. It holds no personal data and is deliberately
 * not part of what `clearLocalUserData` removes: the server session still has to be ended.
 */
export const PENDING_LOGOUT_KEY = 'ineedtofocus.pendingLogout'

export function hasPendingLogout(): boolean {
  return read(PENDING_LOGOUT_KEY) !== null
}

export function setPendingLogout(): void {
  try {
    localStorage.setItem(PENDING_LOGOUT_KEY, '1')
  } catch {
    // Without storage the device simply stays signed out until the cookie expires.
  }
}

export function clearPendingLogout(): void {
  remove(PENDING_LOGOUT_KEY)
}
