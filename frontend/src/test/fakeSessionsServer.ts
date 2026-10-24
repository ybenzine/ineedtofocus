// An in-memory stand-in for the sessions API (_docs/api/openapi.json), reached through `fetch`,
// so tests exercise the real HTTP client and sync engine together. It follows the documented
// semantics: idempotent by id, per-item results, 409 on editing an archived session.

import type { SessionRecord } from '../timer/engine.ts'

type Mode =
  /** Answers normally. */
  | 'up'
  /** Network error: nothing reaches the server. */
  | 'offline'
  /** 503: the server saves nothing. */
  | 'down'
  /** 401 on every call. */
  | 'signed-out'
  /** Saves the request, then the reply is lost (network error); next call answers normally. */
  | 'lose-reply'

interface StoredItem {
  item: Record<string, unknown>
  archivedAt: string | null
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

export class FakeSessionsServer {
  mode: Mode = 'up'
  /** Edits (PATCH) answer 503 while everything else works. */
  failEdits = false
  readonly sessions = new Map<string, StoredItem>()
  /** Ids sent in each sync request, in order. */
  readonly syncRequests: string[][] = []
  /** Every edit request. */
  readonly editRequests: { id: string; body: Record<string, unknown> }[] = []
  /** Ids that belong to another account: rejected with `conflict`. */
  readonly otherAccount = new Set<string>()

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url, 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    this.requests.push(`${method} ${path}`)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}

    if (this.mode === 'offline') throw new TypeError('Failed to fetch')
    if (this.mode === 'down') return json(503, errorBody('unavailable', 'Try again later'))
    if (this.mode === 'signed-out') return json(401, errorBody('unauthorized', 'Sign in'))

    let response: Response
    if (method === 'POST' && path === '/api/sessions/sync') {
      response = this.#sync(body)
    } else {
      const match = /^\/api\/sessions\/([^/]+)$/.exec(path)
      const action = /^\/api\/sessions\/([^/]+)\/(archive|restore)$/.exec(path)
      if (method === 'PATCH' && match) response = this.#edit(decodeURIComponent(match[1]), body)
      else if (method === 'POST' && action) {
        response = this.#setArchived(decodeURIComponent(action[1]), action[2] === 'archive')
      } else if (method === 'GET' && path === '/api/sessions/archived') {
        const sessions = [...this.sessions.keys()]
          .filter((id) => this.sessions.get(id)?.archivedAt != null)
          .map((id) => this.#out(id))
          .sort((x, y) => String(y.archived_at).localeCompare(String(x.archived_at)))
        response = json(200, { sessions })
      } else if (method === 'DELETE' && path === '/api/sessions/archived') {
        const ids = [...this.sessions.keys()].filter(
          (id) => this.sessions.get(id)?.archivedAt != null,
        )
        for (const id of ids) this.sessions.delete(id)
        response = json(200, { deleted: ids.length })
      } else response = json(404, errorBody('not_found', 'Not found'))
    }
    if (this.mode === 'lose-reply') {
      this.mode = 'up'
      throw new TypeError('Network connection was lost')
    }
    return response
  }

  /** Every request made, as `METHOD path`. */
  readonly requests: string[] = []
  #clock = 0

  #setArchived(id: string, archived: boolean): Response {
    const stored = this.sessions.get(id)
    if (!stored) return json(404, errorBody('not_found', 'Session not found'))
    this.#clock += 1
    if (archived && stored.archivedAt === null) {
      stored.archivedAt = new Date(Date.UTC(2026, 9, 23, 12, 0, this.#clock)).toISOString()
    }
    if (!archived) stored.archivedAt = null
    return json(200, this.#out(id))
  }

  /** Archives a session, as if from another device. */
  archive(id: string): void {
    const stored = this.sessions.get(id)
    if (stored) stored.archivedAt = '2026-10-23T12:00:00Z'
  }

  get(id: string): Record<string, unknown> | undefined {
    return this.sessions.get(id)?.item
  }

  #out(id: string): Record<string, unknown> {
    const stored = this.sessions.get(id)
    if (!stored) throw new Error(`No session ${id}`)
    return { ...stored.item, archived_at: stored.archivedAt, created_at: '2026-10-23T00:00:00Z' }
  }

  #sync(body: Record<string, unknown>): Response {
    const items = body.sessions
    if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
      return json(422, errorBody('validation_error', 'Invalid request'))
    }
    this.syncRequests.push(items.map((item: Record<string, unknown>) => String(item.id)))
    const counts = { created: 0, existing: 0, rejected: 0 }
    const results = items.map((item: Record<string, unknown>, index: number) => {
      const id = typeof item.id === 'string' ? item.id : null
      const reject = (code: string, message: string) => {
        counts.rejected += 1
        return { index, id, status: 'rejected', session: null, error: { code, message } }
      }
      if (id === null) return reject('validation_error', 'id is required')
      if (this.otherAccount.has(id)) return reject('conflict', 'Session id already in use')
      if (typeof item.focus_seconds !== 'number' || item.focus_seconds < 60) {
        return reject('validation_error', 'focus_seconds must be at least 60')
      }
      if (this.sessions.has(id)) {
        counts.existing += 1
        return { index, id, status: 'existing', session: this.#out(id), error: null }
      }
      this.sessions.set(id, { item: { ...item }, archivedAt: null })
      counts.created += 1
      return { index, id, status: 'created', session: this.#out(id), error: null }
    })
    return json(200, { ...counts, results })
  }

  #edit(id: string, body: Record<string, unknown>): Response {
    this.editRequests.push({ id, body })
    if (this.failEdits) return json(503, errorBody('unavailable', 'Try again later'))
    const stored = this.sessions.get(id)
    if (!stored) return json(404, errorBody('not_found', 'Session not found'))
    if (stored.archivedAt !== null) {
      return json(409, errorBody('conflict', 'Archived sessions cannot be edited'))
    }
    if ('goal' in body && typeof body.goal === 'string' && body.goal.length > 120) {
      return json(422, errorBody('validation_error', 'goal is too long'))
    }
    stored.item = { ...stored.item, ...body }
    return json(200, this.#out(id))
  }
}

let counter = 0

/** A valid finished session; each call gets a fresh id. */
export function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  counter += 1
  const start = Date.UTC(2026, 9, 23, 9, 0, 0) + counter * 3_600_000
  return {
    id: crypto.randomUUID(),
    mode: 'countdown',
    tag: 'work',
    goal: null,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 25 * 60_000).toISOString(),
    focusSeconds: 25 * 60,
    pausedSeconds: 0,
    status: 'completed',
    modeConfig: { mode: 'countdown', minutes: 25 },
    blocksCompleted: 0,
    ...overrides,
  }
}

/** A database name no other test uses. */
export function freshDbName(): string {
  return `ineedtofocus-test-${crypto.randomUUID()}`
}
