/// <reference types="node" />
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App.tsx'
import { MemoryPreferencesStore } from '../setup/preferences.ts'
import SessionSetup from '../setup/SessionSetup.tsx'
import { MemoryActiveSessionStore, TimerController } from '../timer/index.ts'
import { AlertPlayer, MemoryAlertVolumeStore } from './alerts.ts'
import AudioControls from './AudioControls.tsx'
import { AUDIO_SOURCE_KEY, LocalAudioSourceStore, MemoryAudioSourceStore } from './audioSource.ts'
import {
  BACKGROUND_VOLUME_KEY,
  LocalBackgroundVolumeStore,
  MemoryBackgroundVolumeStore,
  RainPlayer,
} from './rain.ts'

function fakeAudio() {
  const sources: {
    buffer: unknown
    loop: boolean
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
  }[] = []
  const gains: { gain: { value: number }; connect: ReturnType<typeof vi.fn> }[] = []
  const context = {
    state: 'running' as AudioContextState,
    destination: {},
    resume: vi.fn(async () => undefined),
    decodeAudioData: vi.fn(async (data: ArrayBuffer) => ({ bytes: data.byteLength })),
    createGain: vi.fn(() => {
      const gain = { gain: { value: 0 }, connect: vi.fn() }
      gains.push(gain)
      return gain
    }),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null as unknown,
        loop: false,
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
    expect(fetchSound).toHaveBeenCalledWith(expect.stringContaining('audio/rain.wav'))
    expect(sources).toHaveLength(1)
    expect(sources[0].loop).toBe(true)
    expect(sources[0].start).toHaveBeenCalled()
    expect(gains[0].gain.value).toBe(0.5)
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
  it('defaults the background volume to 50 and clamps bad values', () => {
    localStorage.clear()
    const store = new LocalBackgroundVolumeStore()
    expect(store.load()).toBe(50)
    store.save(140)
    expect(localStorage.getItem(BACKGROUND_VOLUME_KEY)).toBe('100')
    localStorage.setItem(BACKGROUND_VOLUME_KEY, 'loud')
    expect(store.load()).toBe(50)
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

describe('rain.wav (AC8.3)', () => {
  const path = resolve(process.cwd(), 'public/audio/rain.wav')

  it('is 30-60 s, at most 600 KB, and mono 16-bit PCM', () => {
    expect(statSync(path).size).toBeLessThanOrEqual(600 * 1000)
    const wav = readFileSync(path)
    const rate = wav.readUInt32LE(24)
    const seconds = wav.readUInt32LE(40) / 2 / rate
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(seconds).toBeGreaterThanOrEqual(30)
    expect(seconds).toBeLessThanOrEqual(60)
  })

  it('loops without a seam: the last samples step into the first like any neighbours', () => {
    const wav = readFileSync(path)
    const n = wav.readUInt32LE(40) / 2
    const at = (i: number) => wav.readInt16LE(44 + 2 * (((i % n) + n) % n))
    let typicalStep = 0
    for (let i = 0; i < 4000; i++) typicalStep += Math.abs(at(i + 1) - at(i))
    typicalStep /= 4000
    const seam = Math.abs(at(0) - at(n - 1))
    expect(seam).toBeLessThan(typicalStep * 6)
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

  it('has a rain volume slider that changes the background volume', async () => {
    const { rain } = controls('rain', false)
    fireEvent.change(screen.getByLabelText('Rain volume'), { target: { value: '30' } })
    expect(rain.volume).toBe(30)
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
  function app(store: MemoryActiveSessionStore, audioStore: MemoryAudioSourceStore) {
    const audio = fakeAudio()
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
