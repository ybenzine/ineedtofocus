// The finished anonymous session a page holds until its user signs up or signs in from the
// summary's prompt (#331). It lives only in this page's memory: never in sessionStorage,
// IndexedDB or the sync queue, so any new page load discards it. `ineedtofocus.anonymous.heldId`
// names it so every other page and tab can tell when it is no longer valid.

import type { ActiveSession, SessionRecord } from '../timer/engine.ts'
import {
  LocalActiveSessionStore,
  parseStoredTimer,
  type ActiveSessionStore,
  type StoredTimer,
} from '../timer/store.ts'
import { ANON_ACTIVE_SESSION_KEY, ANON_HELD_ID_KEY, ANON_HELD_LOCK } from './keys.ts'

export interface HeldState {
  session: ActiveSession
  record: SessionRecord
}

function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Runs `run` alone across tabs (Web Locks). Where there are none (older browsers, jsdom) it just
 * runs: the read and the removal are then one synchronous step, as close as localStorage gets.
 */
function withHeldLock<T>(run: () => T): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) return Promise.resolve().then(run)
  let started = false
  return locks
    .request(ANON_HELD_LOCK, async () => {
      started = true
      return run()
    })
    .catch((error: unknown) => {
      // The lock itself failed before `run` began: run without it rather than lose the session.
      if (!started) return run()
      throw error
    })
}

export class HeldSession {
  readonly #storage: Storage
  /** A finished session the timer wrote to the store, waiting to be claimed. */
  #stash: HeldState | null = null
  #held: HeldState | null = null
  readonly #listeners = new Set<() => void>()
  #unwatch: (() => void) | null = null

  constructor(storage: Storage = window.localStorage) {
    this.#storage = storage
  }

  /** What the timer would have stored as the session's `pendingRecord`; kept only in memory. */
  stash(state: StoredTimer): void {
    if (state.pendingRecord === null) return
    this.#stash = { session: state.session, record: state.pendingRecord }
  }

  /**
   * Check-and-remove by id: only the page that empties the anonymous slot of this session holds
   * it. A page that finds the slot empty, or holding another id, holds nothing.
   */
  async claim(record: SessionRecord): Promise<void> {
    const stash = this.#stash?.record.id === record.id ? this.#stash : null
    const won = await withHeldLock(() => {
      const stored = parseStoredTimer(read(this.#storage, ANON_ACTIVE_SESSION_KEY))
      if (stored?.session.id !== record.id) return false
      this.#storage.removeItem(ANON_ACTIVE_SESSION_KEY)
      try {
        this.#storage.setItem(ANON_HELD_ID_KEY, record.id)
      } catch {
        // Without the marker this page cannot prove it still holds the session: it discards it.
      }
      return true
    })
    if (this.#stash?.record.id === record.id) this.#stash = null
    if (!won || stash === null) return
    this.#held = { session: stash.session, record }
    this.#watch()
    this.#notify()
  }

  /** The held session, or `null`. Does not check the marker; `verify` does. */
  get(): HeldState | null {
    return this.#held
  }

  holds(id: string): boolean {
    return this.#held?.record.id === id
  }

  /** True while the marker still names the held session; otherwise discards it quietly. */
  verify(): boolean {
    if (this.#held === null) return false
    if (read(this.#storage, ANON_HELD_ID_KEY) === this.#held.record.id) return true
    this.discard()
    return false
  }

  /** Gives the held session to the caller (the prompt's save) after checking the marker. */
  take(): HeldState | null {
    if (!this.verify()) return null
    const held = this.#held
    this.#drop()
    return held
  }

  /** Forgets the held session, and its marker if the marker is still its own. */
  discard(): void {
    const held = this.#held
    if (held === null) return
    if (read(this.#storage, ANON_HELD_ID_KEY) === held.record.id) {
      try {
        this.#storage.removeItem(ANON_HELD_ID_KEY)
      } catch {
        // Nothing more to do.
      }
    }
    this.#drop()
  }

  /** Called when a session starts in this tab: any held session, here or elsewhere, is void. */
  forgetMarker(): void {
    try {
      this.#storage.removeItem(ANON_HELD_ID_KEY)
    } catch {
      // Nothing more to do.
    }
    this.#drop()
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #drop(): void {
    const had = this.#held !== null
    this.#held = null
    this.#unwatch?.()
    this.#unwatch = null
    if (had) this.#notify()
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener()
  }

  /** Re-checks the marker whenever the page could have missed a change to it. */
  #watch(): void {
    if (this.#unwatch !== null) return
    const check = () => void this.verify()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check()
    }
    window.addEventListener('storage', check)
    window.addEventListener('pageshow', check)
    document.addEventListener('visibilitychange', onVisibility)
    this.#unwatch = () => {
      window.removeEventListener('storage', check)
      window.removeEventListener('pageshow', check)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

/**
 * The timer's store for an anonymous session: an ordinary session is kept in its own key; a
 * finished session's record is never written (it is held in memory by `HeldSession` instead).
 */
export class AnonymousActiveSessionStore implements ActiveSessionStore {
  readonly #inner: ActiveSessionStore
  readonly #held: HeldSession

  constructor(
    held: HeldSession,
    storage: Storage = window.localStorage,
    key: string = ANON_ACTIVE_SESSION_KEY,
  ) {
    this.#held = held
    this.#inner = new LocalActiveSessionStore(storage, key)
  }

  load(): StoredTimer | null {
    return this.#inner.load()
  }

  save(state: StoredTimer): void {
    if (state.pendingRecord !== null) {
      this.#held.stash(state)
      return
    }
    this.#inner.save(state)
  }

  clear(): void {
    this.#inner.clear()
  }
}
