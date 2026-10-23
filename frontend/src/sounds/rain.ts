// Background rain (F8): a looping recording played with the Web Audio API.
//
// An `AudioBufferSourceNode` with `loop = true` repeats the decoded buffer sample-accurately, so
// there is no gap at the seam (HTMLAudio's `loop` leaves one). The file is in `public/audio/`,
// which the service worker (#19) precaches, so rain plays offline (AC13.1).
//
// Rain shares the alert player's audio context, so the same first-gesture unlock covers both.
// It never touches `navigator.audioSession.type`: like the alerts, it follows the iOS silent
// switch (ruling on #16).

import type { AlertPlayer } from './alerts.ts'

export const RAIN_URL = `${import.meta.env.BASE_URL}audio/rain.wav`

/** Settings API `background_volume` default (0-100). */
export const DEFAULT_BACKGROUND_VOLUME = 50
export const BACKGROUND_VOLUME_KEY = 'ineedtofocus.backgroundVolume'

export function clampBackgroundVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BACKGROUND_VOLUME
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** Where the background volume (0-100) comes from; the Settings API backs it later (#22). */
export interface BackgroundVolumeStore {
  load(): number
  save(volume: number): void
}

export class LocalBackgroundVolumeStore implements BackgroundVolumeStore {
  readonly #storage: Storage

  constructor(storage: Storage = window.localStorage) {
    this.#storage = storage
  }

  load(): number {
    try {
      const raw = this.#storage.getItem(BACKGROUND_VOLUME_KEY)
      if (raw === null || raw.trim() === '') return DEFAULT_BACKGROUND_VOLUME
      return clampBackgroundVolume(Number(raw))
    } catch {
      return DEFAULT_BACKGROUND_VOLUME
    }
  }

  save(volume: number): void {
    try {
      this.#storage.setItem(BACKGROUND_VOLUME_KEY, String(clampBackgroundVolume(volume)))
    } catch {
      // Remembering is a convenience.
    }
  }
}

export class MemoryBackgroundVolumeStore implements BackgroundVolumeStore {
  #volume: number

  constructor(initial = DEFAULT_BACKGROUND_VOLUME) {
    this.#volume = initial
  }

  load(): number {
    return this.#volume
  }

  save(volume: number): void {
    this.#volume = clampBackgroundVolume(volume)
  }
}

export interface RainPlayerOptions {
  /** Supplies the shared audio context. */
  alerts: Pick<AlertPlayer, 'audioContext'>
  volume: BackgroundVolumeStore
  /** Injectable for tests. */
  fetchSound?: (url: string) => Promise<ArrayBuffer>
}

async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load ${url}`)
  return response.arrayBuffer()
}

export class RainPlayer {
  readonly #alerts: Pick<AlertPlayer, 'audioContext'>
  readonly #store: BackgroundVolumeStore
  readonly #fetchSound: (url: string) => Promise<ArrayBuffer>
  #buffer: Promise<AudioBuffer> | null = null
  #wanted = false
  #source: AudioBufferSourceNode | null = null
  #gain: GainNode | null = null

  constructor(options: RainPlayerOptions) {
    this.#alerts = options.alerts
    this.#store = options.volume
    this.#fetchSound = options.fetchSound ?? defaultFetch
  }

  /** True while the loop is meant to be playing (it may still be waiting for a gesture). */
  get playing(): boolean {
    return this.#wanted
  }

  /** The background volume (0-100). The store is the single source of truth. */
  get volume(): number {
    return this.#store.load()
  }

  setVolume(value: number): void {
    this.#store.save(value)
    if (this.#gain) this.#gain.gain.value = this.#store.load() / 100
  }

  #load(context: AudioContext): Promise<AudioBuffer> {
    if (!this.#buffer) {
      const pending = this.#fetchSound(RAIN_URL).then((data) => context.decodeAudioData(data))
      // A failed load (offline before the first cache) may be retried on the next play.
      pending.catch(() => {
        if (this.#buffer === pending) this.#buffer = null
      })
      this.#buffer = pending
    }
    return this.#buffer
  }

  /**
   * Starts (or resumes) the loop. Never throws: a missing recording or blocked audio must not
   * stop a session. If the context is still locked, the loop begins when it is unlocked.
   */
  async play(): Promise<void> {
    this.#wanted = true
    try {
      const context = this.#alerts.audioContext()
      if (context === null) return
      const buffer = await this.#load(context)
      if (!this.#wanted || this.#source !== null) return // stopped meanwhile, or already playing
      const source = context.createBufferSource()
      const gain = context.createGain()
      source.buffer = buffer
      source.loop = true
      gain.gain.value = this.#store.load() / 100
      source.connect(gain)
      gain.connect(context.destination)
      source.start()
      this.#source = source
      this.#gain = gain
    } catch {
      // Blocked or unavailable audio: stay silent.
    }
  }

  /** Pauses or stops the loop; `play()` starts it again. */
  pause(): void {
    this.#wanted = false
    const source = this.#source
    this.#source = null
    this.#gain = null
    if (source) {
      try {
        source.stop()
        source.disconnect()
      } catch {
        // Already stopped.
      }
    }
  }

  stop(): void {
    this.pause()
  }
}
