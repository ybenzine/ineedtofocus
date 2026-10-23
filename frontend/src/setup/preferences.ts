// What the setup screen remembers between sessions (AC7.2, AC12.5).
//
// Kept behind `PreferencesStore`; the app backs it with the Settings API and its device cache
// (`SettingsPreferencesStore`, #22).

import { DEFAULT_POMODORO, type PomodoroConfig, type Tag } from '../timer/index.ts'

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
