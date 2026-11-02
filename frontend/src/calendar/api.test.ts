import { describe, expect, it, vi } from 'vitest'
import { HttpCalendarApi, fileNameFrom } from './api.ts'
import { relativeTime, subscribeLinks } from './links.ts'

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(
    async () =>
      new Response(body === '' ? null : typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers,
      }),
  )
  return { fetchMock, api: new HttpCalendarApi({ fetch: fetchMock as unknown as typeof fetch }) }
}

describe('HttpCalendarApi', () => {
  it('reads the feed status', async () => {
    const { api, fetchMock } = reply(200, {
      enabled: true,
      created_at: '2026-10-30T10:00:00Z',
      last_fetched_at: null,
    })
    expect(await api.feedStatus()).toEqual({
      kind: 'ok',
      value: { enabled: true, createdAt: '2026-10-30T10:00:00Z', lastFetchedAt: null },
    })
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/calendar/feed')
    expect(init.method).toBe('GET')
  })

  it.each([200, 201])('treats %i from POST /api/calendar/feed as success', async (status) => {
    const { api, fetchMock } = reply(status, {
      path: '/api/calendar/abc.ics',
      created_at: '2026-11-02T10:00:00Z',
    })
    expect(await api.createFeed()).toEqual({
      kind: 'ok',
      value: { path: '/api/calendar/abc.ics', createdAt: '2026-11-02T10:00:00Z' },
    })
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('POST')
  })

  it('rejects a create answer with no path, and maps failures', async () => {
    expect((await reply(201, {}).api.createFeed()).kind).toBe('unavailable')
    expect((await reply(401, {}).api.createFeed()).kind).toBe('unauthorized')
    expect((await reply(500, {}).api.feedStatus()).kind).toBe('unavailable')
    const down = new HttpCalendarApi({
      fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    })
    expect((await down.deleteFeed()).kind).toBe('unavailable')
  })

  it('deletes with 204', async () => {
    const { api, fetchMock } = reply(204, '')
    expect(await api.deleteFeed()).toEqual({ kind: 'ok', value: null })
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('DELETE')
  })

  describe('exportIcs', () => {
    const base = { tz: 'Europe/Paris' }
    const cases = [
      [
        { ...base, view: 'day', date: '2026-10-21', tags: [] },
        'view=day&tz=Europe%2FParis&date=2026-10-21',
      ],
      [
        { ...base, view: 'week', date: '2026-10-21', tags: ['work'] },
        'view=week&tz=Europe%2FParis&date=2026-10-21&tag=work',
      ],
      [
        { ...base, view: 'month', date: '2026-10-21', tags: ['work', 'nap'] },
        'view=month&tz=Europe%2FParis&date=2026-10-21&tag=work&tag=nap',
      ],
      [{ ...base, view: 'all', tags: [] }, 'view=all&tz=Europe%2FParis'],
      [
        { ...base, view: 'custom', start: '2026-10-01', end: '2026-10-09', tags: ['read'] },
        'view=custom&tz=Europe%2FParis&start=2026-10-01&end=2026-10-09&tag=read',
      ],
    ] as const

    it.each(cases)('asks with the History request’s parameters: %j', async (query, params) => {
      const { api, fetchMock } = reply(200, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', {
        'Content-Disposition': 'attachment; filename="ineedtofocus-all.ics"',
      })
      const result = await api.exportIcs({ ...query, tags: [...query.tags] })
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
        `/api/calendar/export.ics?${params}`,
      )
      expect(result).toEqual({
        kind: 'ok',
        value: { text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', fileName: 'ineedtofocus-all.ics' },
      })
    })

    it('reads the file name, and falls back safely', () => {
      expect(fileNameFrom('attachment; filename="ineedtofocus-2026-10-01-to-2026-10-09.ics"')).toBe(
        'ineedtofocus-2026-10-01-to-2026-10-09.ics',
      )
      expect(fileNameFrom(null)).toBe('ineedtofocus.ics')
      expect(fileNameFrom('attachment; filename="../../x"')).toBe('ineedtofocus.ics')
    })

    it('maps a refusal', async () => {
      expect((await reply(422, {}).api.exportIcs({ view: 'day', tz: 'UTC', tags: [] })).kind).toBe(
        'invalid',
      )
    })
  })
})

describe('subscribeLinks', () => {
  it('builds the https, webcal and Google forms', () => {
    const links = subscribeLinks('/api/calendar/abc.ics', 'https://ineedtofoc.us')
    expect(links.https).toBe('https://ineedtofoc.us/api/calendar/abc.ics')
    expect(links.webcal).toBe('webcal://ineedtofoc.us/api/calendar/abc.ics')
    expect(links.google).toBe(
      'https://calendar.google.com/calendar/r?cid=https%3A%2F%2Fineedtofoc.us%2Fapi%2Fcalendar%2Fabc.ics',
    )
  })

  it('makes a webcal link for a local http origin too', () => {
    expect(subscribeLinks('/api/calendar/x.ics', 'http://localhost:8000').webcal).toBe(
      'webcal://localhost:8000/api/calendar/x.ics',
    )
  })
})

describe('relativeTime', () => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  it.each([
    [30_000, 'just now'],
    [60_000, '1 minute ago'],
    [5 * 60_000, '5 minutes ago'],
    [2 * 3_600_000, '2 hours ago'],
    [3 * 86_400_000, '3 days ago'],
  ])('%i ms ago reads %s', (ms, text) => {
    expect(relativeTime(new Date(now - ms).toISOString(), now)).toBe(text)
  })
})
