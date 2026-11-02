// AC8.2, AC12.6: rain pauses for Pomodoro breaks (setting on) or plays through them (setting off),
// on a fake clock and the real timer screen.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MINUTE_MS,
  MemoryActiveSessionStore,
  TimerController,
  type TimerConfig,
} from '../timer/index.ts'
import { SettingsContext } from '../settings/SettingsContext.ts'
import { SettingsStore } from '../settings/store.ts'
import TimerScreen from '../timerscreen/TimerScreen.tsx'
import { AlertPlayer, MemoryAlertVolumeStore } from './alerts.ts'
import AudioControls from './AudioControls.tsx'
import { MemoryBackgroundVolumeStore, RainPlayer } from './rain.ts'

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

const CONFIG: TimerConfig = {
  mode: 'pomodoro',
  focusMinutes: 5,
  breakMinutes: 1,
  blocks: 2,
  longBreakEnabled: false,
  longBreakMinutes: 15,
}

function fakeRain() {
  const sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = []
  const gain = () => ({
    gain: {
      value: 0,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    },
    connect: vi.fn(),
  })
  const context = {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume: async () => undefined,
    decodeAudioData: async () => ({ duration: 30.2 }),
    createGain: gain,
    createBufferSource: () => {
      const source = {
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
      sources.push(source)
      return source
    },
  }
  const alerts = new AlertPlayer({
    volume: new MemoryAlertVolumeStore(),
    createContext: () => context as unknown as AudioContext,
    fetchSound: async () => new ArrayBuffer(1),
  })
  const rain = new RainPlayer({
    alerts,
    volume: new MemoryBackgroundVolumeStore(),
    fetchSound: async () => new ArrayBuffer(1),
  })
  return { sources, rain, alerts }
}

const heading = () => screen.getByRole('heading', { level: 1 })
const CUE = 'Paused for the break'
/** Live sources: started and not stopped. */
const live = (sources: ReturnType<typeof fakeRain>['sources']) =>
  sources.filter((s) => s.start.mock.calls.length > 0 && s.stop.mock.calls.length === 0)

async function setup(
  options: { pause?: boolean; source?: 'none' | 'rain'; config?: TimerConfig } = {},
) {
  const { sources, rain, alerts } = fakeRain()
  const bell = vi.spyOn(alerts, 'play').mockResolvedValue(undefined)
  const source = options.source ?? 'rain'
  const settings = new SettingsStore()
  if (options.pause === false) settings.update({ pause_audio_on_breaks: false })
  const store = new MemoryActiveSessionStore()
  const controller = new TimerController({ store, saveRecord: () => undefined })
  await controller.start({ config: options.config ?? CONFIG, tag: 'work', goal: null })
  const mount = (c: TimerController) =>
    render(
      <SettingsContext.Provider value={settings}>
        <TimerScreen
          controller={c}
          audio={source}
          onEvents={alerts.handleEvents}
          onEnded={() => undefined}
          audioControls={({ paused, inBreak }) => (
            <AudioControls
              source={source}
              paused={paused}
              inBreak={inBreak}
              rain={rain}
              onSourceChange={() => undefined}
            />
          )}
        />
      </SettingsContext.Provider>,
    )
  const view = mount(controller)
  await advance(100)
  return { sources, rain, settings, store, controller, view, mount, bell }
}

describe('rain through a Pomodoro session, pause_audio_on_breaks on (AC8.2)', () => {
  it('stops at the break, bell untouched, and a new source starts at the next focus', async () => {
    const t = await setup()
    expect(t.sources).toHaveLength(1)
    await advance(5 * MINUTE_MS)
    expect(heading()).toHaveTextContent('Break')
    expect(t.sources[0].stop).toHaveBeenCalled()
    expect(live(t.sources)).toHaveLength(0)
    expect(t.bell).toHaveBeenCalledTimes(1) // the bell rings as the break begins
    expect(t.bell).toHaveBeenLastCalledWith('bell')
    await advance(MINUTE_MS)
    expect(heading()).toHaveTextContent('Focus')
    expect(t.bell).toHaveBeenCalledTimes(2) // and as the next focus block begins
    expect(t.sources).toHaveLength(2)
    expect(live(t.sources)).toHaveLength(1)
  })

  it('shows "Paused for the break" in a polite status only during the break (AC5)', async () => {
    const t = await setup()
    expect(screen.queryByText(CUE)).toBeNull()
    await advance(5 * MINUTE_MS)
    const cue = screen.getByText(CUE)
    expect(cue).toHaveAttribute('role', 'status')
    await advance(MINUTE_MS)
    expect(screen.queryByText(CUE)).toBeNull()
    t.view.unmount()
  })

  it('resumes right away on Skip break', async () => {
    const t = await setup()
    await advance(5 * MINUTE_MS)
    expect(live(t.sources)).toHaveLength(0)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip break' }))
    })
    await advance(100)
    expect(heading()).toHaveTextContent('Focus')
    expect(live(t.sources)).toHaveLength(1)
  })

  it('keeps the audio paused when the timer is paused and resumed in a break', async () => {
    const t = await setup()
    await advance(5 * MINUTE_MS)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    })
    await advance(1000)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    })
    await advance(1000)
    expect(heading()).toHaveTextContent('Break')
    expect(live(t.sources)).toHaveLength(0)
    expect(screen.getByText(CUE)).toBeInTheDocument()
  })

  it('pausing during focus behaves as today: rain pauses and resumes', async () => {
    const t = await setup()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    })
    await advance(100)
    expect(live(t.sources)).toHaveLength(0)
    expect(screen.queryByText(CUE)).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    })
    await advance(100)
    expect(live(t.sources)).toHaveLength(1)
  })

  it('starts paused when a reload restores a session that is in a break', async () => {
    const t = await setup()
    await advance(5 * MINUTE_MS + 1000)
    t.view.unmount()
    const second = fakeRain()
    const settings = new SettingsStore()
    const controller = new TimerController({ store: t.store, saveRecord: () => undefined })
    await controller.restore()
    render(
      <SettingsContext.Provider value={settings}>
        <TimerScreen
          controller={controller}
          audio="rain"
          onEnded={() => undefined}
          audioControls={({ paused, inBreak }) => (
            <AudioControls
              source="rain"
              paused={paused}
              inBreak={inBreak}
              rain={second.rain}
              onSourceChange={() => undefined}
            />
          )}
        />
      </SettingsContext.Provider>,
    )
    await advance(200)
    expect(heading()).toHaveTextContent('Break')
    expect(live(second.sources)).toHaveLength(0)
    expect(screen.getByText(CUE)).toBeInTheDocument()
  })

  it('takes a setting change in the break at once: off resumes, on pauses', async () => {
    const t = await setup()
    await advance(5 * MINUTE_MS)
    expect(live(t.sources)).toHaveLength(0)
    await act(async () => t.settings.update({ pause_audio_on_breaks: false }))
    await advance(100)
    expect(live(t.sources)).toHaveLength(1)
    expect(screen.queryByText(CUE)).toBeNull()
    await act(async () => t.settings.update({ pause_audio_on_breaks: true }))
    await advance(100)
    expect(live(t.sources)).toHaveLength(0)
    expect(screen.getByText(CUE)).toBeInTheDocument()
  })

  it('stops the audio when the session ends during a break', async () => {
    const t = await setup()
    await advance(5 * MINUTE_MS)
    t.view.unmount()
    expect(live(t.sources)).toHaveLength(0)
  })
})

