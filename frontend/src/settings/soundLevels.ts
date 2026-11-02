// The alert and background volumes are device settings (AC12.2, #336): they never sync, belong to
// no user, and stay through sign-out, account deletion, a different user signing in and a guest's
// sign-in. They live in two keys of their own: not under a user id, not in the sign-out clear
// registry (`auth/localData.ts`), not under `ineedtofocus.anonymous.` (so `clearAnonymousData()`
// leaves them) and not the legacy `ineedtofocus.alertVolume`.

import { ANON_SETTINGS_KEY } from '../anonymous/keys.ts'

export const ALERT_VOLUME_KEY = 'ineedtofocus.device.alertVolume'
export const BACKGROUND_VOLUME_KEY = 'ineedtofocus.device.backgroundVolume'
export const DEFAULT_ALERT_LEVEL = 80
export const DEFAULT_BACKGROUND_LEVEL = 50

export interface SoundLevels {
  alert: number
  background: number
}

type Which = keyof SoundLevels

const KEYS: Record<Which, string> = { alert: ALERT_VOLUME_KEY, background: BACKGROUND_VOLUME_KEY }
const DEFAULTS: SoundLevels = { alert: DEFAULT_ALERT_LEVEL, background: DEFAULT_BACKGROUND_LEVEL }
/** The deprecated server settings a device is seeded from. */
const settingsField = (which: Which): string =>
  which === 'alert' ? 'alert_volume' : 'background_volume'

function level(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : null
}

export class SoundLevelsStore {
  readonly #storage: Storage | null
  #state: SoundLevels
  readonly #listeners = new Set<() => void>()

  constructor(storage: Storage | null = null) {
    this.#storage = storage
    this.#state = this.#read(DEFAULTS)
  }

  #stored(which: Which): number | null {
    try {
      const raw = this.#storage?.getItem(KEYS[which])
      return raw == null ? null : level(JSON.parse(raw))
    } catch {
      return null
    }
  }

  #read(previous: SoundLevels): SoundLevels {
    const state = {
      alert: this.#stored('alert') ?? DEFAULTS.alert,
      background: this.#stored('background') ?? DEFAULTS.background,
    }
    return state.alert === previous.alert && state.background === previous.background
      ? previous
      : state
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }

  /** Takes what is stored now (another tab's change, a seed); tells listeners if it differs. */
  #refresh(): void {
    const next = this.#read(this.#state)
    if (next === this.#state) return
    this.#state = next
    this.#notify()
  }

  /** Stable between changes, for `useSyncExternalStore`. */
  readonly getState = (): SoundLevels => this.#state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get alert(): number {
    return this.#state.alert
  }

  get background(): number {
    return this.#state.background
  }

  set(which: Which, value: number): void {
    const next = level(Math.round(value))
    if (next === null || next === this.#state[which]) return
    try {
      this.#storage?.setItem(KEYS[which], JSON.stringify(next))
    } catch {
      // Blocked or full storage: the level still applies until the page closes.
    }
    this.#state = { ...this.#state, [which]: next }
    this.#notify()
  }

  /**
   * Gives a level the device doesn't have yet a value, once: from the guest settings
   * (`ineedtofocus.anonymous.settings`), else from `fallback` (the account's settings, passed
   * only after a real load of them, never the pre-load defaults), else it stays at the default.
   * A level the device already has is never touched.
   */
  seed(fallback?: { alert_volume?: unknown; background_volume?: unknown }): void {
    const storage = this.#storage
    if (!storage) return
    let guest: Record<string, unknown> = {}
    try {
      const raw = storage.getItem(ANON_SETTINGS_KEY)
      const values = raw ? (JSON.parse(raw) as { values?: unknown }).values : null
      if (typeof values === 'object' && values !== null) guest = values as Record<string, unknown>
    } catch {
      // Unreadable guest settings: fall through to the account's.
    }
    const server = (fallback ?? {}) as Record<string, unknown>
    for (const which of ['alert', 'background'] as const) {
      if (this.#stored(which) !== null) continue
      const field = settingsField(which)
      const value = level(guest[field]) ?? level(server[field])
      if (value === null) continue
      try {
        storage.setItem(KEYS[which], JSON.stringify(value))
      } catch {
        // Not stored: the default applies.
      }
    }
    this.#refresh()
  }

  /** Follows another tab's change live. Returns the cleanup. */
  start(): () => void {
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === ALERT_VOLUME_KEY ||
        event.key === BACKGROUND_VOLUME_KEY
      ) {
        this.#refresh()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }
}
