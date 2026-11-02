// Backs the setup screen's `PreferencesStore` (#14) and the alert player's `AlertVolumeStore`
// (#16) and the rain player's `BackgroundVolumeStore` (#17), both device settings (#336).

import { clampVolume, type AlertVolumeStore } from '../sounds/alerts.ts'
import { clampBackgroundVolume, type BackgroundVolumeStore } from '../sounds/rain.ts'
import {
  DEFAULT_PREFERENCES,
  type Preferences,
  type PreferencesStore,
} from '../setup/preferences.ts'
import { recentCustomMinutes } from '../setup/options.ts'
import { validateConfig, type PomodoroConfig } from '../timer/index.ts'
import type { ApiPomodoroConfig } from './api.ts'
import type { SettingsStore } from './store.ts'
import type { SoundLevelsStore } from './soundLevels.ts'

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
    const { last_tag, pomodoro_config, countdown_recent_minutes } = this.#settings.values
    return {
      tag: last_tag ?? 'work',
      pomodoro: fromApiPomodoro(pomodoro_config),
      countdownRecent: countdown_recent_minutes,
    }
  }

  save(preferences: Preferences): void {
    const current = this.load()
    const patch: Parameters<SettingsStore['update']>[0] = {}
    if (preferences.tag !== current.tag) patch.last_tag = preferences.tag
    if (JSON.stringify(preferences.pomodoro) !== JSON.stringify(current.pomodoro)) {
      patch.pomodoro_config = toApiPomodoro(preferences.pomodoro)
    }
    // Left out (older callers) means unchanged.
    if (preferences.countdownRecent !== undefined) {
      const recent = recentCustomMinutes(preferences.countdownRecent)
      if (recent !== current.countdownRecent) patch.countdown_recent_minutes = recent
    }
    this.#settings.update(patch)
  }
}

/** The alert volume is a device setting (#336): it never goes through the settings sync. */
export class DeviceAlertVolumeStore implements AlertVolumeStore {
  readonly #levels: SoundLevelsStore

  constructor(levels: SoundLevelsStore) {
    this.#levels = levels
  }

  load(): number {
    return this.#levels.alert
  }

  save(volume: number): void {
    this.#levels.set('alert', clampVolume(volume))
  }
}

export class DeviceBackgroundVolumeStore implements BackgroundVolumeStore {
  readonly #levels: SoundLevelsStore

  constructor(levels: SoundLevelsStore) {
    this.#levels = levels
  }

  load(): number {
    return this.#levels.background
  }

  save(volume: number): void {
    this.#levels.set('background', clampBackgroundVolume(volume))
  }

  subscribe(listener: () => void): () => void {
    return this.#levels.subscribe(listener)
  }
}
