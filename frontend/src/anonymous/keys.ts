// Everything an anonymous visitor (no account, #331) keeps on the device lives in localStorage
// keys under one prefix. None of it goes in the per-user keys of `auth/localData.ts`, in
// IndexedDB or in the sync queue, so it can never be mistaken for an account's data.

export const ANONYMOUS_PREFIX = 'ineedtofocus.anonymous.'

/** The running or paused anonymous session (the timer's own store, a second slot). */
export const ANON_ACTIVE_SESSION_KEY = `${ANONYMOUS_PREFIX}activeSession`
export const ANON_SETTINGS_KEY = `${ANONYMOUS_PREFIX}settings`
export const ANON_AUDIO_SOURCE_KEY = `${ANONYMOUS_PREFIX}audioSource`
export const ANON_YOUTUBE_LINK_KEY = `${ANONYMOUS_PREFIX}youtubeLink`
/** Id of the finished session a page holds in memory; the marker other tabs and pages check. */
export const ANON_HELD_ID_KEY = `${ANONYMOUS_PREFIX}heldId`

/** Held while a finished session is moved out of the anonymous slot (check-and-remove by id). */
export const ANON_HELD_LOCK = 'ineedtofocus-anonymous-held'
export const ANON_SETTINGS_LOCK = 'ineedtofocus-anonymous-settings'

/**
 * Removes every anonymous key: settings, a running, paused or finished session, its audio source
 * and YouTube link, and the held-session marker. Done at every sign-in and sign-up.
 */
export function clearAnonymousData(storage: Storage = window.localStorage): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key !== null && key.startsWith(ANONYMOUS_PREFIX)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    // Storage blocked: there is nothing stored to clear.
  }
}
