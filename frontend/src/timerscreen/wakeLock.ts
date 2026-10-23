// "Keep screen awake" (AC9.2) with the Screen Wake Lock API, where the browser has it.

import { useEffect } from 'react'
import { useSettingsState, useSettingsStore } from '../settings/SettingsContext.ts'

export function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
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

/** The Settings value (AC12.3, off for a new user), and always off when the device can't do it. */
export function useKeepAwakeSetting(): [boolean, (value: boolean) => void] {
  const store = useSettingsStore()
  const { values } = useSettingsState()
  return [
    wakeLockSupported() && values.keep_screen_awake,
    (next) => store.update({ keep_screen_awake: next }),
  ]
}
