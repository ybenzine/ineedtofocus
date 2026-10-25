import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_POMODORO, MINUTE_MS, type TimerConfig } from './config.ts'
import { ActiveSessionExistsError, NoActiveSessionError, TimerController } from './controller.ts'
import { InvalidConfigError, TOO_SHORT_MESSAGE, type SessionRecord } from './engine.ts'
import {
  ACTIVE_SESSION_KEY,
  LocalActiveSessionStore,
  MemoryActiveSessionStore,
  parseStoredTimer,
  type ActiveSessionStore,
} from './store.ts'

// Fake clock: Vitest's fake timers own Date.now(); nothing here waits for real time.
const T0 = Date.UTC(2026, 9, 23, 9, 0, 0)
const SECOND = 1000
const HOUR = 60 * MINUTE_MS

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

const wait = (ms: number) => vi.advanceTimersByTime(ms)
const iso = (ms: number) => new Date(ms).toISOString()

let ids = 0

function setup(store: ActiveSessionStore = new MemoryActiveSessionStore()) {
  const saved: SessionRecord[] = []
  const make = (
    saveRecord: (record: SessionRecord) => void | Promise<void> = (r) => {
      saved.push(r)
    },
  ) => new TimerController({ store, saveRecord, newId: () => `id-${++ids}` })
  return { store, saved, controller: make(), make }
}

const countdown = (minutes: number): TimerConfig => ({ mode: 'countdown', minutes })
const startOptions = (config: TimerConfig) => ({ config, tag: 'study' as const, goal: null })

describe('one active session (AC6.1)', () => {
  it('ac6_1 refuses to start a second session while one is active', async () => {
    const { controller } = setup()
    await controller.start(startOptions(countdown(25)))
    await expect(controller.start(startOptions(countdown(10)))).rejects.toThrow(
      ActiveSessionExistsError,
    )
  })

  it('ac6_1 refuses a session stored by another tab or before a reload', async () => {
    const { controller, make } = setup()
    await controller.start(startOptions(countdown(25)))
    await expect(make().start(startOptions(countdown(10)))).rejects.toThrow(
      ActiveSessionExistsError,
    )
  })

  it('ac6_1 allows a new session once the previous one has finished', async () => {
    const { controller } = setup()
    await controller.start(startOptions(countdown(25)))
    wait(2 * MINUTE_MS)
    await controller.stop()
    const next = await controller.start(startOptions(countdown(10)))
    expect(next.snapshot?.id).toBe(`id-${ids}`)
  })

  it('does not start or store an invalid configuration', async () => {
    const { controller, store } = setup()
    await expect(controller.start(startOptions(countdown(0)))).rejects.toThrow(InvalidConfigError)
    expect(store.load()).toBeNull()
    expect(controller.current()).toBeNull()
  })

  it('needs an active session to pause or stop', async () => {
    const { controller } = setup()
    await expect(controller.pause()).rejects.toThrow(NoActiveSessionError)
    await expect(controller.stop()).rejects.toThrow(NoActiveSessionError)
    expect(await controller.tick()).toMatchObject({ snapshot: null, events: [], outcome: null })
  })
})

describe('short sessions (AC6.2)', () => {
  it('ac6_2 discards under 1 minute of focus, tells the user why and saves nothing', async () => {
    const { controller, store, saved } = setup()
    await controller.start(startOptions({ mode: 'unlimited', reminderMinutes: null }))
    wait(45 * SECOND)
    const update = await controller.stop()
    expect(update.outcome).toEqual({
      kind: 'discarded',
      reason: 'too_short',
      focusSeconds: 45,
      message: TOO_SHORT_MESSAGE,
    })
    expect(saved).toEqual([])
    expect(store.load()).toBeNull()
  })
})