describe('breaks and other modes (AC8.2, AC4)', () => {
  it('pauses and resumes for a long break too', async () => {
    const t = await setup({
      config: { ...CONFIG, blocks: 5, longBreakEnabled: true, longBreakMinutes: 5 },
    })
    await advance(5 * MINUTE_MS + MINUTE_MS + 5 * MINUTE_MS + MINUTE_MS + 5 * MINUTE_MS + MINUTE_MS)
    expect(heading()).toHaveTextContent('Focus') // the 4th focus block
    expect(live(t.sources)).toHaveLength(1)
    await advance(5 * MINUTE_MS)
    expect(heading()).toHaveTextContent('Long break')
    expect(live(t.sources)).toHaveLength(0)
    expect(screen.getByText(CUE)).toBeInTheDocument()
    await advance(5 * MINUTE_MS)
    expect(heading()).toHaveTextContent('Focus')
    expect(live(t.sources)).toHaveLength(1)
    expect(screen.queryByText(CUE)).toBeNull()
  })

  it('shows no cue in a break when no background audio is chosen', async () => {
    await setup({ source: 'none' })
    await advance(5 * MINUTE_MS)
    expect(heading()).toHaveTextContent('Break')
    expect(screen.queryByText(CUE)).toBeNull()
  })

  it('does not touch a Countdown session: rain plays throughout, no cue', async () => {
    const t = await setup({ config: { mode: 'countdown', minutes: 25 } })
    await advance(10 * MINUTE_MS)
    expect(t.sources).toHaveLength(1)
    expect(t.sources[0].stop).not.toHaveBeenCalled()
    expect(live(t.sources)).toHaveLength(1)
    expect(screen.queryByText(CUE)).toBeNull()
  })

  it('does not touch an Unlimited session: rain plays throughout, no cue', async () => {
    const t = await setup({ config: { mode: 'unlimited', reminderMinutes: null } })
    await advance(10 * MINUTE_MS)
    expect(t.sources).toHaveLength(1)
    expect(t.sources[0].stop).not.toHaveBeenCalled()
    expect(live(t.sources)).toHaveLength(1)
    expect(screen.queryByText(CUE)).toBeNull()
  })
})

describe('rain through a Pomodoro session, pause_audio_on_breaks off (AC12.6)', () => {
  it('plays one source from focus through the break into the next focus, never stopped', async () => {
    const t = await setup({ pause: false })
    await advance(100)
    expect(t.sources).toHaveLength(1)
    await advance(5 * MINUTE_MS)
    expect(heading()).toHaveTextContent('Break')
    expect(t.sources).toHaveLength(1)
    expect(t.sources[0].stop).not.toHaveBeenCalled()
    expect(screen.queryByText(CUE)).toBeNull()
    await advance(MINUTE_MS)
    expect(heading()).toHaveTextContent('Focus')
    expect(t.sources).toHaveLength(1)
    expect(t.sources[0].stop).not.toHaveBeenCalled()
  })
})
