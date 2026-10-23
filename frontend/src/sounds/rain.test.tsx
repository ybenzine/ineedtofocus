/// <reference types="node" />
import { readFileSync, statSync } from 'node:fs'
import { MPEGDecoder } from 'mpg123-decoder'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App.tsx'
import { MemoryPreferencesStore } from '../setup/preferences.ts'
import SessionSetup from '../setup/SessionSetup.tsx'
import { MemoryActiveSessionStore, TimerController } from '../timer/index.ts'
import { AlertPlayer, MemoryAlertVolumeStore } from './alerts.ts'
import { SettingsBackgroundVolumeStore } from '../settings/adapters.ts'
import { SettingsContext } from '../settings/SettingsContext.ts'
import SettingsScreen from '../settings/SettingsScreen.tsx'
import { SettingsStore } from '../settings/store.ts'
import AudioControls from './AudioControls.tsx'
import { AUDIO_SOURCE_KEY, LocalAudioSourceStore, MemoryAudioSourceStore } from './audioSource.ts'
import { MemoryBackgroundVolumeStore, RAIN_LOOP_END, RAIN_LOOP_START, RainPlayer } from './rain.ts'

function fakeAudio(state: AudioContextState = 'running') {
  const sources: {
    buffer: unknown
    loop: boolean
    loopStart: number
    loopEnd: number
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
  }[] = []
  const gains: {
    gain: {
      value: number
      setValueAtTime: ReturnType<typeof vi.fn>
      linearRampToValueAtTime: ReturnType<typeof vi.fn>
      cancelScheduledValues: ReturnType<typeof vi.fn>
    }
    connect: ReturnType<typeof vi.fn>
  }[] = []
  const context = {
    state: state as AudioContextState,
    currentTime: 1,
    destination: {},
    resume: vi.fn(async () => {
      context.state = 'running'
    }),
    decodeAudioData: vi.fn(async (data: ArrayBuffer) => ({
      bytes: data.byteLength,
      duration: 30.2,
    })),
    createGain: vi.fn(() => {
      const gain = {
        gain: {
          value: 0,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn((value: number) => {
            gain.gain.value = value
          }),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
      }
      gains.push(gain)
      return gain
    }),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null as unknown,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
      sources.push(source)
      return source
    }),
  }
  const alerts = new AlertPlayer({
    volume: new MemoryAlertVolumeStore(),
    createContext: () => context as unknown as AudioContext,
    fetchSound: async () => new ArrayBuffer(1),
  })
  const fetchSound = vi.fn(async () => new ArrayBuffer(4))
  const rain = new RainPlayer({ alerts, volume: new MemoryBackgroundVolumeStore(50), fetchSound })
  return { context, sources, gains, alerts, rain, fetchSound }
}

