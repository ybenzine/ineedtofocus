import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_SESSION_KEY } from '../timer/store.ts'
import {
  AutoUpdater,
  RELOAD_GUARD_KEY,
  RELOAD_GUARD_MS,
  type AutoUpdaterOptions,
  type RegisterCallbacks,
} from './autoUpdate.ts'
import { isViewBusy, onViewChange, registerMemoryHolder, setViewBusy } from './idle.ts'

// A running session as the timer stores it; only its shape matters here.
const RUNNING = JSON.stringify({
  session: {
    version: 1,
    id: 'abc',
    tag: 'work',
    goal: null,
    startedAt: 1,
    observedActiveMs: 0,
    config: { mode: 'unlimited', reminderMinutes: null },
    pauses: [],
    skips: [],
  },
  pendingRecord: null,
})

interface Harness {
  activate: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  stop: () => void
  registration: { active: { state: string } | null }
  /** The waiting worker is found. */
  waiting: () => Promise<void>
  /** The new worker took control (what `activate` ends in). */
  controlling: () => Promise<void>
}

function setup(over: Partial<AutoUpdaterOptions> = {}): Harness {
  let cbs: RegisterCallbacks | undefined
  const activate = vi.fn(() => Promise.resolve())
  const reload = vi.fn()
  const flush = vi.fn(() => Promise.resolve())
  const update = vi.fn(() => Promise.resolve())
  const registration = { update, active: null, waiting: null, installing: null }
  const updater = new AutoUpdater({
    register: (callbacks) => {
      cbs = callbacks
      return activate
    },
    isViewBusy,
    onViewChange,
    isControlled: () => true,
    flush,
    reload,
    guard: window.sessionStorage,
    ...over,
  })
  const stop = updater.start()
  cbs?.onRegisteredSW('/sw.js', registration as unknown as ServiceWorkerRegistration)
  return {
    activate,
    reload,
    flush,
    update,
    stop,
    registration,
    waiting: async () => {
      cbs?.onNeedRefresh()
      await vi.advanceTimersByTimeAsync(0)
    },
    controlling: async () => {
      cbs?.onNeedReload()
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

function element(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
  document.body.append(el)
  return el
}

let h: Harness | undefined
beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  sessionStorage.clear()
  setViewBusy(false)
})
afterEach(() => {
  h?.stop()
  setViewBusy(true)
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('auto update when idle', () => {
  it('idle: flushes, activates once and reloads once', async () => {
    const t = (h = setup())
    await t.waiting()
    expect(t.flush).toHaveBeenCalledTimes(1)
    expect(t.activate).toHaveBeenCalledTimes(1)
    expect(t.reload).not.toHaveBeenCalled()
    await t.controlling()
    expect(t.reload).toHaveBeenCalledTimes(1)
    // Further polling does nothing more.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.activate).toHaveBeenCalledTimes(1)
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it('a running timer waits; it activates after the session ends and the summary is left', async () => {
    setViewBusy(true) // timer screen
    localStorage.setItem(ACTIVE_SESSION_KEY, RUNNING)
    const t = (h = setup())
    await t.waiting()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(t.activate).not.toHaveBeenCalled()

    // The session ends: the summary is on screen, the record handed over, the stored copy gone.
    localStorage.removeItem(ACTIVE_SESSION_KEY)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(t.activate).not.toHaveBeenCalled()

    // The summary is left: setup shows.
    setViewBusy(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(t.activate).toHaveBeenCalledTimes(1)
    await t.controlling()
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it("another tab's session blocks it until that session is gone", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, RUNNING) // this tab is on setup
    const t = (h = setup())
    await t.waiting()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.activate).not.toHaveBeenCalled()
    localStorage.removeItem(ACTIVE_SESSION_KEY)
    window.dispatchEvent(new StorageEvent('storage', { key: ACTIVE_SESSION_KEY }))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.activate).toHaveBeenCalledTimes(1)
  })

  it('a finished session not handed over yet (pendingRecord) blocks it too', async () => {
    const stored = JSON.parse(RUNNING) as { pendingRecord: unknown }
    stored.pendingRecord = { id: 'abc' }
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(stored))
    const t = (h = setup())
    await t.waiting()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.activate).not.toHaveBeenCalled()
  })

  it('a record held only in memory blocks the reload, even back on setup, until it is handed over (#286)', async () => {
    // Both writes failed: nothing in localStorage, the finished record lives in the tab.
    let held = true
    const unregister = registerMemoryHolder(() => held)
    try {
      const t = (h = setup())
      await t.waiting()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(t.activate).not.toHaveBeenCalled()
      expect(t.reload).not.toHaveBeenCalled()

      held = false // handed over
      await vi.advanceTimersByTimeAsync(10_000)
      expect(t.activate).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })

  it('a busy tab does not reload when another tab activated the worker', async () => {
    setViewBusy(true)
    const t = (h = setup())
    await t.controlling()
    expect(t.reload).not.toHaveBeenCalled()
    setViewBusy(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a text field focused', () => (element('input', { type: 'text' }).focus(), 'input')],
    ['a goal typed in', () => element('input', { 'data-holds-update': '' })],
    ['a History edit form open', () => element('form', { 'data-holds-update': '' })],
    ['a Discard or Delete dialog open', () => element('div', { role: 'alertdialog' })],
  ] as [string, () => HTMLElement | string][])('mid-edit blocks it: %s', async (_name, open) => {
    open()
    const t = (h = setup())
    await t.waiting()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.activate).not.toHaveBeenCalled()
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.body.innerHTML = ''
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.activate).toHaveBeenCalledTimes(1)
  })

  it('does not act if the user started something while the flush ran', async () => {
    let release = () => {}
    const t = (h = setup({
      flush: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    }))
    await t.waiting()
    setViewBusy(true)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(t.activate).not.toHaveBeenCalled()
  })

  it('a flush that hangs holds the update for a bounded time only', async () => {
    const t = (h = setup({
      flush: () => new Promise<void>(() => undefined),
      flushTimeoutMs: 10_000,
    }))
    await t.waiting()
    expect(t.activate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.activate).toHaveBeenCalledTimes(1)
  })

  it('a failing flush does not stop the update', async () => {
    const t = (h = setup({ flush: () => Promise.reject(new Error('offline')) }))
    await t.waiting()
    expect(t.activate).toHaveBeenCalledTimes(1)
  })

  it('a busy tab reloads on its own once idle, even if another tab has a session by then', async () => {
    setViewBusy(true)
    const t = (h = setup())
    await t.waiting()
    await t.controlling()
    localStorage.setItem(ACTIVE_SESSION_KEY, RUNNING) // another tab started one after the switch
    setViewBusy(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  describe('a page no worker controls (first visit, hard reload)', () => {
    it('reloads once when the new worker is active and the tab is idle', async () => {
      const t = (h = setup({ isControlled: () => false }))
      await t.waiting()
      // Still installing: nothing to reload into yet.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(t.reload).not.toHaveBeenCalled()
      expect(t.activate).not.toHaveBeenCalled()
      t.registration.active = { state: 'activated' }
      await vi.advanceTimersByTimeAsync(5_000)
      expect(t.reload).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(t.reload).toHaveBeenCalledTimes(1)
    })

    it('waits for an idle tab, and keeps the loop guard', async () => {
      setViewBusy(true)
      let t = (h = setup({ isControlled: () => false }))
      t.registration.active = { state: 'activated' }
      await t.waiting()
      expect(t.reload).not.toHaveBeenCalled()
      setViewBusy(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(t.reload).toHaveBeenCalledTimes(1)
      t.stop()
      t = h = setup({ isControlled: () => false })
      t.registration.active = { state: 'activated' }
      await t.waiting()
      expect(t.reload).not.toHaveBeenCalled()
    })
  })

  it('no reload loop: a second reload within a minute is refused', async () => {
    let t = (h = setup())
    await t.waiting()
    await t.controlling()
    expect(t.reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(RELOAD_GUARD_KEY)).not.toBeNull()
    t.stop()
    // The reloaded page (new updater, same sessionStorage) finds another waiting worker at once.
    t = h = setup()
    await t.waiting()
    expect(t.activate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RELOAD_GUARD_MS)
    expect(t.activate).toHaveBeenCalledTimes(1)
  })

  it('checks for an update when the page becomes visible and every hour', async () => {
    const t = (h = setup())
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(t.update).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(t.update).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(t.update).toHaveBeenCalledTimes(2)
  })
})
