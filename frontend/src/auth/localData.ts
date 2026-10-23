import { ALERT_VOLUME_KEY } from '../sounds/alerts.ts'
import { PREFERENCES_KEY } from '../setup/preferences.ts'
import { KEEP_AWAKE_KEY } from '../timerscreen/wakeLock.ts'
import { ACTIVE_SESSION_KEY, parseStoredTimer } from '../timer/store.ts'
import type { User } from './api.ts'

export const USER_KEY = 'ineedtofocus.user'
/** Id of the user whose data is on this device; survives an involuntary sign-out. */
export const OWNER_KEY = 'ineedtofocus.owner'

/** Data that belongs to one user. Cleared on sign-out and when a different user signs in. */
const USER_DATA_KEYS = [PREFERENCES_KEY, KEEP_AWAKE_KEY, ACTIVE_SESSION_KEY, ALERT_VOLUME_KEY]

/**
 * What other modules (the session store, #19) register so sign-out can handle the data they
 * own: count what hasn't synced, try to sync it, and clear it. Nothing is cleared unless it is
 * listed here or in `USER_DATA_KEYS`; sign-out never wipes "everything".
 */
export interface LocalDataHook {
  countUnsynced(): Promise<number>
  trySync(): Promise<void>
  clear(): Promise<void>
}

const hooks = new Set<LocalDataHook>()

export function registerLocalDataHook(hook: LocalDataHook): () => void {
  hooks.add(hook)
  return () => hooks.delete(hook)
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

/** A running or paused session (not a finished one waiting to be handed over). */
export function hasActiveTimer(): boolean {
  const stored = parseStoredTimer(read(ACTIVE_SESSION_KEY))
  return stored !== null && stored.pendingRecord === null
}

/** Finished sessions still waiting for the session store, plus whatever registered hooks report. */
export async function countUnsynced(): Promise<number> {
  const stored = parseStoredTimer(read(ACTIVE_SESSION_KEY))
  let count = stored?.pendingRecord ? 1 : 0
  for (const hook of hooks) count += await hook.countUnsynced()
  return count
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
 * Binds the device's local data to `user`. If it belonged to someone else, that user's
 * preferences, keep-awake setting and active session (with any unsaved finished session) are
 * removed first, so they are never shown to or saved into this account.
 */
export function claimLocalData(user: User): void {
  const owner = read(OWNER_KEY)
  if (owner !== null && owner !== user.id) {
    for (const key of USER_DATA_KEYS) remove(key)
  }
  try {
    localStorage.setItem(OWNER_KEY, user.id)
  } catch {
    // Without storage there is nothing to bind.
  }
}

/** Explicit sign-out: removes this user's app-owned data from the device, nothing else. */
export async function clearLocalUserData(): Promise<void> {
  for (const key of [...USER_DATA_KEYS, USER_KEY, OWNER_KEY]) remove(key)
  for (const hook of hooks) await hook.clear()
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
