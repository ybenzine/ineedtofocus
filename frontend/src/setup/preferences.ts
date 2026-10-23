// What the setup screen remembers between sessions (AC7.2, AC12.5).
//
// Kept behind `PreferencesStore` so the Settings API (#12, wired up in #22) can back it later;
// until then it lives on the device in localStorage.

import {
  DEFAULT_POMODORO,
  TAGS,
  validateConfig,
  type PomodoroConfig,
  type Tag,
} from '../timer/index.ts'

export interface Preferences {
  /** Last-used tag; Work for a new user (AC7.2). */
  tag: Tag
  /** Last-used Pomodoro configuration; the AC3.1 defaults for a new user. */
  pomodoro: PomodoroConfig
}

export const DEFAULT_PREFERENCES: Preferences = { tag: 'work', pomodoro: DEFAULT_POMODORO }

export interface PreferencesStore {
  load(): Preferences
  save(preferences: Preferences): void
}

export const PREFERENCES_KEY = 'ineedtofocus.preferences'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Reads what was stored, falling back to the defaults for anything missing or invalid. */
export function parsePreferences(raw: string | null): Preferences {
  if (raw === null) return DEFAULT_PREFERENCES
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return DEFAULT_PREFERENCES
  }
  if (!isObject(value)) return DEFAULT_PREFERENCES
  const tag =
    typeof value.tag === 'string' && (TAGS as readonly string[]).includes(value.tag)
      ? (value.tag as Tag)
      : DEFAULT_PREFERENCES.tag
  let pomodoro = DEFAULT_PREFERENCES.pomodoro
  if (isObject(value.pomodoro)) {
    const candidate = { ...value.pomodoro, mode: 'pomodoro' } as unknown as PomodoroConfig
    if (validateConfig(candidate).length === 0) pomodoro = candidate
  }
  return { tag, pomodoro }
}

export class LocalPreferencesStore implements PreferencesStore {
  readonly #storage: Storage

  constructor(storage: Storage = window.localStorage) {
    this.#storage = storage
  }

  load(): Preferences {
    try {
      return parsePreferences(this.#storage.getItem(PREFERENCES_KEY))
    } catch {
      return DEFAULT_PREFERENCES
    }
  }

  save(preferences: Preferences): void {
    try {
      this.#storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
    } catch {
      // Remembering is a convenience; a full or blocked storage must not stop a session.
    }
  }
}

export class MemoryPreferencesStore implements PreferencesStore {
  #value: Preferences

  constructor(initial: Preferences = DEFAULT_PREFERENCES) {
    this.#value = initial
  }

  load(): Preferences {
    return this.#value
  }

  save(preferences: Preferences): void {
    this.#value = preferences
  }
}
