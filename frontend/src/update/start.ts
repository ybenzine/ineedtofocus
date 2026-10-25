import { registerSW } from 'virtual:pwa-register'
import { runUpdateFlushes, isViewBusy, onViewChange } from './idle.ts'
import { AutoUpdater } from './autoUpdate.ts'

/** Registers the service worker and lets a new version take over when the app is idle (#244). */
export function startAutoUpdate(): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined
  return new AutoUpdater({
    register: (callbacks) => registerSW(callbacks),
    isViewBusy,
    onViewChange,
    flush: runUpdateFlushes,
    guard: window.sessionStorage,
  }).start()
}
