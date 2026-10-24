import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsContext } from '../settings/SettingsContext.ts'
import { SettingsStore } from '../settings/store.ts'
import {
  ACTIVE_SESSION_KEY,
  DEFAULT_POMODORO,
  MINUTE_MS,
  MemoryActiveSessionStore,
  TimerController,
  type SessionRecord,
  type TimerConfig,
  type TimerUpdate,
} from '../timer/index.ts'
import SessionSummary from './SessionSummary.tsx'
import TimerScreen from './TimerScreen.tsx'

// Fake clock: Vitest's fake timers own Date.now() and setInterval.
const T0 = Date.UTC(2026, 9, 23, 9, 0, 0)

let settings = new SettingsStore()

beforeEach(() => {
  settings = new SettingsStore()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

async function mount(config: TimerConfig, goal: string | null = 'Write the report') {
  const store = new MemoryActiveSessionStore()
  const saved: SessionRecord[] = []
  const controller = new TimerController({
    store,
    saveRecord: (record) => {
      saved.push(record)
    },
  })
  await controller.start({ config, tag: 'study', goal })
  const onEnded = vi.fn<(update: TimerUpdate) => void>()
  const onEvents = vi.fn()
  render(
    <SettingsContext.Provider value={settings}>
      <TimerScreen controller={controller} audio="rain" onEnded={onEnded} onEvents={onEvents} />
    </SettingsContext.Provider>,
  )
  return { controller, store, saved, onEnded, onEvents }
}

const pomodoro = (overrides: Partial<typeof DEFAULT_POMODORO> = {}) => ({
  ...DEFAULT_POMODORO,
  ...overrides,
})

describe('TimerScreen (AC9.1)', () => {
  it('shows the time, mode, phase, tag, goal and audio for a countdown', async () => {
    await mount({ mode: 'countdown', minutes: 25 })
    expect(screen.getByRole('timer')).toHaveTextContent('25:00')
    expect(screen.getByText('Countdown')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Focus' })).toBeInTheDocument()
    expect(screen.getByText('study')).toBeInTheDocument()
    expect(screen.getByText('Write the report')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Background audio' })).toHaveTextContent('Rain')
    await advance(61_000)
    expect(screen.getByRole('timer')).toHaveTextContent('23:59')
  })

  it('counts an unlimited timer up and has no Block line', async () => {
    await mount({ mode: 'unlimited', reminderMinutes: null }, null)
    await advance(65_000)
    expect(screen.getByRole('timer')).toHaveTextContent('01:05')
    expect(screen.queryByText(/Block/)).not.toBeInTheDocument()
  })

  it('ac3_4 shows the Pomodoro phase and "Block 2 of 4", staying on the block during a break', async () => {
    await mount(pomodoro())
    expect(screen.getByText('Block 1 of 4')).toBeInTheDocument()
    await advance(26 * MINUTE_MS)
    expect(screen.getByRole('heading', { name: 'Break' })).toBeInTheDocument()
    expect(screen.getByText('Block 1 of 4')).toBeInTheDocument()
    expect(screen.getByRole('timer')).toHaveTextContent('04:00')
    await advance(5 * MINUTE_MS)
    expect(screen.getByText('Block 2 of 4')).toBeInTheDocument()
  })

  it('labels a long break', async () => {
    await mount(pomodoro({ blocks: 8, focusMinutes: 5, breakMinutes: 1, longBreakEnabled: true }))
    await advance((4 * 5 + 3) * MINUTE_MS + 1000)
    expect(screen.getByRole('heading', { name: 'Long break' })).toBeInTheDocument()
    expect(screen.getByText('Block 4 of 8')).toBeInTheDocument()
  })

  it('reports bells due from the tick through onEvents (hook for #16)', async () => {
    const { onEvents } = await mount(pomodoro({ focusMinutes: 5 }))
    await advance(5 * MINUTE_MS + 1000)
    expect(onEvents).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'phase-change', from: 'focus', to: 'break', skipped: false }),
    ])
  })

  it('stays correct after the tab was in the background (timestamp-based)', async () => {
    await mount({ mode: 'countdown', minutes: 25 })
    vi.setSystemTime(T0 + 10 * MINUTE_MS) // timers throttled: no ticks ran meanwhile
    await advance(250)
    expect(screen.getByRole('timer')).toHaveTextContent('15:00')
    await advance(1000)
    expect(screen.getByRole('timer')).toHaveTextContent('14:59')
  })
})