describe('RainPlayer', () => {
  it('loops the decoded buffer on the shared context at the background volume', async () => {
    const { rain, sources, gains, fetchSound } = fakeAudio()
    await rain.play()
    expect(fetchSound).toHaveBeenCalledWith(expect.stringContaining('audio/rain.mp3'))
    expect(sources).toHaveLength(1)
    expect(sources[0].loop).toBe(true)
    // Only the loop itself repeats, not the encoder's padding at either end.
    expect(sources[0].loopStart).toBe(0.1)
    expect(sources[0].loopEnd).toBeCloseTo(30.1)
    expect(sources[0].start).toHaveBeenCalledWith(0, 0.1)
    expect(sources[0].start).toHaveBeenCalled()
    expect(gains[0].gain.value).toBe(0.5)
  })

  it('fades in on start and out on pause and stop, with no click', async () => {
    const { rain, sources, gains } = fakeAudio()
    await rain.play()
    expect(gains[0].gain.setValueAtTime).toHaveBeenCalledWith(0, 1)
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.5, expect.any(Number))
    rain.pause()
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(
      0,
      expect.closeTo(1.04, 5),
    )
    expect(sources[0].stop).toHaveBeenCalledWith(expect.closeTo(1.04, 5))
    await rain.play()
    rain.stop()
    expect(sources[1].stop).toHaveBeenCalledWith(expect.closeTo(1.04, 5))
  })

  it('does not start a second loop when played twice', async () => {
    const { rain, sources } = fakeAudio()
    await rain.play()
    await rain.play()
    expect(sources).toHaveLength(1)
  })

  it('pause stops the loop and play starts it again, loading the file once', async () => {
    const { rain, sources, fetchSound } = fakeAudio()
    await rain.play()
    rain.pause()
    expect(sources[0].stop).toHaveBeenCalled()
    expect(rain.playing).toBe(false)
    await rain.play()
    expect(sources).toHaveLength(2)
    expect(fetchSound).toHaveBeenCalledTimes(1)
  })

  it('does not start if stopped while the file was still loading', async () => {
    const { rain, sources } = fakeAudio()
    const starting = rain.play()
    rain.stop()
    await starting
    expect(sources).toHaveLength(0)
  })

  it('applies a volume change to the running loop and keeps it separate from alerts', async () => {
    const { rain, alerts, gains } = fakeAudio()
    await rain.play()
    rain.setVolume(20)
    expect(gains[0].gain.value).toBe(0.2)
    expect(rain.volume).toBe(20)
    expect(alerts.volume).toBe(80)
  })

  it('stays silent, without throwing, when the recording cannot load', async () => {
    const audio = fakeAudio()
    const failing = new RainPlayer({
      alerts: audio.alerts,
      volume: new MemoryBackgroundVolumeStore(),
      fetchSound: async () => {
        throw new Error('offline')
      },
    })
    await expect(failing.play()).resolves.toBeUndefined()
    expect(audio.sources).toHaveLength(0)
  })

  it('does not touch navigator.audioSession', async () => {
    const audioSession = { type: 'auto' }
    Object.defineProperty(navigator, 'audioSession', { value: audioSession, configurable: true })
    const { rain } = fakeAudio()
    await rain.play()
    expect(audioSession.type).toBe('auto')
    Reflect.deleteProperty(navigator, 'audioSession')
  })
})

describe('device stores', () => {
  it('backs the background volume with the settings store: default 50, clamped', () => {
    const settings = new SettingsStore()
    const store = new SettingsBackgroundVolumeStore(settings)
    expect(store.load()).toBe(50)
    store.save(140)
    expect(settings.values.background_volume).toBe(100)
    settings.update({ background_volume: 20 })
    expect(store.load()).toBe(20)
  })

  it('remembers the audio source and ignores unknown values', () => {
    localStorage.clear()
    const store = new LocalAudioSourceStore()
    expect(store.load()).toBe('none')
    store.save('rain')
    expect(store.load()).toBe('rain')
    localStorage.setItem(AUDIO_SOURCE_KEY, 'radio')
    expect(store.load()).toBe('none')
    store.save('rain')
    store.clear()
    expect(store.load()).toBe('none')
  })
})

