import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
import { KEEP_AWAKE_KEY } from './wakeLock.ts'

// Fake clock: Vitest's fake timers own Date.now() and setInterval.
const T0 = Date.UTC(2026, 9, 23, 9, 0, 0)

beforeEach(() => {
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
  render(<TimerScreen controller={controller} audio="rain" onEnded={onEnded} onEvents={onEvents} />)
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
    expect(localStorage.getItem(KEEP_AWAKE_KEY)).toBe('true')
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(release).toHaveBeenCalled()
  })

  it('requests the lock again when the tab becomes visible', async () => {
    const { request } = stubWakeLock()
    localStorage.setItem(KEEP_AWAKE_KEY, 'true')
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
