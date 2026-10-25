// Takes a new version over when the app is idle (#244). No banner: the user never sees it.
//
// Two decisions, both made only while idle:
//  1. Activate the waiting worker (`skipWaiting`). Every tab then gets a `controlling` event, and
//     vite-plugin-pwa would reload each one at once, so we pass `onNeedReload` and reload a tab
//     only when that tab is itself idle.
//  2. Reload this tab into the new version.
// "Idle" is checked again right before acting, after the flush.

import { ACTIVE_SESSION_KEY, parseStoredTimer } from '../timer/store.ts'

export const UPDATE_CHECK_MS = 60 * 60 * 1000
/** While an update is waiting, how often idleness is looked at again (a dialog closed, a tab ended). */
export const UPDATE_RECHECK_MS = 5_000
/** The most the flush may hold up a reload; what it didn't send is on the device anyway. */
export const UPDATE_FLUSH_TIMEOUT_MS = 10_000
/** Another reload within this time of one is refused: no reload loop. */
export const RELOAD_GUARD_MS = 60_000
export const RELOAD_GUARD_KEY = 'ineedtofocus.updateReloadedAt'

export interface RegisterCallbacks {
  onNeedRefresh: () => void
  onNeedReload: () => void
  onRegisteredSW: (url: string, registration: ServiceWorkerRegistration | undefined) => void
}

export interface AutoUpdaterOptions {
  /** Registers the worker (`registerSW` of `virtual:pwa-register`); returns the activate function. */
  register: (callbacks: RegisterCallbacks) => (reloadPage?: boolean) => Promise<void>
  /** The timer, a summary or the start-up restore is on screen in this tab. */
  isViewBusy: () => boolean
  onViewChange: (listener: () => void) => () => void
  /** Sends settings edits and the sync queue; bounded by this class. */
  flush: () => Promise<void>
  reload?: () => void
  now?: () => number
  guard?: Pick<Storage, 'getItem' | 'setItem'>
  checkMs?: number
  recheckMs?: number
  flushTimeoutMs?: number
}

/** A form or dialog with something the user may lose, found in the page. */
export function hasOpenEdit(doc: Document = document): boolean {
  const active = doc.activeElement
  if (active instanceof HTMLElement) {
    const tag = active.tagName
    const textEntry =
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (tag === 'INPUT' &&
        !['button', 'checkbox', 'radio', 'submit', 'range', 'reset'].includes(
          (active as HTMLInputElement).type,
        )) ||
      active.isContentEditable
    if (textEntry) return true
  }
  // Open Discard/Delete dialogs, a History edit form, a goal field with text in it.
  return doc.querySelector('[role="alertdialog"], [role="dialog"], [data-holds-update]') !== null
}

/** Any stored session, running, paused or finished but not handed over: in some tab. */
export function hasStoredSession(): boolean {
  try {
    return parseStoredTimer(localStorage.getItem(ACTIVE_SESSION_KEY)) !== null
  } catch {
    return false
  }
}

export class AutoUpdater {
  readonly #o: AutoUpdaterOptions
  #activate: ((reloadPage?: boolean) => Promise<void>) | null = null
  #registration: ServiceWorkerRegistration | undefined
  #waiting = false
  #reloadPending = false
  #working = false
  #timers: ReturnType<typeof setInterval>[] = []
  #stops: (() => void)[] = []

  constructor(options: AutoUpdaterOptions) {
    this.#o = options
  }

  start(): () => void {
    this.#activate = this.#o.register({
      onNeedRefresh: () => {
        this.#waiting = true
        void this.#attempt()
      },
      onNeedReload: () => {
        this.#reloadPending = true
        void this.#attempt()
      },
      onRegisteredSW: (_url, registration) => {
        this.#registration = registration
      },
    })
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      this.checkForUpdate()
      void this.#attempt()
    }
    const poke = () => void this.#attempt()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('storage', poke) // another tab ended its session
    document.addEventListener('focusout', poke)
    this.#stops.push(
      () => document.removeEventListener('visibilitychange', onVisible),
      () => window.removeEventListener('storage', poke),
      () => document.removeEventListener('focusout', poke),
      this.#o.onViewChange(poke),
    )
    this.#timers.push(
      setInterval(() => this.checkForUpdate(), this.#o.checkMs ?? UPDATE_CHECK_MS),
      setInterval(() => {
        if (this.#waiting || this.#reloadPending) void this.#attempt()
      }, this.#o.recheckMs ?? UPDATE_RECHECK_MS),
    )
    return () => {
      for (const timer of this.#timers) clearInterval(timer)
      for (const stop of this.#stops) stop()
      this.#timers = []
      this.#stops = []
    }
  }

  /** Asks the server for a newer worker; it arrives as `onNeedRefresh`. Offline, it fails quietly. */
  checkForUpdate(): void {
    void this.#registration?.update().catch(() => undefined)
  }

  /** This tab shows nothing that a reload would cost. */
  #localIdle(): boolean {
    return !this.#o.isViewBusy() && !hasOpenEdit()
  }

  #guarded(): boolean {
    const at = Number(this.#o.guard?.getItem(RELOAD_GUARD_KEY) ?? '0')
    const now = (this.#o.now ?? Date.now)()
    return Number.isFinite(at) && now - at < RELOAD_GUARD_MS
  }

  async #flush(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#o.flushTimeoutMs ?? UPDATE_FLUSH_TIMEOUT_MS)
    })
    try {
      await Promise.race([this.#o.flush().catch(() => undefined), bound])
    } finally {
      clearTimeout(timer)
    }
  }

  async #attempt(): Promise<void> {
    if (this.#working || !(this.#waiting || this.#reloadPending)) return
    if (!this.#localIdle()) return
    if (this.#waiting && hasStoredSession()) return // a session in this or another tab
    if (this.#guarded()) return
    this.#working = true
    try {
      // The flush takes time; the user may have started something meanwhile.
      await this.#flush()
      if (!this.#localIdle()) return
      if (this.#waiting && hasStoredSession()) return
      if (this.#reloadPending) {
        this.#reloadPending = false
        this.#waiting = false
        this.#o.guard?.setItem(RELOAD_GUARD_KEY, String((this.#o.now ?? Date.now)()))
        ;(this.#o.reload ?? (() => window.location.reload()))()
      } else {
        // The worker takes over; `controlling` then arrives as onNeedReload and reloads this tab.
        this.#waiting = false
        await this.#activate?.(true)
      }
    } finally {
      this.#working = false
    }
  }
}
