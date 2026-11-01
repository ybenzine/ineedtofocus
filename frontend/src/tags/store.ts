// The user's custom tags: a per-account device copy that works offline (AC7.4, AC7.6, #401).
//
// The list is the server's, removed tags included, oldest first. It is loaded whenever settings
// load (`refresh`), cached under the account's id next to the settings cache, and never read for
// anyone else. Creating, renaming, recolouring and removing need a connection: each is sent
// first, and the device copy changes only with the server's answer. Another tab's change comes
// through the `storage` event. `dispose()` stops everything for good (sign-out, unmount).

import type { CustomTag, TagInput, TagsApi } from './api.ts'
import { TagsError, parseTagList } from './api.ts'
import type { TagColor } from './palette.ts'

export const TAGS_KEY = 'ineedtofocus.tags'

export interface TagsState {
  /** Every custom tag, removed ones included, oldest first. */
  tags: readonly CustomTag[]
}

export interface TagsStoreOptions {
  /** Without an API (no account) the store only keeps what it was given. */
  api?: TagsApi
  storage?: Storage | null
  /** The signed-in user this store belongs to. */
  owner?: string | null
  /** If given, the store stops as soon as this no longer returns `owner`. */
  currentOwner?: () => string | null
  /** A request got 401: the sign-in expired. */
  onUnauthorized?: () => void
  key?: string
}

export class TagsStore {
  readonly #api: TagsApi | undefined
  readonly #storage: Storage | null
  readonly #owner: string | null
  readonly #currentOwner: (() => string | null) | undefined
  readonly #onUnauthorized: (() => void) | undefined
  readonly #key: string
  #abort = new AbortController()
  #disposed = false
  #state: TagsState
  readonly #listeners = new Set<() => void>()

  constructor(options: TagsStoreOptions = {}) {
    this.#api = options.api
    this.#storage = options.storage ?? null
    this.#owner = options.owner ?? null
    this.#currentOwner = options.currentOwner
    this.#onUnauthorized = options.onUnauthorized
    this.#key = options.key ?? TAGS_KEY
    this.#state = { tags: this.#readStored() ?? [] }
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

  /** The cache as stored now, or null if it is missing, unreadable or another account's. */
  #readStored(): CustomTag[] | null {
    try {
      const raw = this.#storage?.getItem(this.#key)
      if (!raw) return null
      const stored = JSON.parse(raw) as { owner?: unknown; tags?: unknown }
      // Someone else's cache is never shown to this user.
      if ((stored.owner ?? null) !== this.#owner) return null
      return parseTagList(stored.tags)
    } catch {
      return null
    }
  }

  #write(tags: readonly CustomTag[]): void {
    try {
      this.#storage?.setItem(this.#key, JSON.stringify({ owner: this.#owner, tags }))
    } catch {
      // A full or blocked storage must not stop the app.
    }
  }

  #set(tags: readonly CustomTag[]): void {
    this.#state = { tags }
    this.#write(tags)
    for (const listener of this.#listeners) listener()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Stable between changes, for `useSyncExternalStore`. */
  readonly getState = (): TagsState => this.#state

  /** Restarts a disposed store (React StrictMode runs setup, cleanup, setup on one instance). */
  arm(): void {
    if (!this.#disposed) return
    if (this.#currentOwner && this.#currentOwner() !== this.#owner) return
    this.#disposed = false
    this.#abort = new AbortController()
  }

  dispose(): void {
    this.#disposed = true
    this.#abort.abort()
  }

  /** True if this store can talk to the server (an account is signed in). */
  get canChange(): boolean {
    return this.#api !== undefined
  }

  #handle(error: unknown): never {
    if (error instanceof TagsError && error.kind === 'unauthorized' && this.#live()) {
      this.#onUnauthorized?.()
    }
    throw error
  }

  /** Takes the server's list. Offline or signed out, the device copy stands. Never throws. */
  async refresh(): Promise<void> {
    const api = this.#api
    if (!api || !this.#live()) return
    try {
      const tags = await api.list(this.#abort.signal)
      if (this.#live()) this.#set(tags)
    } catch (error) {
      try {
        this.#handle(error)
      } catch {
        // The device copy stands.
      }
    }
  }

  #upsert(tag: CustomTag): void {
    if (!this.#live()) return
    const current = this.#state.tags
    const index = current.findIndex((t) => t.id === tag.id)
    this.#set(index === -1 ? [...current, tag] : current.map((t) => (t.id === tag.id ? tag : t)))
  }

  /** Creates a tag, or brings the removed one of that name back. Throws a `TagsError`. */
  async create(name: string, color: TagColor): Promise<{ tag: CustomTag; restored: boolean }> {
    const api = this.#api
    if (!api) throw new TagsError('unauthorized', 'Not signed in.')
    try {
      const result = await api.create({ name, color }, this.#abort.signal)
      this.#upsert(result.tag)
      return result
    } catch (error) {
      return this.#handle(error)
    }
  }

  /** Renames and/or recolours. Throws a `TagsError`. */
  async update(id: string, input: TagInput): Promise<CustomTag> {
    const api = this.#api
    if (!api) throw new TagsError('unauthorized', 'Not signed in.')
    try {
      const tag = await api.update(id, input, this.#abort.signal)
      this.#upsert(tag)
      return tag
    } catch (error) {
      return this.#handle(error)
    }
  }

  /** Removes a tag from the pickers; its sessions keep it. Throws a `TagsError`. */
  async remove(id: string): Promise<CustomTag> {
    const api = this.#api
    if (!api) throw new TagsError('unauthorized', 'Not signed in.')
    try {
      const tag = await api.remove(id, this.#abort.signal)
      this.#upsert(tag)
      return tag
    } catch (error) {
      return this.#handle(error)
    }
  }

  /** Follows another tab's changes to the cache. Returns the cleanup. */
  start(): () => void {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== this.#key || !this.#live()) return
      const tags = this.#readStored()
      if (tags === null) return
      this.#state = { tags }
      for (const listener of this.#listeners) listener()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }
}