describe('finishing hands the session over (AC2.3, AC2.5, AC4.4)', () => {
  it('saves the countdown as Completed when it reaches 00:00 during a tick', async () => {
    const { controller, store, saved } = setup()
    await controller.start(startOptions(countdown(20)))
    wait(19 * MINUTE_MS)
    expect((await controller.tick()).outcome).toBeNull()
    wait(MINUTE_MS + 400)
    const update = await controller.tick()
    expect(update.events).toMatchObject([{ type: 'session-end', at: T0 + 20 * MINUTE_MS }])
    expect(update.snapshot).toBeNull()
    expect(update.outcome).toMatchObject({ kind: 'saved', record: { status: 'completed' } })
    expect(saved).toHaveLength(1)
    expect(saved[0].endedAt).toBe(iso(T0 + 20 * MINUTE_MS))
    expect(store.load()).toBeNull()
  })

  it('keeps the record on the device until saveRecord has it', async () => {
    const store = new MemoryActiveSessionStore()
    let seenInStore: unknown = undefined
    const controller = new TimerController({
      store,
      saveRecord: (record) => {
        seenInStore = store.load()?.pendingRecord?.id === record.id
      },
    })
    await controller.start(startOptions(countdown(20)))
    wait(5 * MINUTE_MS)
    await controller.stop()
    expect(seenInStore).toBe(true)
    expect(store.load()).toBeNull()
  })

  it('never loses a session when saving fails; it is handed over again later', async () => {
    const { store, saved, make } = setup()
    let fail = true
    const controller = make((record) => {
      if (fail) return Promise.reject(new Error('disk full'))
      saved.push(record)
    })
    await controller.start(startOptions(countdown(20)))
    wait(5 * MINUTE_MS)
    const update = await controller.stop()
    expect(update.recordPending).toBe(true)
    expect(store.load()?.pendingRecord?.status).toBe('ended_early')
    // A new session can't overwrite it while it is still unsaved.
    await expect(controller.start(startOptions(countdown(5)))).rejects.toThrow('still being saved')
    expect(await controller.retryPending()).toBe(false)

    fail = false
    const restored = await make((r) => {
      saved.push(r)
    }).restore()
    expect(restored.outcome).toMatchObject({ kind: 'saved', record: { focusSeconds: 300 } })
    expect(restored.recordPending).toBe(false)
    expect(saved).toHaveLength(1)
    expect(store.load()).toBeNull()
  })

  it('a pending record is handed over before the next session starts', async () => {
    const { store, saved, make } = setup()
    let fail = true
    const saveRecord = (record: SessionRecord) => {
      if (fail) throw new Error('offline')
      saved.push(record)
    }
    const controller = make(saveRecord)
    await controller.start(startOptions(countdown(20)))
    wait(5 * MINUTE_MS)
    await controller.stop()
    fail = false
    await controller.start(startOptions(countdown(10)))
    expect(saved.map((r) => r.status)).toEqual(['ended_early'])
    expect(store.load()?.pendingRecord).toBeNull()
  })
})

describe('events from the controller (AC3.3, AC3.5, AC4.2)', () => {
  it('reports each phase change once and skips breaks', async () => {
    const { controller, saved } = setup()
    await controller.start(
      startOptions({ ...DEFAULT_POMODORO, blocks: 2, focusMinutes: 10, breakMinutes: 5 }),
    )
    wait(10 * MINUTE_MS)
    expect((await controller.tick()).events).toMatchObject([{ type: 'phase-change', to: 'break' }])
    expect((await controller.tick()).events).toEqual([])
    wait(MINUTE_MS)
    const skipped = await controller.skipBreak()
    expect(skipped.events).toMatchObject([{ type: 'phase-change', to: 'focus', skipped: true }])
    expect(skipped.snapshot?.pomodoro).toMatchObject({ phase: 'focus', block: 2 })
    wait(10 * MINUTE_MS)
    const end = await controller.tick()
    expect(end.events).toMatchObject([{ type: 'session-end' }])
    expect(saved[0]).toMatchObject({
      status: 'completed',
      focusSeconds: 20 * 60,
      blocksCompleted: 2,
      endedAt: iso(T0 + 21 * MINUTE_MS),
    })
  })

  it('reports unlimited reminders based on focus time', async () => {
    const { controller } = setup()
    await controller.start(startOptions({ mode: 'unlimited', reminderMinutes: 15 }))
    wait(10 * MINUTE_MS)
    await controller.pause()
    wait(HOUR)
    expect((await controller.tick()).events).toEqual([])
    await controller.resume()
    wait(5 * MINUTE_MS)
    expect((await controller.tick()).events).toMatchObject([{ type: 'reminder', count: 1 }])
  })

  it('a pause that comes after the end finishes the session at its end instead', async () => {
    const { controller, saved } = setup()
    await controller.start(startOptions(countdown(5)))
    wait(6 * MINUTE_MS) // no tick in between, e.g. the tab was in the background
    const update = await controller.pause()
    expect(update.outcome?.kind).toBe('saved')
    expect(saved[0]).toMatchObject({ status: 'completed', endedAt: iso(T0 + 5 * MINUTE_MS) })
  })
})

