// The sounds wired to the real timer screen on a fake clock (AC5.1 rules, decision on #13).
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_POMODORO,
  MINUTE_MS,
  MemoryActiveSessionStore,
  TimerController,
  type TimerConfig,
} from '../timer/index.ts'
import TimerScreen from '../timerscreen/TimerScreen.tsx'
import { AlertPlayer, MemoryAlertVolumeStore } from './alerts.ts'

const T0 = Date.UTC(2026, 9, 23, 9, 0, 0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => vi.useRealTimers())

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Mounts the timer screen with an AlertPlayer on a fake audio context; returns what played. */
async function mount(config: TimerConfig) {
  const played: number[] = [] // decoded byte length: 2 = bell, 1 = chime
  const context = {
    state: 'running',
    destination: {},
    resume: async () => undefined,
    decodeAudioData: async (data: ArrayBuffer) => ({ bytes: data.byteLength }),
    createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
    createBufferSource: () => {
      const source = {
        buffer: null as { bytes: number } | null,
        connect: () => undefined,
        start: () => played.push(source.buffer?.bytes ?? -1),
      }
      return source
    },
  }
  const alerts = new AlertPlayer({
    volume: new MemoryAlertVolumeStore(80),
    createContext: () => context as unknown as AudioContext,
    fetchSound: async (url) => new ArrayBuffer(url.includes('bell') ? 2 : 1),
  })
  const controller = new TimerController({
    store: new MemoryActiveSessionStore(),
    saveRecord: () => undefined,
  })
  await controller.start({ config, tag: 'work', goal: null })
  render(
    <TimerScreen
      controller={controller}
      audio="none"
      onEvents={alerts.handleEvents}
      onEnded={() => undefined}
    />,
  )
  return { played }
}

const BELL = 2
const CHIME = 1
const pomodoro = { ...DEFAULT_POMODORO, focusMinutes: 5, breakMinutes: 5, blocks: 2 }

describe('sounds on the timer screen', () => {
  it('rings the bell when a phase reaches zero', async () => {
    const { played } = await mount(pomodoro)
    await advance(5 * MINUTE_MS + 1000)
    expect(played).toEqual([BELL])
  })

  it('rings the bell when a countdown completes', async () => {
    const { played } = await mount({ mode: 'countdown', minutes: 2 })
    await advance(2 * MINUTE_MS + 1000)
    expect(played).toEqual([BELL])
  })

  it('plays no sound when the user skips a break', async () => {
    const { played } = await mount(pomodoro)
    await advance(5 * MINUTE_MS + 1000)
    played.length = 0
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /skip/i }))
    })
    await advance(2000)
    expect(played).toEqual([])
  })

  it('plays no sound when the user stops early', async () => {
    const { played } = await mount({ mode: 'countdown', minutes: 25 })
    await advance(3 * MINUTE_MS)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    })
    expect(played).toEqual([])
  })

  it('chimes on an unlimited-timer reminder, and rings the bell at the 12 h auto-stop', async () => {
    const { played } = await mount({ mode: 'unlimited', reminderMinutes: 30 })
    await advance(30 * MINUTE_MS + 1000)
    expect(played).toEqual([CHIME])
    // Jump the clock (a backgrounded tab) instead of ticking 12 h of 250 ms steps.
    vi.setSystemTime(T0 + 13 * 60 * MINUTE_MS)
    await advance(250)
    expect(played.at(-1)).toBe(BELL)
  })
})
