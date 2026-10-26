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
//
// Several tabs share the one cache. Every change to it is a function of the state (an edit, an
// accepted send, a fresh server copy) that is applied to what is stored right now, under a Web
// Lock (unlocked where there are none), not to this tab's older copy. So `pending` merges per
// field: two tabs' edits to different fields both survive, and for the same field the later
// edit wins (#129). An edit is also written to the cache at once, in the task of the call and
// without the lock, so a reload or a closing tab right after it finds it (#279). That write is
// for reload safety only: tabs run in parallel, so another tab's locked merge can overwrite it.
// For cross-tab safety a repair queued on the lock puts the edit back if it was overwritten.

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
/** Held while the cache is read, merged and written, so two tabs can't overwrite each other. */
export const SETTINGS_LOCK = 'ineedtofocus-settings'
/** How long sign-out waits for pending edits to be sent (same as the session sync's). */
export const SETTINGS_TRY_SYNC_MS = 10_000

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
  #abort = new AbortController()
  #state: SettingsState
  #disposed = false
  /** Bumped by every edit and accepted send, so a slower, older GET cannot undo them. */
  #revision = 0
  #attempt = 0
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  readonly #listeners = new Set<() => void>()
  #flushing: Promise<void> | null = null
  /** Cache writes started and not finished yet (they queue on the lock). */
  #writing = 0
  /** The newest queued cache write; a send waits for it so it works from the merged cache. */
  #lastWrite: Promise<unknown> = Promise.resolve()

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
    return this.#readStored() ?? { values: DEFAULT_SETTINGS, pending: {}, stalled: false }
  }

  /** The cache as stored now, or null if it is missing, unreadable or another user's. */
  #readStored(): SettingsState | null {
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
    return null
  }

  #write(state: SettingsState): void {
    try {
      this.#storage?.setItem(
        SETTINGS_KEY,
        JSON.stringify({ owner: this.#owner, values: state.values, pending: state.pending }),
      )
    } catch {
      // A full or blocked storage must not stop the app; the edit still reaches the server.
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }

  /** Not persisted: the flag lives only in this tab. */
  #setStalled(stalled: boolean): void {
    if (!this.#live() || this.#state.stalled === stalled) return
    this.#state = { ...this.#state, stalled }
    this.#notify()
  }

  /**
   * Applies `change` to this tab's state now, and to the stored cache (whatever other tabs have
   * written since) under the lock. What other tabs have pending is taken into this tab's state
   * once no write of ours is outstanding.
   */
  #commit(
    change: (state: SettingsState) => Partial<SettingsState>,
    { immediate = false }: { immediate?: boolean } = {},
  ): void {
    if (!this.#live()) return
    this.#state = { ...this.#state, ...change(this.#state) }
    this.#notify()
    this.#writing++
    let started = false
    const merge = () => {
      started = true
      try {
        if (!this.#live()) return
        const base = this.#readStored() ?? this.#state
        const merged: SettingsState = { ...base, ...change(base), stalled: this.#state.stalled }
        this.#write(merged)
        if (this.#writing === 1) this.#adopt(merged)
      } finally {
        this.#writing--
      }
    }
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    // An edit is stored in this task so a reload or close right after it finds it (#279). It is
    // not safe against a parallel tab's locked merge; `#repairEdit` covers that.
    if (!locks || immediate) {
      merge()
      return
    }
    this.#lastWrite = locks
      .request(SETTINGS_LOCK, async () => merge())
      .catch(() => {
        // Locking failed before the merge ran: merge without it rather than lose the write.
        if (!started) merge()
      })
  }

  /** Takes the stored cache's values and pending edits as this tab's (they include other tabs'). */
  #adopt(stored: SettingsState): void {
    if (
      sameValue(stored.pending, this.#state.pending) &&
      sameValue(stored.values, this.#state.values)
    )
      return
    // An older GET must not undo what other tabs changed either.
    this.#revision++
    this.#state = { ...this.#state, values: stored.values, pending: stored.pending }
    this.#notify()
  }

  /** Picks up another tab's edits before sending or counting, unless a write of ours is queued. */
  #adoptStored(): void {
    if (this.#writing > 0 || !this.#live()) return
    const stored = this.#readStored()
    if (stored) this.#adopt(stored)
  }

  /**
   * Starts (or restarts) a disposed store. React StrictMode runs an effect's setup, cleanup and
   * setup again on the same instance, so `dispose()` in a cleanup must not be final. Does
   * nothing for a store that stopped because its user is gone.
   */
  arm(): void {
    if (!this.#disposed) return
    if (this.#currentOwner && this.#currentOwner() !== this.#owner) return
    this.#disposed = false
    this.#abort = new AbortController()
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

  /** How many settings have edits the server hasn't accepted (other tabs' included). */
  countUnsynced(): number {
    this.#adoptStored()
    return Object.keys(this.#state.pending).length
  }

  /** A last attempt to send pending edits for sign-out: waits at most `timeoutMs`, skipped offline. */
  async trySync(timeoutMs: number = SETTINGS_TRY_SYNC_MS): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    try {
      await Promise.race([this.flush(), timeout])
    } finally {
      clearTimeout(timer)
    }
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
    const before = this.#readStored() ?? this.#state
    const prior = { values: before.values, pending: before.pending }
    this.#commit(
      (state) => ({
        values: { ...state.values, ...changed },
        pending: { ...state.pending, ...changed },
      }),
      { immediate: true },
    )
    this.#repairEdit(changed, prior)
    void this.flush()
  }

  /**
   * Under the lock, puts back an edit that another tab's locked merge overwrote between our
   * immediate write and now (tabs run in parallel, so it can). `prior` is the field's stored
   * value and pending entry just before the edit; a field is repaired only if the cache shows the
   * same value and the same pending entry (or none, if a send of it was accepted meanwhile), i.e.
   * the edit was overwritten. A newer edit elsewhere (another value or pending entry) and an
   * accepted send of this edit (value already the edit) are left alone, so the later edit still wins and nothing stale is resent. Two edits of one field by
   * this tab are repaired in order, each restoring the one before it, so the newest wins. A send
   * waits for the repair like for any queued write.
   */
  #repairEdit(
    changed: Record<string, unknown>,
    prior: { values: Settings; pending: SettingsState['pending'] },
  ): void {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    if (!locks) return
    this.#writing++
    let started = false
    const repair = () => {
      started = true
      try {
        if (!this.#live()) return
        const base = this.#readStored() ?? this.#state
        const lost: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(changed)) {
          const k = key as keyof Settings
          const hadPending = key in prior.pending
          const unchanged =
            sameValue(base.values[k], prior.values[k]) &&
            (!(key in base.pending) || (hadPending && sameValue(base.pending[k], prior.pending[k])))
          const landed = sameValue(base.values[k], value) && sameValue(base.pending[k], value)
          if (unchanged && !landed) lost[key] = value
        }
        if (Object.keys(lost).length === 0) {
          if (this.#writing === 1) this.#adopt(base)
          return
        }
        const merged: SettingsState = {
          ...base,
          values: { ...base.values, ...lost },
          pending: { ...base.pending, ...lost },
          stalled: this.#state.stalled,
        }
        this.#write(merged)
        if (this.#writing === 1) this.#adopt(merged)
      } finally {
        this.#writing--
      }
    }
    this.#lastWrite = locks
      .request(SETTINGS_LOCK, async () => repair())
      .catch(() => {
        if (!started) repair()
      })
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
    for (;;) {
      // Queued cache writes (waiting on the lock) land first, so what is sent is the merged cache.
      while (this.#writing > 0) await this.#lastWrite
      this.#adoptStored()
      if (!this.#live() || !this.hasPending()) return
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
          this.#setStalled(true)
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
      // A field another tab (or the user) changed meanwhile stays pending: only what was sent goes.
      this.#commit((state) => {
        const pending = Object.fromEntries(
          Object.entries(state.pending).filter(
            ([key, value]) =>
              !(drop.includes(key) && sameValue(value, (sent as Record<string, unknown>)[key])),
          ),
        ) as SettingsPatch
        return {
          values: server ? { ...server, ...pending } : state.values,
          pending,
          stalled: false,
        }
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
      this.#commit((state) => ({ values: { ...server, ...state.pending } }))
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
    // Another tab saved to the cache: show and send its edits too.
    const onStorage = (event: StorageEvent) => {
      if (event.key === SETTINGS_KEY && this.#writing === 0) {
        this.#adoptStored()
        void this.flush()
      }
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('storage', onStorage)
    }
  }
}