describe('TimerScreen controls', () => {
  it('pauses and resumes, and the clock stops while paused', async () => {
    const { controller } = await mount({ mode: 'countdown', minutes: 25 })
    await advance(60_000)
    await click('Pause')
    expect(controller.current()?.paused).toBe(true)
    expect(screen.getByRole('heading', { name: 'Focus, paused' })).toBeInTheDocument()
    await advance(5 * MINUTE_MS)
    expect(screen.getByRole('timer')).toHaveTextContent('24:00')
    await click('Resume')
    expect(screen.getByRole('heading', { name: 'Focus' })).toBeInTheDocument()
    await advance(60_000)
    expect(screen.getByRole('timer')).toHaveTextContent('23:00')
  })

  it('offers Skip break only during a Pomodoro break, and skipping starts the next block', async () => {
    const { controller, onEvents } = await mount(pomodoro())
    expect(screen.queryByRole('button', { name: 'Skip break' })).not.toBeInTheDocument()
    await advance(26 * MINUTE_MS)
    onEvents.mockClear()
    await click('Skip break')
    expect(controller.current()?.pomodoro).toMatchObject({ phase: 'focus', block: 2 })
    expect(screen.queryByRole('button', { name: 'Skip break' })).not.toBeInTheDocument()
    expect(screen.getByText('Block 2 of 4')).toBeInTheDocument()
    // Skipping is reported (so the sounds can tell it from an automatic change), flagged as skipped.
    expect(onEvents.mock.calls.flat(2)).toEqual([
      expect.objectContaining({ type: 'phase-change', skipped: true }),
    ])
  })

  it('never offers Skip break in countdown or unlimited mode', async () => {
    await mount({ mode: 'countdown', minutes: 5 })
    expect(screen.queryByRole('button', { name: 'Skip break' })).not.toBeInTheDocument()
  })

  it('stop ends the session and hands the update to onEnded', async () => {
    const { saved, onEnded } = await mount({ mode: 'countdown', minutes: 25 })
    await advance(10 * MINUTE_MS)
    await click('Stop')
    expect(saved).toEqual([expect.objectContaining({ status: 'ended_early', focusSeconds: 600 })])
    expect(onEnded).toHaveBeenCalledOnce()
    expect(onEnded.mock.calls[0]?.[0].outcome).toMatchObject({ kind: 'saved' })
  })

  it('ends on its own when the countdown reaches zero', async () => {
    const { saved, onEnded } = await mount({ mode: 'countdown', minutes: 2 })
    await advance(2 * MINUTE_MS + 500)
    expect(onEnded).toHaveBeenCalledOnce()
    expect(saved).toEqual([expect.objectContaining({ status: 'completed' })])
  })

  it('keeps an action error visible across ticks until the next user action', async () => {
    const { controller } = await mount({ mode: 'countdown', minutes: 25 })
    const pause = vi.spyOn(controller, 'pause').mockRejectedValueOnce(new Error('Disk is full'))
    await click('Pause')
    expect(screen.getByRole('alert')).toHaveTextContent('Disk is full')
    await advance(2000) // several interval ticks
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: ACTIVE_SESSION_KEY }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Disk is full')
    await click('Pause') // the next user action clears it
    expect(pause).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('follows a pause made in another tab', async () => {
    const { controller, store } = await mount({ mode: 'countdown', minutes: 25 })
    const otherTab = new TimerController({ store, saveRecord: () => undefined })
    await otherTab.restore()
    await advance(60_000)
    await act(async () => {
      await otherTab.pause()
    })
    await advance(500)
    expect(controller.current()?.paused).toBe(true)
    expect(screen.getByRole('heading', { name: 'Focus, paused' })).toBeInTheDocument()
  })

  it('returns to the caller when another tab stopped the session', async () => {
    const { store, onEnded } = await mount({ mode: 'countdown', minutes: 25 })
    const otherTab = new TimerController({ store, saveRecord: () => undefined })
    await otherTab.restore()
    await advance(5 * MINUTE_MS)
    await act(async () => {
      await otherTab.stop()
    })
    await advance(500)
    expect(onEnded).toHaveBeenCalledOnce()
    expect(onEnded.mock.calls[0]?.[0]).toMatchObject({ snapshot: null, outcome: null })
  })
})

describe('async saving and two tabs', () => {
  it('shows the real outcome when saving takes a while, even though ticks keep firing', async () => {
    const saved: SessionRecord[] = []
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: async (record) => {
        await new Promise((resolve) => setTimeout(resolve, 400))
        saved.push(record)
      },
    })
    await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    const onEnded = vi.fn<(update: TimerUpdate) => void>()
    render(<TimerScreen controller={controller} audio="none" onEnded={onEnded} />)
    await advance(5 * MINUTE_MS)
    await click('Stop')
    await advance(1000) // interval ticks fire while the save is pending
    expect(onEnded).toHaveBeenCalledOnce() // late ticks can't end it a second time
    expect(onEnded.mock.calls[0]?.[0].outcome).toMatchObject({
      kind: 'saved',
      record: { status: 'ended_early' },
    })
    expect(saved).toHaveLength(1)
  })

  it('a countdown ending during a slow save, with Stop pressed at the same time, ends once', async () => {
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: () => new Promise((resolve) => setTimeout(resolve, 400)),
    })
    await controller.start({ config: { mode: 'countdown', minutes: 2 }, tag: 'work', goal: null })
    const onEnded = vi.fn<(update: TimerUpdate) => void>()
    render(<TimerScreen controller={controller} audio="none" onEnded={onEnded} />)
    await advance(2 * MINUTE_MS - 100)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(onEnded).toHaveBeenCalledOnce()
    expect(onEnded.mock.calls[0]?.[0].outcome).toMatchObject({ kind: 'saved' })
  })

  it('two tabs reacting to each other’s writes do not write back and forth', async () => {
    let writes = 0
    class NoisyStore extends MemoryActiveSessionStore {
      override save(state: Parameters<MemoryActiveSessionStore['save']>[0]) {
        writes += 1
        super.save(state)
        // Every save tells the other tab (here: every listener on the window).
        window.dispatchEvent(new StorageEvent('storage', { key: ACTIVE_SESSION_KEY }))
      }
    }
    const store = new NoisyStore()
    const tabA = new TimerController({ store, saveRecord: () => undefined })
    const tabB = new TimerController({ store, saveRecord: () => undefined })
    await tabA.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    await tabB.restore()
    render(<TimerScreen controller={tabA} audio="none" onEnded={vi.fn()} />)
    render(<TimerScreen controller={tabB} audio="none" onEnded={vi.fn()} />)
    writes = 0
    await advance(5 * 250)
    // Quiet ticks (no events) write nothing, in either tab.
    expect(writes).toBe(0)
    await act(async () => {
      await tabA.pause()
    })
    // One event, one write; the other tab only reads it.
    expect(writes).toBe(1)
    writes = 0
    await advance(5 * 250)
    expect(writes).toBe(0)
    expect(tabB.current()?.paused).toBe(true)
  })
})

