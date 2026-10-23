// Keeps the one active session on the device so it survives reloads and reopening (AC6.4).

import { TAGS, validateConfig, type TimerConfig } from './config.ts'
import { SESSION_SCHEMA_VERSION, type ActiveSession, type SessionRecord } from './engine.ts'

export interface StoredTimer {
  session: ActiveSession
  /**
   * The finished session's record, kept until it has been handed to the session store. If the
   * app closes in between, it is handed over again on the next start (never lost, F13).
   */
  pendingRecord: SessionRecord | null
}

export interface ActiveSessionStore {
  load(): StoredTimer | null
  save(state: StoredTimer): void
  clear(): void
}

export const ACTIVE_SESSION_KEY = 'ineedtofocus.activeSession'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSession(value: unknown): value is ActiveSession {
  if (!isObject(value)) return false
  if (value.version !== SESSION_SCHEMA_VERSION) return false
  if (typeof value.id !== 'string' || value.id === '') return false
  if (typeof value.tag !== 'string' || !(TAGS as readonly string[]).includes(value.tag))
    return false
  if (value.goal !== null && typeof value.goal !== 'string') return false
  if (!isNumber(value.startedAt) || !isNumber(value.observedActiveMs)) return false
  if (
    !isObject(value.config) ||
    validateConfig(value.config as unknown as TimerConfig).length > 0
  ) {
    return false
  }
  const pauses = value.pauses
  if (!Array.isArray(pauses)) return false
  const pausesOk = pauses.every(
    (p, i) =>
      isObject(p) &&
      isNumber(p.pausedAt) &&
      (isNumber(p.resumedAt) || (p.resumedAt === null && i === pauses.length - 1)),
  )
  if (!pausesOk) return false
  const skips = value.skips
  return (
    Array.isArray(skips) &&
    skips.every((s) => isObject(s) && isNumber(s.phaseIndex) && isNumber(s.atActiveMs))
  )
}

/** Parses what was stored; anything unreadable or from another schema version reads as empty. */
export function parseStoredTimer(raw: string | null): StoredTimer | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(value) || !isSession(value.session)) return null
  const pending = value.pendingRecord
  if (pending !== null && !(isObject(pending) && typeof pending.id === 'string')) return null
  return { session: value.session, pendingRecord: (pending as SessionRecord | null) ?? null }
}

/** `localStorage`-backed store: synchronous, so every change is on disk before the UI moves on. */
export class LocalActiveSessionStore implements ActiveSessionStore {
  readonly #storage: Storage
  readonly #key: string

  constructor(storage: Storage = window.localStorage, key: string = ACTIVE_SESSION_KEY) {
    this.#storage = storage
    this.#key = key
  }

  load(): StoredTimer | null {
    return parseStoredTimer(this.#storage.getItem(this.#key))
  }

  save(state: StoredTimer): void {
    this.#storage.setItem(this.#key, JSON.stringify(state))
  }

  clear(): void {
    this.#storage.removeItem(this.#key)
  }
}

/** In-memory store, for tests. */
export class MemoryActiveSessionStore implements ActiveSessionStore {
  #raw: string | null = null

  load(): StoredTimer | null {
    return parseStoredTimer(this.#raw)
  }

  save(state: StoredTimer): void {
    this.#raw = JSON.stringify(state)
  }

  clear(): void {
    this.#raw = null
  }
}
