import type { User } from './api.ts'

const USER_KEY = 'intf.user'

/** The last signed-in user, kept so the app opens offline (F13). */
export function loadCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
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
  try {
    localStorage.removeItem(USER_KEY)
  } catch {
    // Nothing to forget if storage is blocked.
  }
}

/** Removes everything this app stored on the device: preferences, active session, cached user, IndexedDB. */
export async function clearLocalUserData(): Promise<void> {
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    // Nothing to clear if storage is blocked.
  }
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return
  const databases = await indexedDB.databases()
  await Promise.all(
    databases.map(
      ({ name }) =>
        new Promise<void>((resolve) => {
          if (!name) return resolve()
          const request = indexedDB.deleteDatabase(name)
          request.onsuccess = request.onerror = request.onblocked = () => resolve()
        }),
    ),
  )
}
