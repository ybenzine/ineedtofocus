import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceTimeZone, historyQueryString, HttpHistoryApi } from './api.ts'

const body = {
  view: 'week',
  time_zone: 'UTC',
  week_start_day: 1,
  start: '2026-10-19',
  end: '2026-10-25',
  bucket: 'day',
  total_focus_seconds: 600,
  session_count: 1,
  tags: [{ tag: 'work', focus_seconds: 600, sessions: 1 }],
  buckets: [{ date: '2026-10-19', focus_seconds: 600, sessions: 1 }],
  sessions: [
    {
      id: 'x',
      mode: 'countdown',
      tag: 'work',
      goal: 'Essay',
      started_at: '2026-10-19T10:00:00Z',
      focus_seconds: 600,
      status: 'completed',
    },
  ],
}

afterEach(() => vi.restoreAllMocks())

describe('historyQueryString', () => {
  it('sends only the params the view takes, with repeated tags', () => {
    expect(
      historyQueryString({
        view: 'week',
        tz: 'Europe/Paris',
        date: '2026-10-21',
        tags: ['work', 'read'],
      }),
    ).toBe('view=week&tz=Europe%2FParis&date=2026-10-21&tag=work&tag=read')
    expect(
      historyQueryString({ view: 'custom', tz: 'UTC', date: 'x', start: 'a', end: 'b', tags: [] }),
    ).toBe('view=custom&tz=UTC&start=a&end=b')
    expect(historyQueryString({ view: 'all', tz: 'UTC', date: 'x', tags: [] })).toBe(
      'view=all&tz=UTC',
    )
  })
})

describe('deviceTimeZone', () => {
  it('uses the zone the device reports, or UTC if none', () => {
    const resolved = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    resolved.mockReturnValue({ timeZone: 'Asia/Tokyo' } as Intl.ResolvedDateTimeFormatOptions)
    expect(deviceTimeZone()).toBe('Asia/Tokyo')
    resolved.mockReturnValue({
      timeZone: undefined,
    } as unknown as Intl.ResolvedDateTimeFormatOptions)
    expect(deviceTimeZone()).toBe('UTC')
  })
})

describe('HttpHistoryApi', () => {
  const query = { view: 'week', tz: 'UTC', date: '2026-10-21', tags: [] } as const

  it('parses the response into camelCase', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body)))
    const result = await new HttpHistoryApi({ fetch: fetcher }).get(query)
    expect(String(fetcher.mock.calls[0][0])).toBe('/api/history?view=week&tz=UTC&date=2026-10-21')
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.value.weekStartDay).toBe(1)
    expect(result.value.sessions[0]).toMatchObject({ goal: 'Essay', indicator: 'synced' })
    expect(result.value.buckets[0].focusSeconds).toBe(600)
  })

  it('maps failures', async () => {
    const reply = (status: number) =>
      new HttpHistoryApi({ fetch: async () => new Response('{}', { status }) }).get(query)
    expect((await reply(401)).kind).toBe('unauthorized')
    expect((await reply(422)).kind).toBe('invalid')
    expect((await reply(503)).kind).toBe('unavailable')
    const offline = new HttpHistoryApi({ fetch: () => Promise.reject(new TypeError('offline')) })
    expect((await offline.get(query)).kind).toBe('unavailable')
  })
})
