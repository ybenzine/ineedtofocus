// The History API (GET /api/history, _docs/api/openapi.json) and the shapes the screen uses.

import type { ApiResult } from '../sync/api.ts'
import type { Mode, Tag } from '../timer/config.ts'
import type { SessionStatus } from '../timer/engine.ts'
import type { SyncIndicator } from '../sync/sessionStore.ts'
import { TAGS } from '../timer/config.ts'
import { tracedFetch } from '../telemetry/tracedFetch.ts'

export type HistoryView = 'day' | 'week' | 'month' | 'all' | 'custom'
export type BucketUnit = 'day' | 'month'

export interface HistoryBucket {
  /** The day, or the 1st of the month. */
  date: string
  focusSeconds: number
  sessions: number
}

export interface TagTotal {
  tag: Tag
  focusSeconds: number
  sessions: number
}

export interface HistorySession {
  id: string
  mode: Mode
  tag: Tag
  goal: string | null
  startedAt: string
  focusSeconds: number
  status: SessionStatus
  indicator: SyncIndicator
  /** True for a session on the device that the server doesn't have yet (not for an edit). */
  unsaved?: boolean
  /** True for a session on the device that the server refused ("Couldn't sync"). */
  rejected?: boolean
  /** True while the server refuses this session's queued tag/goal edit ("Couldn't sync"). */
  editRejected?: boolean
}

export interface HistoryData {
  view: HistoryView
  timeZone: string
  /** 0 = Sunday ... 6 = Saturday, from settings. */
  weekStartDay: number
  start: string | null
  end: string | null
  bucket: BucketUnit
  totalFocusSeconds: number
  sessionCount: number
  tags: TagTotal[]
  buckets: HistoryBucket[]
  /** Newest first. */
  sessions: HistorySession[]
}

/** What to ask for; the API is strict about which params go with which view (422 otherwise). */
export interface HistoryQuery {
  view: HistoryView
  tz: string
  /** day, week, month: any local date in the period. */
  date?: string
  /** custom: inclusive. */
  start?: string
  end?: string
  tags: readonly Tag[]
}

export interface HistoryApi {
  get(query: HistoryQuery): Promise<ApiResult<HistoryData>>
}

/** AC10.5: the device's IANA zone, or UTC if it reports none. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function historyQueryString(query: HistoryQuery): string {
  const params = new URLSearchParams({ view: query.view, tz: query.tz })
  if (query.view === 'day' || query.view === 'week' || query.view === 'month') {
    if (query.date) params.set('date', query.date)
  } else if (query.view === 'custom') {
    if (query.start) params.set('start', query.start)
    if (query.end) params.set('end', query.end)
  }
  for (const tag of query.tags) params.append('tag', tag)
  return params.toString()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
const dateOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const isTag = (value: unknown): value is Tag => TAGS.includes(value as Tag)

export function parseHistory(value: unknown): HistoryData | null {
  if (!isObject(value)) return null
  const { view, bucket } = value
  if (typeof view !== 'string' || (bucket !== 'day' && bucket !== 'month')) return null
  if (!Array.isArray(value.buckets) || !Array.isArray(value.sessions) || !Array.isArray(value.tags))
    return null
  const sessions: HistorySession[] = []
  for (const item of value.sessions) {
    if (!isObject(item) || typeof item.id !== 'string' || !isTag(item.tag)) return null
    if (typeof item.started_at !== 'string') return null
    sessions.push({
      id: item.id,
      mode: item.mode as Mode,
      tag: item.tag,
      goal: typeof item.goal === 'string' ? item.goal : null,
      startedAt: item.started_at,
      focusSeconds: num(item.focus_seconds),
      status: item.status as SessionStatus,
      indicator: 'synced',
    })
  }
  return {
    view: view as HistoryView,
    timeZone: typeof value.time_zone === 'string' ? value.time_zone : 'UTC',
    weekStartDay: num(value.week_start_day),
    start: dateOrNull(value.start),
    end: dateOrNull(value.end),
    bucket,
    totalFocusSeconds: num(value.total_focus_seconds),
    sessionCount: num(value.session_count),
    tags: value.tags
      .filter(isObject)
      .flatMap((t) =>
        isTag(t.tag)
          ? [{ tag: t.tag, focusSeconds: num(t.focus_seconds), sessions: num(t.sessions) }]
          : [],
      ),
    buckets: value.buckets
      .filter(isObject)
      .flatMap((b) =>
        typeof b.date === 'string'
          ? [{ date: b.date, focusSeconds: num(b.focus_seconds), sessions: num(b.sessions) }]
          : [],
      ),
    sessions,
  }
}

export const HISTORY_TIMEOUT_MS = 15_000

/** The real API over `fetch`, same origin, with the session cookie. */
export class HttpHistoryApi implements HistoryApi {
  readonly #fetch: typeof fetch

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.#fetch = options.fetch ?? tracedFetch
  }

  async get(query: HistoryQuery): Promise<ApiResult<HistoryData>> {
    let response: Response
    try {
      response = await this.#fetch(`/api/history?${historyQueryString(query)}`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS),
      })
    } catch {
      return { kind: 'unavailable' }
    }
    if (response.status === 401) return { kind: 'unauthorized' }
    if (response.status === 422) return { kind: 'invalid', error: null }
    if (!response.ok) return { kind: 'unavailable' }
    try {
      const parsed = parseHistory(await response.json())
      return parsed ? { kind: 'ok', value: parsed } : { kind: 'unavailable' }
    } catch {
      return { kind: 'unavailable' }
    }
  }
}
