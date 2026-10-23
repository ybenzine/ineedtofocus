// Remembers the background audio chosen for the active session, so a reload restores it (#17).
// Kept apart from the timer's stored session: that schema is the timer's own.

import { AUDIO_SOURCES, type AudioSource } from '../setup/options.ts'

export const AUDIO_SOURCE_KEY = 'ineedtofocus.audioSource'
/** The YouTube link of the active session (#18), kept and cleared with the audio source. */
export const YOUTUBE_LINK_KEY = 'ineedtofocus.youtubeLink'

export interface YoutubeLinkStore {
  load(): string | null
  save(url: string): void
}

export class LocalYoutubeLinkStore implements YoutubeLinkStore {
  readonly #storage: Storage

  constructor(storage: Storage = window.localStorage) {
    this.#storage = storage
  }

  load(): string | null {
    try {
      return this.#storage.getItem(YOUTUBE_LINK_KEY)
    } catch {
      return null
    }
  }

  save(url: string): void {
    try {
      this.#storage.setItem(YOUTUBE_LINK_KEY, url)
    } catch {
      // The link is lost on reload; the session itself is unaffected.
    }
  }
}

export class MemoryYoutubeLinkStore implements YoutubeLinkStore {
  #url: string | null = null

  load(): string | null {
    return this.#url
  }

  save(url: string): void {
    this.#url = url
  }
}

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
      this.#storage.removeItem(YOUTUBE_LINK_KEY)
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
