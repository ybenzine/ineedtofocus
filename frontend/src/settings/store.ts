// The user's settings: a device copy that works offline, and a small last-write-wins sync.
//
// Every edit is applied and saved on the device at once. The changed fields are kept as a
// "pending" patch and sent with PATCH /api/settings; the patch is kept until the server accepts
// it, so an edit made offline reaches the server when the connection returns (AC13.1, AC13.3).
// The server's copy replaces the device's only for fields with nothing pending. This is a hook
// the sync engine (#19) can adopt: it only needs `flush()` / `refresh()` on `online`.
//
// The store belongs to one signed-in user: the cache records the owner's id and is ignored for
// anyone else, and `dispose()` (sign-out, unmount) aborts requests in flight and stops every
// later write, so one account's edits can never be saved or sent under the next.

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
  /** True after a send failed (offline, server trouble, signed out) until one succeeds. */
  stalled: boolean
}

export interface SettingsStoreOptions {
  /** Without an API the store only keeps the device copy. */
  api?: SettingsApi
  /** Without storage nothing survives a reload. */
  storage?: Storage | null
  /** The signed-in user this store belongs to. */
  owner?: string | null
  /** If given, the store stops working as soon as this no longer returns `owner`. */
  currentOwner?: () => string | null
  /** A request got 401: the sign-in expired. */
  onUnauthorized?: () => void
  /** First retry delay after a failed send while online; doubles up to a minute. */
  retryBaseMs?: number
}

const MAX_RETRY_MS = 60_000

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
  readonly #owner: string | null
  readonly #currentOwner: (() => string | null) | undefined
  readonly #onUnauthorized: (() => void) | undefined
  readonly #retryBaseMs: number
  readonly #abort = new AbortController()
  #state: SettingsState
  #disposed = false
  /** Bumped by every edit and accepted send, so a slower, older GET cannot undo them. */
  #revision = 0
  #attempt = 0
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  readonly #listeners = new Set<() => void>()
  #flushing: Promise<void> | null = null

  constructor(options: SettingsStoreOptions = {}) {
    this.#api = options.api
    this.#storage = options.storage ?? null
    this.#owner = options.owner ?? null
    this.#currentOwner = options.currentOwner
    this.#onUnauthorized = options.onUnauthorized
    this.#retryBaseMs = options.retryBaseMs ?? 2000
    this.#state = this.#read()
  }

  /** False once disposed or once a different user is signed in. */
  #live(): boolean {
    if (this.#disposed) return false
    if (this.#currentOwner && this.#currentOwner() !== this.#owner) {
      this.dispose()
      return false
    }
    return true
  }

  #read(): SettingsState {
    try {
      const raw = this.#storage?.getItem(SETTINGS_KEY)
      if (raw) {
        const stored = JSON.parse(raw) as { owner?: unknown; values?: unknown; pending?: unknown }
        // Someone else's cache is never shown to or sent for this user.
        if ((stored.owner ?? null) === this.#owner) {
          return {
            values: parseSettings(stored.values),
            pending: pickKnown(stored.pending),
            stalled: false,
          }
        }
      }
    } catch {
      // Unreadable cache: start from defaults.
    }
    return { values: DEFAULT_SETTINGS, pending: {}, stalled: false }
  }

  #set(next: Partial<SettingsState>): void {
    if (!this.#live()) return
    this.#state = { ...this.#state, ...next }
    try {
      this.#storage?.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          owner: this.#owner,
          values: this.#state.values,
          pending: this.#state.pending,
        }),
      )
    } catch {
      // A full or blocked storage must not stop the app; the edit still reaches the server.
    }
    for (const listener of this.#listeners) listener()
  }

  /** Stops everything: requests are aborted, timers cleared, nothing is written or sent again. */
  dispose(): void {
    this.#disposed = true
    this.#abort.abort()
    clearTimeout(this.#retryTimer)
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
    if (!this.#live()) return
    const changed: Record<string, unknown> = {}
    for (const key of SETTINGS_KEYS) {
      if (key in patch && !sameValue(patch[key], this.#state.values[key])) changed[key] = patch[key]
    }
    if (Object.keys(changed).length === 0) return
    this.#revision++
    this.#set({
      values: { ...this.#state.values, ...changed },
      pending: { ...this.#state.pending, ...changed },
    })
    void this.flush()
  }

  /** Sends pending edits. Never throws; what fails stays pending and is retried. */
  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing
    const run = this.#flushLoop().finally(() => {
      this.#flushing = null
    })
    this.#flushing = run
    return run
  }

  #scheduleRetry(): void {
    clearTimeout(this.#retryTimer)
    // Offline: the `online` event retries. Online but failing (5xx, timeout): back off.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    const delay = Math.min(this.#retryBaseMs * 2 ** this.#attempt, MAX_RETRY_MS)
    this.#attempt++
    this.#retryTimer = setTimeout(() => void this.flush(), delay)
  }

  async #flushLoop(): Promise<void> {
    const api = this.#api
    if (!api) return
    while (this.#live() && this.hasPending()) {
      const sent = this.#state.pending
      let server: Settings | null = null
      let drop: string[] = Object.keys(sent)
      try {
        server = await api.patch(sent, this.#abort.signal)
      } catch (error) {
        if (!this.#live()) return
        if (error instanceof SettingsError && error.kind === 'invalid') {
          // Keep the valid fields; drop only the ones the server named (all, if it named none).
          const named = error.fields.filter((field) => field in sent)
          if (named.length > 0) drop = named
        } else {
          this.#set({ stalled: true })
          if (error instanceof SettingsError && error.kind === 'unauthorized') {
            this.#onUnauthorized?.()
          } else {
            this.#scheduleRetry()
          }
          return
        }
      }
      if (!this.#live()) return
      if (server) {
        this.#revision++
        this.#attempt = 0
      }
      const pending = Object.fromEntries(
        Object.entries(this.#state.pending).filter(
          ([key, value]) =>
            !(drop.includes(key) && sameValue(value, (sent as Record<string, unknown>)[key])),
        ),
      ) as SettingsPatch
      this.#set({
        values: server ? { ...server, ...pending } : this.#state.values,
        pending,
        stalled: false,
      })
    }
  }

  /** Sends pending edits, then takes the server's copy for everything not edited here. */
  async refresh(): Promise<void> {
    const api = this.#api
    if (!api || !this.#live()) return
    await this.flush()
    // A flush already in flight may have failed just before the connection came back.
    if (this.hasPending()) await this.flush()
    if (this.hasPending() || !this.#live()) return // still offline: the device copy stands
    const revision = this.#revision
    try {
      const server = await api.get(this.#abort.signal)
      // An edit or an accepted send happened meanwhile: this answer is older than the device.
      if (revision !== this.#revision) return
      this.#set({ values: { ...server, ...this.#state.pending } })
    } catch (error) {
      if (error instanceof SettingsError && error.kind === 'unauthorized' && this.#live()) {
        this.#onUnauthorized?.()
      }
      // Offline or signed out: the device copy stands.
    }
  }

  /** Syncs whenever the connection returns (callers `refresh()` once at launch). Returns the cleanup. */
  start(): () => void {
    const onOnline = () => {
      this.#attempt = 0
      void this.refresh()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }
}
