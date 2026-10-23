// AC8.2: rain keeps playing through Pomodoro breaks, on a fake clock and the real timer screen.
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MINUTE_MS,
  MemoryActiveSessionStore,
  TimerController,
  type TimerConfig,
} from '../timer/index.ts'
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

describe('rain through a Pomodoro session', () => {
  it('plays one source from focus through the break into the next focus, never stopped', async () => {
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
    const config: TimerConfig = {
      mode: 'pomodoro',
      focusMinutes: 5,
      breakMinutes: 1,
      blocks: 2,
      longBreakEnabled: false,
      longBreakMinutes: 15,
    }
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: () => undefined,
    })
    await controller.start({ config, tag: 'work', goal: null })
    const view = render(
      <TimerScreen
        controller={controller}
        audio="rain"
        onEnded={() => undefined}
        audioControls={({ paused }) => (
          <AudioControls
            source="rain"
            paused={paused}
            rain={rain}
            onSourceChange={() => undefined}
          />
        )}
      />,
    )
    await advance(100)
    expect(sources).toHaveLength(1)

    await advance(5 * MINUTE_MS) // focus ends, the break begins
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Break')
    expect(sources).toHaveLength(1)
    expect(sources[0].stop).not.toHaveBeenCalled()

    await advance(MINUTE_MS) // the break ends, the next focus block begins
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Focus')
    expect(sources).toHaveLength(1)
    expect(sources[0].stop).not.toHaveBeenCalled()
  })
})