describe('Keep screen awake (AC9.2)', () => {
  function stubWakeLock() {
    const release = vi.fn(() => Promise.resolve())
    const sentinel = { released: false, release }
    const request = vi.fn(() => Promise.resolve(sentinel))
    vi.stubGlobal('navigator', { ...navigator, wakeLock: { request } })
    return { request, release }
  }

  it('is off by default and requests a screen wake lock when turned on', async () => {
    const { request, release } = stubWakeLock()
    await mount({ mode: 'countdown', minutes: 25 })
    const toggle = screen.getByRole('checkbox', { name: 'Keep screen awake' })
    expect(toggle).not.toBeChecked()
    expect(request).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(request).toHaveBeenCalledWith('screen')
    expect(settings.values.keep_screen_awake).toBe(true)
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(release).toHaveBeenCalled()
  })

  it('requests the lock again when the tab becomes visible', async () => {
    const { request } = stubWakeLock()
    settings.update({ keep_screen_awake: true })
    await mount({ mode: 'countdown', minutes: 25 })
    expect(request).toHaveBeenCalledOnce()
    // The browser releases the lock when the tab is hidden.
    const first = (await request.mock.results[0]?.value) as { released: boolean }
    first.released = true
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('is disabled with an explanation where the Wake Lock API is missing', async () => {
    await mount({ mode: 'countdown', minutes: 25 })
    expect(screen.getByRole('checkbox', { name: 'Keep screen awake' })).toBeDisabled()
    expect(screen.getByText('Not supported on this device or browser.')).toBeInTheDocument()
  })
})

describe('SessionSummary', () => {
  const record: SessionRecord = {
    id: 'a',
    mode: 'pomodoro',
    tag: 'work',
    goal: 'Ship it',
    startedAt: '2026-10-23T09:00:00.000Z',
    endedAt: '2026-10-23T10:00:00.000Z',
    focusSeconds: 3900,
    pausedSeconds: 120,
    status: 'ended_early',
    modeConfig: DEFAULT_POMODORO,
    blocksCompleted: 2,
  }

  it('summarises a saved session and links to the history', () => {
    const onNew = vi.fn()
    render(<SessionSummary outcome={{ kind: 'saved', record }} onNewSession={onNew} />)
    expect(screen.getByRole('heading', { name: 'Session ended early' })).toBeInTheDocument()
    expect(screen.getByText('1 h 05 min')).toBeInTheDocument()
    expect(screen.getByText('2 of 4')).toBeInTheDocument()
    expect(screen.getByText('Ship it')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View history' })).toHaveAttribute('href', '/history')
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNew).toHaveBeenCalledOnce()
  })

  it('says so when the record is still waiting to be saved', () => {
    render(
      <SessionSummary outcome={{ kind: 'saved', record }} recordPending onNewSession={vi.fn()} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Not saved yet')
  })

  it('explains a session that was too short to save', () => {
    render(
      <SessionSummary
        outcome={{
          kind: 'discarded',
          reason: 'too_short',
          focusSeconds: 20,
          message: 'Too short.',
        }}
        onNewSession={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Session not saved' })).toBeInTheDocument()
    expect(screen.getByText('Too short.')).toBeInTheDocument()
  })
})

describe('keyboard focus on screen changes (#151)', () => {
  it('focuses the timer heading when the timer opens', async () => {
    await mount({ mode: 'countdown', minutes: 25 })
    expect(screen.getByRole('heading', { name: 'Focus' })).toHaveFocus()
  })

  it('focuses the summary heading when the summary opens', () => {
    render(
      <SessionSummary
        outcome={{ kind: 'failed', message: 'Too short.' } as never}
        onNewSession={() => undefined}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Session not saved' })).toHaveFocus()
  })
})
