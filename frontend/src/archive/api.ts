// The archive endpoints (_docs/api/openapi.json): archive and restore one session, list the
// archived ones, delete them all (AC11.2-AC11.6). Online only: an archive that hasn't reached
// the server never looks done.

import type { ApiResult } from '../sync/api.ts'
import { TAGS, type Mode, type Tag } from '../timer/config.ts'
import type { SessionStatus } from '../timer/engine.ts'

export interface ArchivedSession {
  id: string
  mode: Mode
  tag: Tag
  goal: string | null
  startedAt: string
  focusSeconds: number
  status: SessionStatus
  archivedAt: string
}

export interface ArchiveApi {
  /** `POST /api/sessions/{id}/archive`; the value is when it was archived. */
  archive(id: string): Promise<ApiResult<string>>
  /** `POST /api/sessions/{id}/restore`. */
  restore(id: string): Promise<ApiResult<null>>
  /** `GET /api/sessions/archived`: most recently archived first, not paginated. */
  list(): Promise<ApiResult<ArchivedSession[]>>
  /** `DELETE /api/sessions/archived`: permanent; the value is how many were deleted. */
  deleteAll(): Promise<ApiResult<number>>
}

export const ARCHIVE_TIMEOUT_MS = 15_000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseArchived(value: unknown): ArchivedSession | null {
  if (!isObject(value) || typeof value.id !== 'string') return null
  if (!TAGS.includes(value.tag as Tag)) return null
  if (typeof value.started_at !== 'string' || typeof value.archived_at !== 'string') return null
  return {
    id: value.id,
    mode: value.mode as Mode,
    tag: value.tag as Tag,
    goal: typeof value.goal === 'string' ? value.goal : null,
    startedAt: value.started_at,
    focusSeconds: typeof value.focus_seconds === 'number' ? value.focus_seconds : 0,
    status: value.status as SessionStatus,
    archivedAt: value.archived_at,
  }
}

/** The real API over `fetch`, same origin, with the session cookie. */
export class HttpArchiveApi implements ArchiveApi {
  readonly #fetch: typeof fetch

  constructor(options: { fetch?: typeof fetch } = {}) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  async archive(id: string): Promise<ApiResult<string>> {
    const result = await this.#send('POST', `/api/sessions/${encodeURIComponent(id)}/archive`)
    if (result.kind !== 'ok') return result
    const archivedAt = isObject(result.value) ? result.value.archived_at : null
    return typeof archivedAt === 'string'
      ? { kind: 'ok', value: archivedAt }
      : { kind: 'unavailable' }
  }

  async restore(id: string): Promise<ApiResult<null>> {
    const result = await this.#send('POST', `/api/sessions/${encodeURIComponent(id)}/restore`)
    return result.kind === 'ok' ? { kind: 'ok', value: null } : result
  }

  async list(): Promise<ApiResult<ArchivedSession[]>> {
    const result = await this.#send('GET', '/api/sessions/archived')
    if (result.kind !== 'ok') return result
    const items = isObject(result.value) ? result.value.sessions : null
    if (!Array.isArray(items)) return { kind: 'unavailable' }
    const sessions: ArchivedSession[] = []
    for (const item of items) {
      const parsed = parseArchived(item)
      if (parsed === null) return { kind: 'unavailable' }
      sessions.push(parsed)
    }
    return { kind: 'ok', value: sessions }
  }

  async deleteAll(): Promise<ApiResult<number>> {
    const result = await this.#send('DELETE', '/api/sessions/archived')
    if (result.kind !== 'ok') return result
    const deleted = isObject(result.value) ? result.value.deleted : null
    return typeof deleted === 'number' ? { kind: 'ok', value: deleted } : { kind: 'unavailable' }
  }

  async #send(method: string, path: string): Promise<ApiResult<unknown>> {
    let response: Response
    try {
      response = await this.#fetch(path, {
        method,
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
      })
    } catch {
      return { kind: 'unavailable' }
    }
    if (response.ok) {
      try {
        return { kind: 'ok', value: await response.json() }
      } catch {
        return { kind: 'unavailable' }
      }
    }
    if (response.status === 401) return { kind: 'unauthorized' }
    if (response.status === 404) return { kind: 'not_found' }
    if (response.status === 409) return { kind: 'conflict', error: null }
    return { kind: 'unavailable' }
  }
}
