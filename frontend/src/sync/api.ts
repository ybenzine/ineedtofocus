// The sessions API as the sync engine needs it (_docs/api/openapi.json): the batch sync and the
// tag/goal edit. Keys are snake_case on the wire; `SessionRecord` maps one to one
// (_docs/architecture.md → Sessions).

import type { Tag, TimerConfig } from '../timer/config.ts'
import type { SessionRecord } from '../timer/engine.ts'
import { tracedFetch } from '../telemetry/tracedFetch.ts'

/** The server's limit for one `POST /api/sessions/sync` request. */
export const SYNC_BATCH_LIMIT = 100

export interface ApiError {
  code: string
  message: string
}

export type SyncItemStatus = 'created' | 'existing' | 'rejected'

/** The fields of the server's stored copy that the device keeps up to date. */
export interface ServerSession {
  id: string
  tag: Tag
  goal: string | null
  archivedAt: string | null
}

export interface SyncItemResult {
  index: number
  id: string | null
  status: SyncItemStatus
  session: ServerSession | null
  error: ApiError | null
}

/** Tag and/or goal; `goal: null` clears it. Only the fields present are changed (AC11.1). */
export interface SessionEdit {
  tag?: Tag
  goal?: string | null
}

/**
 * How a call ended, from the sync engine's point of view:
 * - `ok`: the server answered as documented;
 * - `unauthorized`: 401, the sign-in expired; keep everything and wait for a new sign-in;
 * - `conflict` (409), `invalid` (422), `not_found` (404): the server refuses this request;
 * - `unavailable`: network error, timeout, 5xx, 429 or anything unexpected; retry with backoff.
 */
export type ApiResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unauthorized' }
  | { kind: 'conflict'; error: ApiError | null }
  | { kind: 'invalid'; error: ApiError | null }
  | { kind: 'not_found' }
  | { kind: 'unavailable' }

export interface SessionsApi {
  /** `POST /api/sessions/sync` with 1 to `SYNC_BATCH_LIMIT` sessions. */
  sync(records: SessionRecord[]): Promise<ApiResult<SyncItemResult[]>>
  /** `PATCH /api/sessions/{id}`. */
  edit(id: string, edit: SessionEdit): Promise<ApiResult<ServerSession>>
}

function modeConfigToWire(config: TimerConfig): Record<string, unknown> {
  switch (config.mode) {
    case 'countdown':
      return { mode: 'countdown', minutes: config.minutes }
    case 'pomodoro':
      return {
        mode: 'pomodoro',
        focus_minutes: config.focusMinutes,
        break_minutes: config.breakMinutes,
        blocks: config.blocks,
        long_break_enabled: config.longBreakEnabled,
        long_break_minutes: config.longBreakMinutes,
      }
    case 'unlimited':
      return { mode: 'unlimited', reminder_minutes: config.reminderMinutes }
  }
}

/** A finished session as the API's `SessionIn`. */
export function toSessionIn(record: SessionRecord): Record<string, unknown> {
  return {
    id: record.id,
    mode: record.mode,
    tag: record.tag,
    goal: record.goal,
    started_at: record.startedAt,
    ended_at: record.endedAt,
    focus_seconds: record.focusSeconds,
    paused_seconds: record.pausedSeconds,
    status: record.status,
    mode_config: modeConfigToWire(record.modeConfig),
    blocks_completed: record.blocksCompleted,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseError(value: unknown): ApiError | null {
  if (!isObject(value)) return null
  const error = isObject(value.error) ? value.error : value
  if (typeof error.code !== 'string') return null
  return { code: error.code, message: typeof error.message === 'string' ? error.message : '' }
}

function parseSession(value: unknown): ServerSession | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.tag !== 'string') {
    return null
  }
  if (value.goal !== null && typeof value.goal !== 'string') return null
  return {
    id: value.id,
    tag: value.tag as Tag,
    goal: value.goal,
    archivedAt: typeof value.archived_at === 'string' ? value.archived_at : null,
  }
}

function parseSyncResults(value: unknown): SyncItemResult[] | null {
  if (!isObject(value) || !Array.isArray(value.results)) return null
  const results: SyncItemResult[] = []
  for (const item of value.results) {
    if (!isObject(item) || typeof item.index !== 'number') return null
    const status = item.status
    if (status !== 'created' && status !== 'existing' && status !== 'rejected') return null
    results.push({
      index: item.index,
      id: typeof item.id === 'string' ? item.id : null,
      status,
      session: parseSession(item.session),
      error: parseError(item.error),
    })
  }
  return results
}

export interface HttpSessionsApiOptions {
  fetch?: typeof fetch
  /** Base URL of the API; the app and the API share one origin. */
  baseUrl?: string
  /** A request that takes longer than this counts as unavailable and is retried later. */
  timeoutMs?: number
}

export const REQUEST_TIMEOUT_MS = 15_000

/** The real API over `fetch`, same origin, with the session cookie. */
export class HttpSessionsApi implements SessionsApi {
  readonly #fetch: typeof fetch
  readonly #baseUrl: string
  readonly #timeoutMs: number

  constructor(options: HttpSessionsApiOptions = {}) {
    this.#fetch = options.fetch ?? tracedFetch
    this.#baseUrl = options.baseUrl ?? ''
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  async sync(records: SessionRecord[]): Promise<ApiResult<SyncItemResult[]>> {
    const result = await this.#send('POST', '/api/sessions/sync', {
      sessions: records.map(toSessionIn),
    })
    if (result.kind !== 'ok') return result
    const parsed = parseSyncResults(result.value)
    return parsed === null ? { kind: 'unavailable' } : { kind: 'ok', value: parsed }
  }

  async edit(id: string, edit: SessionEdit): Promise<ApiResult<ServerSession>> {
    const result = await this.#send('PATCH', `/api/sessions/${encodeURIComponent(id)}`, edit)
    if (result.kind !== 'ok') return result
    const parsed = parseSession(result.value)
    return parsed === null ? { kind: 'unavailable' } : { kind: 'ok', value: parsed }
  }

  async #send(method: string, path: string, body: unknown): Promise<ApiResult<unknown>> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch {
      return { kind: 'unavailable' }
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (response.ok) {
      return payload === null ? { kind: 'unavailable' } : { kind: 'ok', value: payload }
    }
    switch (response.status) {
      case 401:
        return { kind: 'unauthorized' }
      case 404:
        return { kind: 'not_found' }
      case 409:
        return { kind: 'conflict', error: parseError(payload) }
      case 422:
        return { kind: 'invalid', error: parseError(payload) }
      default:
        return { kind: 'unavailable' }
    }
  }
}