describe('rain.mp3 (AC8.3)', () => {
  const path = resolve(process.cwd(), 'public/audio/rain.mp3')
  const SILENT = 0.001 // about -60 dBFS

  async function decode() {
    const decoder = new MPEGDecoder()
    await decoder.ready
    const { channelData, sampleRate } = decoder.decode(new Uint8Array(readFileSync(path)))
    decoder.free()
    return { samples: channelData[0], rate: sampleRate }
  }

  /** The length of the near-silent run starting at `from` and walking by `step`, in seconds. */
  function silentRun(samples: Float32Array, from: number, rate: number, step: 1 | -1): number {
    let run = 0
    for (let i = from; i >= 0 && i < samples.length; i += step) {
      if (Math.abs(samples[i]) > SILENT) break
      run++
    }
    return run / rate
  }

  it('is 22.05 kHz or better, 30-60 s of loop, and at most 600 KB', async () => {
    expect(statSync(path).size).toBeLessThanOrEqual(600 * 1000)
    const { samples, rate } = await decode()
    expect(rate).toBeGreaterThanOrEqual(22050)
    const loopSeconds = RAIN_LOOP_END - RAIN_LOOP_START
    expect(loopSeconds).toBeGreaterThanOrEqual(30)
    expect(loopSeconds).toBeLessThanOrEqual(60)
    expect(samples.length / rate).toBeGreaterThanOrEqual(RAIN_LOOP_END)
  })

  it('is real rain at both ends of the looped region, with no silent gap (> 5 ms)', async () => {
    const { samples, rate } = await decode()
    // A decoder may strip its delay (up to ~60 ms of it) or keep it: check both readings.
    for (const shift of [0, Math.round(0.06 * rate)]) {
      const start = Math.round(RAIN_LOOP_START * rate) - shift
      const end = Math.round(RAIN_LOOP_END * rate) - shift
      expect(silentRun(samples, start, rate, 1)).toBeLessThan(0.005)
      expect(silentRun(samples, end - 1, rate, -1)).toBeLessThan(0.005)
    }
  })

  it('peaks at or below -1 dBFS and has broadband hiss', async () => {
    const { samples } = await decode()
    let peak = 0
    for (const s of samples) peak = Math.max(peak, Math.abs(s))
    expect(20 * Math.log10(peak)).toBeLessThanOrEqual(-1)
    // The first difference approximates a high-pass: rain has plenty of energy up there.
    let total = 0
    let diff = 0
    for (let i = 1; i < samples.length; i++) {
      total += samples[i] * samples[i]
      diff += (samples[i] - samples[i - 1]) ** 2
    }
    expect(diff / total).toBeGreaterThan(0.5)
  })
})

describe('AudioControls', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function controls(source: 'rain' | 'youtube', paused: boolean) {
    const audio = fakeAudio()
    const onSourceChange = vi.fn()
    const view = render(
      <AudioControls
        source={source}
        paused={paused}
        rain={audio.rain}
        onSourceChange={onSourceChange}
      />,
    )
    return { ...audio, view, onSourceChange }
  }

  it('plays rain, pauses with the timer and resumes with it (AC8.2)', async () => {
    const audio = fakeAudio()
    const props = { source: 'rain' as const, rain: audio.rain, onSourceChange: vi.fn() }
    const view = render(<AudioControls {...props} paused={false} />)
    await vi.waitFor(() => expect(audio.sources).toHaveLength(1))
    view.rerender(<AudioControls {...props} paused />)
    expect(audio.sources[0].stop).toHaveBeenCalled()
    view.rerender(<AudioControls {...props} paused={false} />)
    await vi.waitFor(() => expect(audio.sources).toHaveLength(2))
    expect(audio.sources[1].stop).not.toHaveBeenCalled()
  })

  it('stops the rain when the controls go away at session end', async () => {
    const { view, sources } = controls('rain', false)
    await vi.waitFor(() => expect(sources).toHaveLength(1))
    view.unmount()
    expect(sources[0].stop).toHaveBeenCalled()
  })

  it('plays no rain for other sources', () => {
    const { sources } = controls('youtube', false)
    expect(sources).toHaveLength(0)
  })

  it('the rain volume slider and the Settings screen share one stored volume', () => {
    const settings = new SettingsStore()
    const audio = fakeAudio()
    const rain = new RainPlayer({
      alerts: audio.alerts,
      volume: new SettingsBackgroundVolumeStore(settings),
      fetchSound: audio.fetchSound,
    })
    render(
      <SettingsContext.Provider value={settings}>
        <AudioControls source="rain" paused rain={rain} onSourceChange={vi.fn()} />
        <SettingsScreen player={audio.alerts} />
      </SettingsContext.Provider>,
    )
    const rainSlider = screen.getByLabelText('Rain volume')
    const settingsSlider = screen.getByLabelText('Background audio volume')
    expect(rainSlider).toHaveValue('50')
    fireEvent.change(rainSlider, { target: { value: '30' } })
    expect(settings.values.background_volume).toBe(30)
    expect(settingsSlider).toHaveValue('30')
    fireEvent.change(settingsSlider, { target: { value: '70' } })
    expect(rainSlider).toHaveValue('70')
    expect(rain.volume).toBe(70)
  })

  it('ac8_7 suggests Rain when YouTube is chosen offline, and switches on request', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { onSourceChange } = controls('youtube', false)
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i)
    fireEvent.click(screen.getByRole('button', { name: 'Use Rain instead' }))
    expect(onSourceChange).toHaveBeenCalledWith('rain')
  })

  it('ac8_7 offers nothing while online, and reacts when the connection drops', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    controls('youtube', false)
    expect(screen.queryByRole('button', { name: 'Use Rain instead' })).not.toBeInTheDocument()
    online.mockReturnValue(false)
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(screen.getByRole('button', { name: 'Use Rain instead' })).toBeInTheDocument()
  })
})