describe('surviving reloads (AC6.4, AC6.5)', () => {
  it('ac6_4 restores the active session with the correct time after a reload', async () => {
    const { controller, make } = setup()
    const started = await controller.start(startOptions(countdown(50)))
    wait(10 * MINUTE_MS)
    await controller.pause()
    wait(3 * MINUTE_MS)
    await controller.resume()
    wait(7 * MINUTE_MS)

    const reopened = make()
    const update = await reopened.restore()
    expect(update.outcome).toBeNull()
    expect(update.snapshot).toMatchObject({
      id: started.snapshot?.id,
      tag: 'study',
      paused: false,
      focusMs: 17 * MINUTE_MS,
      pausedMs: 3 * MINUTE_MS,
      remainingMs: 33 * MINUTE_MS,
    })
    expect(reopened.current()?.remainingMs).toBe(33 * MINUTE_MS)
  })

  it('ac6_4 a paused session is still paused after reopening, with no focus time added', async () => {
    const { controller, make } = setup()
    await controller.start(startOptions(countdown(25)))
    wait(5 * MINUTE_MS)
    await controller.pause()
    wait(3 * HOUR)
    const update = await make().restore()
    expect(update.snapshot).toMatchObject({ paused: true, remainingMs: 20 * MINUTE_MS })
  })

  it('ac6_5 a countdown that ended while closed is Completed at its scheduled end', async () => {
    const { controller, saved, make } = setup()
    await controller.start(startOptions(countdown(25)))
    wait(5 * MINUTE_MS)
    await controller.pause()
    wait(2 * MINUTE_MS)
    await controller.resume()
    wait(4 * HOUR) // app closed
    const update = await make().restore()
    expect(update.snapshot).toBeNull()
    expect(update.events).toEqual([]) // bells missed while closed aren't replayed
    expect(update.outcome).toMatchObject({ kind: 'saved' })
    expect(saved).toEqual([
      expect.objectContaining({
        status: 'completed',
        startedAt: iso(T0),
        endedAt: iso(T0 + 27 * MINUTE_MS),
        focusSeconds: 25 * 60,
        pausedSeconds: 2 * 60,
      }),
    ])
  })

  it('ac6_5 a Pomodoro that ended while closed is Completed at its scheduled end', async () => {
    const { controller, saved, make } = setup()
    await controller.start(startOptions(DEFAULT_POMODORO))
    wait(30 * SECOND)
    await controller.tick()
    wait(24 * HOUR)
    await make().restore()
    expect(saved).toEqual([
      expect.objectContaining({
        mode: 'pomodoro',
        status: 'completed',
        endedAt: iso(T0 + (4 * 25 + 3 * 5) * MINUTE_MS),
        focusSeconds: 100 * 60,
        blocksCompleted: 4,
      }),
    ])
  })

  it('ac4_5 an unlimited timer that passed 12 h while closed is Completed at the 12 h mark', async () => {
    const { controller, saved, make } = setup()
    await controller.start(startOptions({ mode: 'unlimited', reminderMinutes: 60 }))
    wait(30 * HOUR) // app closed
    const update = await make().restore()
    expect(update.snapshot).toBeNull()
    expect(update.outcome).toMatchObject({ kind: 'saved' })
    expect(saved).toEqual([
      expect.objectContaining({
        mode: 'unlimited',
        status: 'completed',
        endedAt: iso(T0 + 12 * HOUR),
        focusSeconds: 12 * 3600,
      }),
    ])
  })

  it('a Pomodoro still running after reopening shows the right phase', async () => {
    const { controller, make } = setup()
    await controller.start(startOptions(DEFAULT_POMODORO))
    wait(62 * MINUTE_MS)
    const update = await make().restore()
    expect(update.snapshot?.pomodoro).toMatchObject({
      phase: 'focus',
      block: 3,
      blocksCompleted: 2,
      phaseRemainingMs: 23 * MINUTE_MS,
    })
  })

  it('restoring with nothing stored is a no-op', async () => {
    expect(await setup().controller.restore()).toMatchObject({ snapshot: null, outcome: null })
  })
})

