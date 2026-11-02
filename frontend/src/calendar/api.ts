// The calendar endpoints (F14, _docs/api/openapi.json): the subscription feed's status, create,
// reset (delete, then create) and turn off, and the History download. Online only.
//
// Privacy (AC14.4, AC14.8): the secret path comes back once from `createFeed`. It is handed to
// the caller and never stored, logged or cached here.

import { historyQueryString, type HistoryQuery } from '../history/api.ts'
import type { ApiResult } from '../sync/api.ts'
import { tracedFetch } from '../telemetry/tracedFetch.ts'

export interface FeedStatus {
  enabled: boolean
  createdAt: string | null
  /** When a calendar app last fetched the feed; null = not yet. */
  lastFetchedAt: string | null
}

export interface FeedCreated {
  /** `/api/calendar/<secret>.ics`: shown once. */
  path: string
  createdAt: string
}

export interface IcsFile {
  text: string
  fileName: string
}

export interface CalendarApi {
  feedStatus(): Promise<ApiResult<FeedStatus>>
  /** 201 when made, 200 when one already existed (an old link, which isn't returned again). */
  createFeed(): Promise<ApiResult<FeedCreated>>
  deleteFeed(): Promise<ApiResult<null>>
  exportIcs(query: HistoryQuery): Promise<ApiResult<IcsFile>>
}

export const CALENDAR_TIMEOUT_MS = 15_000
export const FALLBACK_EXPORT_NAME = 'ineedtofocus.ics'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** The file name from `Content-Disposition: attachment; filename="…"`. */
export function fileNameFrom(header: string | null): string {
  const match = header?.match(/filename="([^"/\\]+)"/)
  return match?.[1] ?? FALLBACK_EXPORT_NAME
}

export class HttpCalendarApi implements CalendarApi {
  readonly #fetch: typeof fetch

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.#fetch = options.fetch ?? tracedFetch
  }

  async feedStatus(): Promise<ApiResult<FeedStatus>> {
    const result = await this.#send('GET', '/api/calendar/feed')
    if (result.kind !== 'ok') return result
    const body: unknown = await this.#json(result.value)
    if (!isObject(body) || typeof body.enabled !== 'boolean') return { kind: 'unavailable' }
    return {
      kind: 'ok',
      value: {
        enabled: body.enabled,
        createdAt: stringOrNull(body.created_at),
        lastFetchedAt: stringOrNull(body.last_fetched_at),
      },
    }
  }

  async createFeed(): Promise<ApiResult<FeedCreated>> {
    const result = await this.#send('POST', '/api/calendar/feed')
    if (result.kind !== 'ok') return result
    const body: unknown = await this.#json(result.value)
    if (!isObject(body) || typeof body.path !== 'string' || !body.path.startsWith('/')) {
      return { kind: 'unavailable' }
    }
    return {
      kind: 'ok',
      value: { path: body.path, createdAt: stringOrNull(body.created_at) ?? '' },
    }
  }

  async deleteFeed(): Promise<ApiResult<null>> {
    const result = await this.#send('DELETE', '/api/calendar/feed')
    return result.kind === 'ok' ? { kind: 'ok', value: null } : result
  }

  async exportIcs(query: HistoryQuery): Promise<ApiResult<IcsFile>> {
    const result = await this.#send('GET', `/api/calendar/export.ics?${historyQueryString(query)}`)
    if (result.kind !== 'ok') return result
    try {
      return {
        kind: 'ok',
        value: {
          text: await result.value.text(),
          fileName: fileNameFrom(result.value.headers.get('Content-Disposition')),
        },
      }
    } catch {
      return { kind: 'unavailable' }
    }
  }

  async #json(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  /** Success is any 2xx (create answers 201 or 200); the caller reads the body. */
  async #send(method: string, path: string): Promise<ApiResult<Response>> {
    let response: Response
    try {
      response = await this.#fetch(path, {
        method,
        credentials: 'same-origin',
        signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
      })
    } catch {
      return { kind: 'unavailable' }
    }
    if (response.ok) return { kind: 'ok', value: response }
    if (response.status === 401) return { kind: 'unauthorized' }
    if (response.status === 422) return { kind: 'invalid', error: null }
    return { kind: 'unavailable' }
  }
}
