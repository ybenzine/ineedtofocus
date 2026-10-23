// The user's settings: a device copy that works offline, and a small last-write-wins sync.
//
// Every edit is applied and saved on the device at once. The changed fields are kept as a
// "pending" patch and sent with PATCH /api/settings; the patch is kept until the server accepts
// it, so an edit made offline reaches the server when the connection returns (AC13.1, AC13.3).
// The server's copy replaces the device's only for fields with nothing pending. This is a hook
// the sync engine (#19) can adopt: it only needs `flush()` / `refresh()` on `online`.

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  SettingsError,
  parseSettings,
  type Settings,
  type SettingsApi,
  type SettingsPatch,
} from './api.ts'

export const SETTINGS_KEY = 'ineedtofocus.settings'

export interface SettingsState {
  values: Settings
  /** Edits the server hasn't accepted yet. */
  pending: SettingsPatch
}

export interface SettingsStoreOptions {
  /** Without an API the store only keeps the device copy. */
  api?: SettingsApi
  /** Without storage nothing survives a reload. */
  storage?: Storage | null
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function pickKnown(raw: unknown): SettingsPatch {
  const parsed = parseSettings(raw)
  const patch: Record<string, unknown> = {}
  if (typeof raw === 'object' && raw !== null) {
    for (const key of SETTINGS_KEYS) {
      if (key in raw) patch[key] = parsed[key]
    }
  }
  return patch as SettingsPatch
}

export class SettingsStore {
  readonly #api: SettingsApi | undefined
  readonly #storage: Storage | null
  #state: SettingsState
  readonly #listeners = new Set<() => void>()
  #flushing: Promise<void> | null = null

  constructor(options: SettingsStoreOptions = {}) {
    this.#api = options.api
    this.#storage = options.storage ?? null
    this.#state = this.#read()
  }

  #read(): SettingsState {
    try {
      const raw = this.#storage?.getItem(SETTINGS_KEY)
      if (raw) {
        const stored = JSON.parse(raw) as { values?: unknown; pending?: unknown }
        return { values: parseSettings(stored.values), pending: pickKnown(stored.pending) }
      }
    } catch {
      // Unreadable cache: start from defaults.
    }
    return { values: DEFAULT_SETTINGS, pending: {} }
  }

  #set(state: SettingsState): void {
    this.#state = state
    try {
      this.#storage?.setItem(SETTINGS_KEY, JSON.stringify(state))
    } catch {
      // A full or blocked storage must not stop the app; the edit still reaches the server.
    }
    for (const listener of this.#listeners) listener()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Stable between changes, for `useSyncExternalStore`. */
  readonly getState = (): SettingsState => this.#state

  get values(): Settings {
    return this.#state.values
  }

  hasPending(): boolean {
    return Object.keys(this.#state.pending).length > 0
  }

  /** Applies an edit on the device now and sends it to the server when it can. */
  update(patch: SettingsPatch): void {
    const changed: Record<string, unknown> = {}
    for (const key of SETTINGS_KEYS) {
      if (key in patch && !sameValue(patch[key], this.#state.values[key])) changed[key] = patch[key]
    }
    if (Object.keys(changed).length === 0) return
    this.#set({
      values: { ...this.#state.values, ...changed },
      pending: { ...this.#state.pending, ...changed },
    })
    void this.flush()
  }

  /** Sends pending edits. Never throws; what fails stays pending for the next try. */
  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing
    const run = this.#flushLoop().finally(() => {
      this.#flushing = null
    })
    this.#flushing = run
    return run
  }

  async #flushLoop(): Promise<void> {
    const api = this.#api
    if (!api) return
    while (this.hasPending()) {
      const sent = this.#state.pending
      let server: Settings | null = null
      try {
        server = await api.patch(sent)
      } catch (error) {
        if (!(error instanceof SettingsError) || error.kind !== 'invalid') return
        // The server refuses these values; keeping them would block every later edit.
      }
      const pending = Object.fromEntries(
        Object.entries(this.#state.pending).filter(
          ([key, value]) => !sameValue(value, (sent as Record<string, unknown>)[key]),
        ),
      ) as SettingsPatch
      this.#set({
        values: server ? { ...server, ...pending } : this.#state.values,
        pending,
      })
    }
  }

  /** Sends pending edits, then takes the server's copy for everything not edited here. */
  async refresh(): Promise<void> {
    const api = this.#api
    if (!api) return
    await this.flush()
    // A flush already in flight may have failed just before the connection came back.
    if (this.hasPending()) await this.flush()
    if (this.hasPending()) return // still offline: the device copy stands
    try {
      const server = await api.get()
      this.#set({ values: { ...server, ...this.#state.pending }, pending: this.#state.pending })
    } catch {
      // Offline or signed out: the device copy stands.
    }
  }

  /** Syncs whenever the connection returns (callers `refresh()` once at launch). Returns the cleanup. */
  start(): () => void {
    const onOnline = () => void this.refresh()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }
}
