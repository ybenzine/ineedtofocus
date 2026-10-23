// "Keep screen awake" (AC9.2) with the Screen Wake Lock API, where the browser has it.

import { useEffect, useState } from 'react'

export const KEEP_AWAKE_KEY = 'ineedtofocus.keepAwake'

export function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

/** Off for a new user (decision log, #6); remembered on the device until Settings (#22) takes over. */
export function loadKeepAwake(storage: Storage = window.localStorage): boolean {
  return storage.getItem(KEEP_AWAKE_KEY) === 'true'
}

export function saveKeepAwake(value: boolean, storage: Storage = window.localStorage): void {
  storage.setItem(KEEP_AWAKE_KEY, String(value))
}

/**
 * Holds a screen wake lock while `enabled`. Browsers drop the lock when the tab is hidden, so it
 * is requested again when the tab comes back. Failures (low battery, denied) are ignored: the
 * session itself doesn't depend on it.
 */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !wakeLockSupported()) return
    let sentinel: WakeLockSentinel | null = null
    let cancelled = false

    async function acquire() {
      if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return
      try {
        const lock = await navigator.wakeLock.request('screen')
        if (cancelled) {
          void lock.release()
        } else {
          sentinel = lock
        }
      } catch {
        // Not available right now; the toggle stays on and we retry on the next visibility change.
      }
    }

    void acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', acquire)
      void sentinel?.release().catch(() => undefined)
    }
  }, [enabled])
}

/** Tracks the toggle: persisted, and always off when the device can't do it. */
export function useKeepAwakeSetting(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => wakeLockSupported() && loadKeepAwake())
  return [
    value,
    (next) => {
      setValue(next)
      saveKeepAwake(next)
    },
  ]
}