describe('two tabs on one session', () => {
  it('a pause in one tab is not overwritten by the other tab', async () => {
    const { controller: tabA, make, store } = setup()
    await tabA.start(startOptions(countdown(25)))
    const tabB = make()
    await tabB.restore()
    wait(MINUTE_MS)
    await tabA.pause()
    wait(SECOND)
    const update = await tabB.tick() // would have saved its stale, unpaused copy
    expect(update.snapshot?.paused).toBe(true)
    expect(store.load()?.session.pauses).toHaveLength(1)
    expect(tabB.current()?.paused).toBe(true)
  })

  it('a stop in one tab ends the session in the other without saving twice', async () => {
    const { controller: tabA, make, saved } = setup()
    await tabA.start(startOptions(countdown(25)))
    const tabB = make()
    await tabB.restore()
    wait(5 * MINUTE_MS)
    await tabA.stop()
    const update = await tabB.tick()
    expect(update).toMatchObject({ snapshot: null, outcome: null })
    expect(tabB.current()).toBeNull()
    expect(saved).toHaveLength(1)
    await expect(tabB.pause()).rejects.toThrow(NoActiveSessionError)
  })

  it('actions in the second tab build on the first tab’s changes', async () => {
    const { controller: tabA, make } = setup()
    await tabA.start(startOptions(countdown(25)))
    const tabB = make()
    await tabB.restore()
    wait(MINUTE_MS)
    await tabA.pause()
    wait(MINUTE_MS)
    const resumed = await tabB.resume()
    expect(resumed.snapshot).toMatchObject({ paused: false, pausedMs: MINUTE_MS })
  })
})

describe('quiet ticks and starting across tabs', () => {
  it('a tick with nothing to report does not write to the store', async () => {
    const { controller, store } = setup()
    await controller.start(startOptions(countdown(25)))
    const save = vi.spyOn(store, 'save')
    wait(SECOND)
    await controller.tick()
    expect(save).not.toHaveBeenCalled()
  })

  it('a reminder is still stored once reported, so another tab does not repeat it', async () => {
    const { controller, make } = setup()
    await controller.start(startOptions({ mode: 'unlimited', reminderMinutes: 15 }))
    const other = make()
    await other.restore()
    wait(16 * MINUTE_MS)
    expect((await controller.tick()).events).toHaveLength(1)
    expect((await other.tick()).events).toHaveLength(0)
  })

  it('start does not overwrite a session another tab started while handing over a record', async () => {
    const store = new MemoryActiveSessionStore()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow = new TimerController({ store, saveRecord: () => gate, newId: () => 'slow' })
    await slow.start(startOptions(countdown(25)))
    wait(5 * MINUTE_MS)
    // The session finishes, but its record can't be saved yet.
    const stopping = slow.stop()
    await Promise.resolve()
    // Two tabs both want to start once the old record is handed over; only one may win.
    const a = new TimerController({ store, saveRecord: () => undefined, newId: () => 'a' })
    const b = new TimerController({ store, saveRecord: () => undefined, newId: () => 'b' })
    const startA = a.start(startOptions(countdown(10)))
    const startB = b.start(startOptions(countdown(15)))
    release()
    await stopping
    const results = await Promise.allSettled([startA, startB])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const winner = results[0]?.status === 'fulfilled' ? 'a' : 'b'
    expect(store.load()?.session.id).toBe(winner)
  })
})

