import { describe, expect, it, vi } from 'vitest'
import { HttpArchiveApi } from './api.ts'

function reply(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch
}

const session = {
  id: 'a',
  mode: 'countdown',
  tag: 'work',
  goal: null,
  started_at: '2026-10-20T09:00:00Z',
  focus_seconds: 600,
  status: 'completed',
  archived_at: '2026-10-21T09:00:00Z',
}

describe('HttpArchiveApi', () => {
  it('lists archived sessions', async () => {
    const api = new HttpArchiveApi({ fetch: reply(200, { sessions: [session] }) })
    const result = await api.list()
    expect(result).toEqual({
      kind: 'ok',
      value: [
        {
          id: 'a',
          mode: 'countdown',
          tag: 'work',
          goal: null,
          startedAt: '2026-10-20T09:00:00Z',
          focusSeconds: 600,
          status: 'completed',
          archivedAt: '2026-10-21T09:00:00Z',
        },
      ],
    })
  })

  it('calls the documented endpoints', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    const api = new HttpArchiveApi({ fetch: fetchMock as unknown as typeof fetch })
    expect(await api.archive('a b')).toEqual({ kind: 'ok', value: '2026-10-21T09:00:00Z' })
    expect(await api.restore('a')).toEqual({ kind: 'ok', value: null })
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'POST /api/sessions/a%20b/archive',
      'POST /api/sessions/a/restore',
    ])
  })

  it('returns the count deleted', async () => {
    const api = new HttpArchiveApi({ fetch: reply(200, { deleted: 4 }) })
    expect(await api.deleteAll()).toEqual({ kind: 'ok', value: 4 })
  })

  it('maps failures', async () => {
    expect((await new HttpArchiveApi({ fetch: reply(401, {}) }).list()).kind).toBe('unauthorized')
    expect((await new HttpArchiveApi({ fetch: reply(404, {}) }).restore('x')).kind).toBe(
      'not_found',
    )
    expect((await new HttpArchiveApi({ fetch: reply(503, {}) }).deleteAll()).kind).toBe(
      'unavailable',
    )
    expect((await new HttpArchiveApi({ fetch: reply(200, { nope: 1 }) }).list()).kind).toBe(
      'unavailable',
    )
    const down = vi.fn().mockRejectedValue(new TypeError('offline')) as unknown as typeof fetch
    expect((await new HttpArchiveApi({ fetch: down }).archive('x')).kind).toBe('unavailable')
  })
})
