// Backs the setup screen's `PreferencesStore` (#14) and the alert player's `AlertVolumeStore`
// (#16) and the rain player's `BackgroundVolumeStore` (#17) with the settings store, so both follow the Settings API and its offline cache.

import { clampVolume, type AlertVolumeStore } from '../sounds/alerts.ts'
import { clampBackgroundVolume, type BackgroundVolumeStore } from '../sounds/rain.ts'
import {
  DEFAULT_PREFERENCES,
  type Preferences,
  type PreferencesStore,
} from '../setup/preferences.ts'
import { validateConfig, type PomodoroConfig } from '../timer/index.ts'
import type { ApiPomodoroConfig } from './api.ts'
import type { SettingsStore } from './store.ts'

export function toApiPomodoro(config: PomodoroConfig): ApiPomodoroConfig {
  return {
    focus_minutes: config.focusMinutes,
    break_minutes: config.breakMinutes,
    blocks: config.blocks,
    long_break_enabled: config.longBreakEnabled,
    long_break_minutes: config.longBreakMinutes,
  }
}

export function fromApiPomodoro(config: ApiPomodoroConfig | null): PomodoroConfig {
  if (!config) return DEFAULT_PREFERENCES.pomodoro
  const candidate: PomodoroConfig = {
    mode: 'pomodoro',
    focusMinutes: config.focus_minutes,
    breakMinutes: config.break_minutes,
    blocks: config.blocks,
    longBreakEnabled: config.long_break_enabled,
    longBreakMinutes: config.long_break_minutes,
  }
  return validateConfig(candidate).length === 0 ? candidate : DEFAULT_PREFERENCES.pomodoro
}

export class SettingsPreferencesStore implements PreferencesStore {
  readonly #settings: SettingsStore

  constructor(settings: SettingsStore) {
    this.#settings = settings
  }

  load(): Preferences {
    const { last_tag, pomodoro_config } = this.#settings.values
    return { tag: last_tag ?? 'work', pomodoro: fromApiPomodoro(pomodoro_config) }
  }

  save(preferences: Preferences): void {
    const current = this.load()
    const patch: Parameters<SettingsStore['update']>[0] = {}
    if (preferences.tag !== current.tag) patch.last_tag = preferences.tag
    if (JSON.stringify(preferences.pomodoro) !== JSON.stringify(current.pomodoro)) {
      patch.pomodoro_config = toApiPomodoro(preferences.pomodoro)
    }
    this.#settings.update(patch)
  }
}

export class SettingsAlertVolumeStore implements AlertVolumeStore {
  readonly #settings: SettingsStore

  constructor(settings: SettingsStore) {
    this.#settings = settings
  }

  load(): number {
    return this.#settings.values.alert_volume
  }

  save(volume: number): void {
    this.#settings.update({ alert_volume: clampVolume(volume) })
  }
}

export class SettingsBackgroundVolumeStore implements BackgroundVolumeStore {
  readonly #settings: SettingsStore

  constructor(settings: SettingsStore) {
    this.#settings = settings
  }

  load(): number {
    return this.#settings.values.background_volume
  }

  save(volume: number): void {
    this.#settings.update({ background_volume: clampBackgroundVolume(volume) })
  }

  subscribe(listener: () => void): () => void {
    return this.#settings.subscribe(listener)
  }
}