describe('LocalActiveSessionStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('persists the active session in localStorage across controllers', async () => {
    const store = new LocalActiveSessionStore()
    const saveRecord = vi.fn()
    const first = new TimerController({ store, saveRecord })
    await first.start(startOptions(countdown(30)))
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).not.toBeNull()
    wait(12 * MINUTE_MS)
    const second = new TimerController({ store: new LocalActiveSessionStore(), saveRecord })
    expect((await second.restore()).snapshot?.remainingMs).toBe(18 * MINUTE_MS)
    wait(MINUTE_MS)
    await second.stop()
    expect(saveRecord).toHaveBeenCalledOnce()
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
  })

  it.each([
    ['not JSON', '{'],
    ['the wrong shape', '{"session":{"version":1}}'],
    ['another schema version', '{"session":{"version":99},"pendingRecord":null}'],
  ])('reads %s as no session', (_label, raw) => {
    expect(parseStoredTimer(raw)).toBeNull()
  })

  it('rejects a stored session with an invalid configuration', async () => {
    const store = new MemoryActiveSessionStore()
    await new TimerController({ store, saveRecord: () => {} }).start(startOptions(countdown(10)))
    const stored = store.load()
    expect(stored).not.toBeNull()
    const broken = JSON.stringify({
      ...stored,
      session: { ...stored?.session, config: { mode: 'countdown', minutes: 999 } },
    })
    expect(parseStoredTimer(broken)).toBeNull()
  })
})

