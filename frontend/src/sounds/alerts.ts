// Alert sounds (F5): the interval chime and the end bell, played with the Web Audio API.
//
// The bell rings only when the timer moves on by itself: a phase reaching zero, the session
// completing, the 12 h auto-stop. A skipped break or an early stop is the user's own action and
// stays silent (decision on #13). The chime marks an unlimited-timer reminder.

import type { TimerEvent } from '../timer/index.ts'

export type SoundName = 'chime' | 'bell'

/**
 * Files in `public/`, so the service worker (#19) can precache them. Relative to the app's base.
 */
export const SOUND_URLS: Record<SoundName, string> = {
  chime: `${import.meta.env.BASE_URL}sounds/chime.wav`,
  bell: `${import.meta.env.BASE_URL}sounds/bell.wav`,
}

export const DEFAULT_ALERT_VOLUME = 80

/**
 * The sound a batch of due events calls for, or null for silence. One sound per batch: several
 * events can fall due together after the tab was in the background, and a pile-up is not calm.
 * The bell wins over the chime.
 */
export function soundForEvents(events: readonly TimerEvent[]): SoundName | null {
  let sound: SoundName | null = null
  for (const event of events) {
    if (event.type === 'session-end') return 'bell'
    if (event.type === 'phase-change' && !event.skipped) return 'bell'
    if (event.type === 'reminder') sound = 'chime'
  }
  return sound
}

/** Where the alert volume (0–100) comes from; the Settings API backs it later (#12, #22). */
export interface AlertVolumeStore {
  load(): number
  save(volume: number): void
}

export const ALERT_VOLUME_KEY = 'ineedtofocus.alertVolume'

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ALERT_VOLUME
  return Math.min(100, Math.max(0, Math.round(value)))
}

export class LocalAlertVolumeStore implements AlertVolumeStore {
  readonly #storage: Storage

  constructor(storage: Storage = window.localStorage) {
    this.#storage = storage
  }

  load(): number {
    try {
      const raw = this.#storage.getItem(ALERT_VOLUME_KEY)
      if (raw === null || raw.trim() === '') return DEFAULT_ALERT_VOLUME
      return clampVolume(Number(raw))
    } catch {
      return DEFAULT_ALERT_VOLUME
    }
  }

  save(volume: number): void {
    try {
      this.#storage.setItem(ALERT_VOLUME_KEY, String(clampVolume(volume)))
    } catch {
      // Remembering is a convenience.
    }
  }
}

export class MemoryAlertVolumeStore implements AlertVolumeStore {
  #volume: number

  constructor(initial = DEFAULT_ALERT_VOLUME) {
    this.#volume = initial
  }

  load(): number {
    return this.#volume
  }

  save(volume: number): void {
    this.#volume = clampVolume(volume)
  }
}

export interface AlertPlayerOptions {
  volume: AlertVolumeStore
  /** Injectable for tests. */
  createContext?: () => AudioContext
  fetchSound?: (url: string) => Promise<ArrayBuffer>
}

function defaultContext(): AudioContext {
  return new AudioContext()
}

async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load ${url}`)
  return response.arrayBuffer()
}

export class AlertPlayer {
  readonly #volume: AlertVolumeStore
  readonly #createContext: () => AudioContext
  readonly #fetchSound: (url: string) => Promise<ArrayBuffer>
  #context: AudioContext | null = null
  readonly #buffers = new Map<SoundName, Promise<AudioBuffer>>()

  constructor(options: AlertPlayerOptions) {
    this.#volume = options.volume
    this.#createContext = options.createContext ?? defaultContext
    this.#fetchSound = options.fetchSound ?? defaultFetch
  }

  #ensureContext(): AudioContext | null {
    if (this.#context === null) {
      if (this.#createContext === defaultContext && typeof AudioContext === 'undefined') {
        return null // no Web Audio here: the timer still works, silently
      }
      this.#context = this.#createContext()
    }
    return this.#context
  }

  /**
   * Browsers keep audio locked until a user gesture. Call this synchronously from the Start
   * press: it creates the audio context, resumes it and begins loading the sounds.
   */
  unlock(): Promise<void> {
    const context = this.#ensureContext()
    if (context === null) return Promise.resolve()
    const resumed =
      context.state === 'running' ? Promise.resolve() : context.resume().catch(() => undefined)
    for (const name of Object.keys(SOUND_URLS) as SoundName[]) {
      void this.#buffer(name).catch(() => undefined)
    }
    return resumed
  }

  /**
   * For a session restored after a reload, where no Start press unlocked audio: unlocks on the
   * next press or key, then stops listening. Returns the cleanup.
   */
  unlockOnGesture(target: EventTarget = window): () => void {
    const events = ['pointerdown', 'keydown']
    const stop = () => events.forEach((name) => target.removeEventListener(name, handler))
    const handler = () => {
      void this.unlock()
      stop()
    }
    events.forEach((name) => target.addEventListener(name, handler))
    return stop
  }

  #buffer(name: SoundName): Promise<AudioBuffer> {
    const context = this.#ensureContext()
    if (context === null) return Promise.reject(new Error('Web Audio is not available'))
    let pending = this.#buffers.get(name)
    if (!pending) {
      pending = this.#fetchSound(SOUND_URLS[name]).then((data) => context.decodeAudioData(data))
      // A failed load (offline before the first cache) may be retried on the next play.
      pending.catch(() => this.#buffers.delete(name))
      this.#buffers.set(name, pending)
    }
    return pending
  }

  /** Plays one sound at the alert volume. Never throws: a missing sound must not stop a session. */
  async play(name: SoundName): Promise<void> {
    try {
      const context = this.#ensureContext()
      if (context === null) return
      const volume = this.#volume.load() / 100
      if (volume <= 0) return
      if (context.state !== 'running') {
        // Not unlocked (no gesture yet): try to resume without waiting, and drop this sound.
        // Waiting would park it until some later gesture, then ring it at the wrong moment.
        void context.resume().catch(() => undefined)
        return
      }
      const buffer = await this.#buffer(name)
      const source = context.createBufferSource()
      const gain = context.createGain()
      source.buffer = buffer
      gain.gain.value = volume
      source.connect(gain)
      gain.connect(context.destination)
      source.start()
    } catch {
      // Blocked or unavailable audio: stay silent.
    }
  }

  /** Reacts to the timer's events; the handler for `TimerScreen`'s `onEvents`. */
  handleEvents = (events: readonly TimerEvent[]): void => {
    const sound = soundForEvents(events)
    if (sound !== null) void this.play(sound)
  }
}
