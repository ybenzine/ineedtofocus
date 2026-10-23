// Remembers the background audio chosen for the active session, so a reload restores it (#17).
// Kept apart from the timer's stored session: that schema is the timer's own.

import { AUDIO_SOURCES, type AudioSource } from '../setup/options.ts'

export const AUDIO_SOURCE_KEY = 'ineedtofocus.audioSource'

export interface AudioSourceStore {
  load(): AudioSource
  save(source: AudioSource): void
  clear(): void
}

export class LocalAudioSourceStore implements AudioSourceStore {
  readonly #storage: Storage

  constructor(storage: Storage = window.localStorage) {
    this.#storage = storage
  }

  load(): AudioSource {
    try {
      const raw = this.#storage.getItem(AUDIO_SOURCE_KEY)
      return (AUDIO_SOURCES as readonly string[]).includes(raw ?? '')
        ? (raw as AudioSource)
        : 'none'
    } catch {
      return 'none'
    }
  }

  save(source: AudioSource): void {
    try {
      this.#storage.setItem(AUDIO_SOURCE_KEY, source)
    } catch {
      // Without storage the choice is lost on reload; the session itself is unaffected.
    }
  }

  clear(): void {
    try {
      this.#storage.removeItem(AUDIO_SOURCE_KEY)
    } catch {
      // Nothing to clear.
    }
  }
}

export class MemoryAudioSourceStore implements AudioSourceStore {
  #source: AudioSource = 'none'

  load(): AudioSource {
    return this.#source
  }

  save(source: AudioSource): void {
    this.#source = source
  }

  clear(): void {
    this.#source = 'none'
  }
}