describe('clock moved backwards (#93)', () => {
  it('restore() after a reload hands over a valid record when the clock went back during a pause', async () => {
    const { store, make } = setup()
    const controller = make(() => Promise.reject(new Error('offline')))
    await controller.start(startOptions({ mode: 'unlimited', reminderMinutes: null }))
    wait(10 * MINUTE_MS)
    await controller.pause()
    vi.setSystemTime(T0 + 5 * MINUTE_MS)
    await controller.resume()
    vi.setSystemTime(T0 + 20 * MINUTE_MS)
    await controller.stop()
    const pending = store.load()?.pendingRecord
    expect(pending?.pausedSeconds).toBe(0)

    const handed: SessionRecord[] = []
    const restored = await make((r) => {
      handed.push(r)
    }).restore()
    expect(restored.outcome).toMatchObject({ kind: 'saved', record: { pausedSeconds: 0 } })
    const record = handed[0]
    const span = (Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000
    expect(record.focusSeconds + record.pausedSeconds).toBeLessThanOrEqual(span + 2)
  })
})

describe('a failed write to the device store is retried', () => {
  /** A store whose next `failures` saves throw (quota, private mode), then behaves normally. */
  function flaky() {
    const inner = new MemoryActiveSessionStore()
    const state = { failures: 0 }
    const store: ActiveSessionStore = {
      load: () => inner.load(),
      clear: () => inner.clear(),
      save(value) {
        if (state.failures > 0) {
          state.failures -= 1
          throw new Error('QuotaExceededError')
        }
        inner.save(value)
      },
    }
    return { store, state }
  }

  it('catches up on the next tick after a phase change, and a reload sees it', async () => {
    const { store, state } = flaky()
    const { controller, make } = setup(store)
    await controller.start(
      startOptions({ ...DEFAULT_POMODORO, blocks: 2, focusMinutes: 10, breakMinutes: 5 }),
    )
    const before = store.load()?.session
    wait(10 * MINUTE_MS)
    state.failures = 1
    const update = await controller.tick() // the write fails; the bell is still reported once
    expect(update.events).toMatchObject([{ type: 'phase-change', to: 'break' }])
    expect(store.load()?.session).toEqual(before) // stored copy is behind, with a retry pending

    wait(SECOND)
    expect((await controller.tick()).events).toEqual([]) // not reported twice
    expect(store.load()?.session).not.toEqual(before)

    const reloaded = make()
    const restored = await reloaded.restore()
    expect(restored.snapshot?.pomodoro).toMatchObject({ phase: 'break' })
    expect(restored.events).toEqual([])
    expect((await reloaded.tick()).events).toEqual([]) // no replayed phase change
  })

  it('writes a pause that failed to store on the next call', async () => {
    const { store, state } = flaky()
    const { controller, make, saved } = setup(store)
    await controller.start(startOptions(countdown(25)))
    wait(MINUTE_MS)
    state.failures = 1
    expect((await controller.pause()).snapshot?.paused).toBe(true)
    expect(store.load()?.session.pauses).toHaveLength(0)

    wait(MINUTE_MS)
    expect(controller.current()?.paused).toBe(true) // reading writes nothing
    expect(store.load()?.session.pauses).toHaveLength(0)
    await controller.tick() // retries
    expect(store.load()?.session.pauses).toHaveLength(1)

    const reloaded = make()
    expect((await reloaded.restore()).snapshot).toMatchObject({ paused: true })
    const stopped = await reloaded.stop()
    expect(stopped.outcome).toMatchObject({ kind: 'saved' })
    expect(saved[0]).toMatchObject({ focusSeconds: 60, pausedSeconds: 60 })
  })

  it('keeps retrying while writes keep failing, and the stop still saves correctly', async () => {
    const { store, state } = flaky()
    const { controller, saved } = setup(store)
    await controller.start(startOptions(countdown(25)))
    wait(MINUTE_MS)
    state.failures = 3
    await controller.pause()
    wait(MINUTE_MS)
    await controller.tick()
    await controller.tick()
    expect(store.load()?.session.pauses).toHaveLength(0)
    await controller.tick()
    expect(store.load()?.session.pauses).toHaveLength(1)
    await controller.stop()
    expect(saved[0]).toMatchObject({ focusSeconds: 60, pausedSeconds: 60 })
  })

  it('drops the retry when another tab has changed the stored session meanwhile', async () => {
    const { store, state } = flaky()
    const { controller: tabA, make } = setup(store)
    await tabA.start(startOptions(countdown(25)))
    const tabB = make()
    await tabB.restore()
    wait(MINUTE_MS)
    state.failures = 1
    await tabA.pause() // fails to store
    wait(SECOND)
    await tabB.pause() // tab B reads the store (unpaused) and stores its own pause
    wait(SECOND)
    await tabA.tick() // must not overwrite B's pause with its own older one
    expect(store.load()?.session.pauses).toHaveLength(1)
    expect(store.load()?.session.pauses[0]?.pausedAt).toBe(T0 + MINUTE_MS + SECOND)
    expect(tabA.current()?.paused).toBe(true)
  })

  it("a second tab restoring does not undo the first tab's pending pause", async () => {
    const { store, state } = flaky()
    const { controller: tabA, make } = setup(store)
    await tabA.start(startOptions(countdown(25)))
    wait(MINUTE_MS)
    state.failures = 1
    await tabA.pause() // fails to store
    wait(SECOND)
    const tabB = make()
    expect((await tabB.restore()).snapshot?.paused).toBe(false) // B only reads
    wait(SECOND)
    await tabA.tick()
    expect(store.load()?.session.pauses).toHaveLength(1)
    expect(tabA.current()?.paused).toBe(true)
  })

  it('restoring on the same controller writes its own pending change first', async () => {
    const { store, state } = flaky()
    const { controller } = setup(store)
    await controller.start(startOptions(countdown(25)))
    wait(MINUTE_MS)
    state.failures = 1
    await controller.pause()
    const restored = await controller.restore()
    expect(restored.snapshot?.paused).toBe(true)
    expect(store.load()?.session.pauses).toHaveLength(1)
  })

  it('a failed write in start keeps the timer, says so, and catches up', async () => {
    const { store, state } = flaky()
    const { controller, make } = setup(store)
    state.failures = 1
    const update = await controller.start(startOptions(countdown(25)))
    expect(update.snapshot).not.toBeNull()
    expect(update.unsaved).toBe(true)
    expect(store.load()).toBeNull() // a reload now would lose it
    await expect(controller.start(startOptions(countdown(25)))).rejects.toBeInstanceOf(
      ActiveSessionExistsError,
    )
    wait(SECOND)
    expect(controller.current()?.paused).toBe(false)
    expect((await controller.tick()).unsaved).toBe(false)
    const reloaded = make()
    expect((await reloaded.restore()).snapshot).not.toBeNull()
  })

  it("a start that never reached the store yields to another tab's session", async () => {
    const { store, state } = flaky()
    const { controller: tabA, make } = setup(store)
    state.failures = 1
    await tabA.start(startOptions(countdown(25)))
    const tabB = make()
    await tabB.start(startOptions(countdown(10)))
    wait(SECOND)
    await tabA.tick()
    expect(store.load()?.session.config).toEqual(countdown(10))
    expect(tabA.current()?.config).toEqual(countdown(10))
  })

  it('a failed write in restore does not throw, keeps memory and catches up', async () => {
    const { store, state } = flaky()
    const { controller, make } = setup(store)
    await controller.start(
      startOptions({ ...DEFAULT_POMODORO, blocks: 2, focusMinutes: 10, breakMinutes: 5 }),
    )
    wait(11 * MINUTE_MS) // the phase changed while the app was closed
    const reloaded = make()
    state.failures = 1
    const restored = await reloaded.restore()
    expect(restored.snapshot?.pomodoro).toMatchObject({ phase: 'break' })
    expect(restored.unsaved).toBe(true)
    wait(SECOND)
    expect((await reloaded.tick()).events).toEqual([]) // no replayed bell
    expect(make().current()?.pomodoro).toMatchObject({ phase: 'break' })
    const again = make()
    expect((await again.restore()).events).toEqual([])
    expect(store.load()?.session.observedActiveMs).toBeGreaterThan(0)
  })

  it('a failed pendingRecord write in finish still hands the record over', async () => {
    const { store, state } = flaky()
    const { controller, saved, make } = setup(store)
    await controller.start(startOptions(countdown(25)))
    wait(2 * MINUTE_MS)
    state.failures = 1
    const stopped = await controller.stop()
    expect(stopped.outcome).toMatchObject({ kind: 'saved' })
    expect(stopped.recordPending).toBe(false)
    expect(saved).toHaveLength(1)
    expect(store.load()).toBeNull() // the running copy is gone: a reload doesn't resurrect it
    expect(make().current()).toBeNull()
  })

  it('keeps a record held in memory when neither the store nor saveRecord took it', async () => {
    const { store, state } = flaky()
    const saved: SessionRecord[] = []
    let failSave = true
    const { make } = setup(store)
    const controller = make((r) => {
      if (failSave) throw new Error('IndexedDB unavailable')
      saved.push(r)
    })
    await controller.start(startOptions(countdown(25)))
    wait(2 * MINUTE_MS)
    state.failures = 1
    const stopped = await controller.stop()
    expect(stopped.recordPending).toBe(true)
    expect(controller.current()).toBeNull() // the stale running copy isn't picked up again
    failSave = false
    expect(await controller.retryPending()).toBe(true)
    expect(saved).toHaveLength(1)
    expect(store.load()).toBeNull()
    await controller.start(startOptions(countdown(5))) // free to start again
  })

  it('finishing drops a pending retry so it cannot come back', async () => {
    const { store, state } = flaky()
    const { controller, saved } = setup(store)
    await controller.start(startOptions(countdown(25)))
    wait(2 * MINUTE_MS)
    state.failures = 1
    await controller.pause() // unsaved
    await controller.stop()
    expect(saved).toHaveLength(1)
    await controller.start(startOptions(countdown(5)))
    expect(store.load()?.session.config).toEqual(countdown(5))
    wait(SECOND)
    await controller.tick()
    expect(store.load()?.session.config).toEqual(countdown(5))
    expect(controller.current()?.paused).toBe(false)
  })

  it('hands over a held record even when another tab has put a session in the store', async () => {
    const { store, state } = flaky()
    const saved: SessionRecord[] = []
    let failSave = true
    const { make } = setup(store)
    const tabA = make((r) => {
      if (failSave) throw new Error('IndexedDB unavailable')
      saved.push(r)
    })
    state.failures = 3 // the start write, its retry at stop, and the pendingRecord write
    await tabA.start(startOptions(countdown(25)))
    wait(2 * MINUTE_MS)
    expect((await tabA.stop()).recordPending).toBe(true)
    await make().start(startOptions(countdown(10))) // tab B reaches the store
    failSave = false
    expect(await tabA.retryPending()).toBe(true)
    expect(saved).toHaveLength(1)
  })
})