describe('SessionSetup offline suggestion (AC8.7)', () => {
  it('suggests Rain when YouTube is picked offline and selects it on request', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<SessionSetup preferences={new MemoryPreferencesStore()} onStart={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Use Rain instead' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'YouTube' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Rain instead' }))
    expect(screen.getByRole('radio', { name: 'Rain' })).toBeChecked()
    vi.restoreAllMocks()
  })
})

describe('App rain', () => {
  function app(
    store: MemoryActiveSessionStore,
    audioStore: MemoryAudioSourceStore,
    state: AudioContextState = 'running',
  ) {
    const audio = fakeAudio(state)
    const controller = new TimerController({ store, saveRecord: () => undefined })
    const view = render(
      <App
        controller={controller}
        preferences={new MemoryPreferencesStore()}
        alerts={audio.alerts}
        rain={audio.rain}
        audioStore={audioStore}
      />,
    )
    return { ...audio, controller, view }
  }

  it('starts rain with the session, pauses with the timer and stops at session end', async () => {
    const { sources } = app(new MemoryActiveSessionStore(), new MemoryAudioSourceStore())
    fireEvent.click(await screen.findByRole('radio', { name: 'Rain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    await vi.waitFor(() => expect(sources).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await vi.waitFor(() => expect(sources[0].stop).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await vi.waitFor(() => expect(sources).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await screen.findByRole('heading', { name: 'Session not saved' })
    expect(sources[1].stop).toHaveBeenCalled()
  })

  it('restores the chosen source and the rain after a reload', async () => {
    const store = new MemoryActiveSessionStore()
    const audioStore = new MemoryAudioSourceStore()
    const first = app(store, audioStore)
    fireEvent.click(await screen.findByRole('radio', { name: 'Rain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    first.view.unmount()

    const second = app(store, audioStore)
    await screen.findByRole('timer')
    expect(screen.getByRole('region', { name: 'Background audio' })).toHaveTextContent('Rain')
    await vi.waitFor(() => expect(second.sources).toHaveLength(1))
  })

  it('after a reload with a locked context, the rain begins on the first click', async () => {
    const store = new MemoryActiveSessionStore()
    const audioStore = new MemoryAudioSourceStore()
    const first = app(store, audioStore)
    fireEvent.click(await screen.findByRole('radio', { name: 'Rain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    first.view.unmount()

    const second = app(store, audioStore, 'suspended')
    await screen.findByRole('timer')
    await vi.waitFor(() => expect(second.sources).toHaveLength(1)) // queued on the locked context
    expect(second.context.state).toBe('suspended')
    fireEvent.click(screen.getByRole('timer'))
    expect(second.context.resume).toHaveBeenCalled()
    await vi.waitFor(() => expect(second.context.state).toBe('running'))
    expect(second.sources).toHaveLength(1)
  })

  it('forgets the source when the session ends', async () => {
    const audioStore = new MemoryAudioSourceStore()
    app(new MemoryActiveSessionStore(), audioStore)
    fireEvent.click(await screen.findByRole('radio', { name: 'Rain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    expect(audioStore.load()).toBe('rain')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await vi.waitFor(() => expect(audioStore.load()).toBe('none'))
  })
})
