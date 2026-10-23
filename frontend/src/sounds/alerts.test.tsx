import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TimerEvent } from '../timer/index.ts'
import {
  AlertPlayer,
  LocalAlertVolumeStore,
  MemoryAlertVolumeStore,
  soundForEvents,
  ALERT_VOLUME_KEY,
} from './alerts.ts'
import SoundPreview from './SoundPreview.tsx'

const phaseChange = (skipped: boolean): TimerEvent => ({
  type: 'phase-change',
  at: 0,
  atActiveMs: 0,
  from: 'break',
  to: 'focus',
  block: 2,
  skipped,
})
const reminder: TimerEvent = { type: 'reminder', at: 0, atActiveMs: 0, count: 1 }
const sessionEnd = (reason: 'completed' | 'time-limit'): TimerEvent => ({
  type: 'session-end',
  at: 0,
  atActiveMs: 0,
  reason,
})

describe('soundForEvents', () => {
  it('rings the bell on automatic phase changes and session ends', () => {
    expect(soundForEvents([phaseChange(false)])).toBe('bell')
    expect(soundForEvents([sessionEnd('completed')])).toBe('bell')
    expect(soundForEvents([sessionEnd('time-limit')])).toBe('bell')
  })

  it('stays silent when the user skipped the break', () => {
    expect(soundForEvents([phaseChange(true)])).toBeNull()
  })

  it('chimes on a reminder', () => {
    expect(soundForEvents([reminder])).toBe('chime')
  })

  it('plays one sound for a batch, the bell winning over the chime', () => {
    expect(soundForEvents([reminder, reminder, sessionEnd('time-limit')])).toBe('bell')
    expect(soundForEvents([phaseChange(true), reminder])).toBe('chime')
  })

  it('is silent with no events', () => {
    expect(soundForEvents([])).toBeNull()
  })
})

function fakeAudio(state: AudioContextState = 'suspended') {
  const gain = { gain: { value: 0 }, connect: vi.fn() }
  const sources: {
    buffer: unknown
    connect: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
  }[] = []
  const context = {
    state,
    destination: {},
    resume: vi.fn(async () => {
      context.state = 'running'
    }),
    decodeAudioData: vi.fn(async (data: ArrayBuffer) => ({ bytes: data.byteLength })),
    createGain: vi.fn(() => gain),
    createBufferSource: vi.fn(() => {
      const source = { buffer: null as unknown, connect: vi.fn(), start: vi.fn() }
      sources.push(source)
      return source
    }),
  }
  const fetchSound = vi.fn(async (url: string) => new ArrayBuffer(url.includes('bell') ? 2 : 1))
  return { context, gain, sources, fetchSound }
}

function player(volume = 80, audio = fakeAudio('running')) {
  const alerts = new AlertPlayer({
    volume: new MemoryAlertVolumeStore(volume),
    createContext: () => audio.context as unknown as AudioContext,
    fetchSound: audio.fetchSound,
  })
  return { alerts, ...audio }
}

describe('AlertPlayer', () => {
  it('unlock resumes the audio context and preloads both sounds', async () => {
    const { alerts, context, fetchSound } = player(80, fakeAudio('suspended'))
    await alerts.unlock()
    expect(context.resume).toHaveBeenCalled()
    expect(fetchSound).toHaveBeenCalledTimes(2)
  })

  it('plays the sound at the alert volume', async () => {
    const { alerts, gain, sources } = player(50)
    await alerts.play('bell')
    expect(sources).toHaveLength(1)
    expect(sources[0].start).toHaveBeenCalled()
    expect(gain.gain.value).toBe(0.5)
  })

  it('does not play at volume 0', async () => {
    const { alerts, sources } = player(0)
    await alerts.play('chime')
    expect(sources).toHaveLength(0)
  })

  it('handleEvents rings the bell for an automatic change but not for a skip', async () => {
    const { alerts, sources } = player()
    alerts.handleEvents([phaseChange(true)])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sources).toHaveLength(0)
    alerts.handleEvents([phaseChange(false)])
    await vi.waitFor(() => expect(sources).toHaveLength(1))
  })

  it('drops a sound while audio is locked instead of parking it (no pile-up later)', async () => {
    const audio = fakeAudio('suspended')
    // A blocked context: resume() stays pending until a gesture lets it start.
    let release: () => void = () => undefined
    audio.context.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            audio.context.state = 'running'
            resolve()
          }
        }),
    )
    const { alerts, sources } = player(80, audio)
    await alerts.play('bell')
    await alerts.play('chime')
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sources).toHaveLength(0)
    await alerts.play('bell') // unlocked now: plays
    expect(sources).toHaveLength(1)
  })

  it('unlockOnGesture unlocks on the first press, then stops listening', async () => {
    const { alerts, context } = player(80, fakeAudio('suspended'))
    const target = new EventTarget()
    alerts.unlockOnGesture(target)
    expect(context.resume).not.toHaveBeenCalled()
    target.dispatchEvent(new Event('pointerdown'))
    expect(context.resume).toHaveBeenCalledTimes(1)
    target.dispatchEvent(new Event('keydown'))
    expect(context.resume).toHaveBeenCalledTimes(1)
  })

  it('never throws when audio fails', async () => {
    const audio = fakeAudio('running')
    audio.fetchSound.mockRejectedValue(new Error('offline'))
    const { alerts } = player(80, audio)
    await expect(alerts.play('bell')).resolves.toBeUndefined()
  })
})

describe('LocalAlertVolumeStore', () => {
  it('defaults to 80 and clamps what was stored', () => {
    const storage = window.localStorage
    storage.removeItem(ALERT_VOLUME_KEY)
    const store = new LocalAlertVolumeStore(storage)
    expect(store.load()).toBe(80)
    store.save(35)
    expect(store.load()).toBe(35)
    storage.setItem(ALERT_VOLUME_KEY, '900')
    expect(store.load()).toBe(100)
    storage.setItem(ALERT_VOLUME_KEY, 'loud')
    expect(store.load()).toBe(80)
    storage.removeItem(ALERT_VOLUME_KEY)
  })
})

describe('SoundPreview', () => {
  it('previews each sound and saves the alert volume', async () => {
    const { alerts, sources } = player()
    const volume = new MemoryAlertVolumeStore(80)
    render(<SoundPreview player={alerts} volume={volume} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview chime' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview bell' }))
    await vi.waitFor(() => expect(sources).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Alert volume'), { target: { value: '30' } })
    expect(volume.load()).toBe(30)
  })
})
