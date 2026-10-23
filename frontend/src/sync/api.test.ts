import { describe, expect, it, vi } from 'vitest'
import { makeRecord } from '../test/fakeSessionsServer.ts'
import { HttpSessionsApi, toSessionIn } from './api.ts'

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn<typeof fetch>(async () =>
    typeof body === 'string'
      ? new Response(body, { status })
      : new Response(JSON.stringify(body), { status }),
  )
}

describe('toSessionIn', () => {
  it('maps a countdown session to snake_case', () => {
    const record = makeRecord({ goal: 'Essay' })
    expect(toSessionIn(record)).toEqual({
      id: record.id,
      mode: 'countdown',
      tag: 'work',
      goal: 'Essay',
      started_at: record.startedAt,
      ended_at: record.endedAt,
      focus_seconds: 1500,
      paused_seconds: 0,
      status: 'completed',
      mode_config: { mode: 'countdown', minutes: 25 },
      blocks_completed: 0,
    })
  })

  it('maps the Pomodoro and unlimited configurations', () => {
    const pomodoro = makeRecord({
      mode: 'pomodoro',
      blocksCompleted: 2,
      modeConfig: {
        mode: 'pomodoro',
        focusMinutes: 25,
        breakMinutes: 5,
        blocks: 4,
        longBreakEnabled: true,
        longBreakMinutes: 15,
      },
    })
    expect(toSessionIn(pomodoro).mode_config).toEqual({
      mode: 'pomodoro',
      focus_minutes: 25,
      break_minutes: 5,
      blocks: 4,
      long_break_enabled: true,
      long_break_minutes: 15,
    })
    expect(toSessionIn(pomodoro).blocks_completed).toBe(2)
    const unlimited = makeRecord({
      mode: 'unlimited',
      modeConfig: { mode: 'unlimited', reminderMinutes: null },
    })
    expect(toSessionIn(unlimited).mode_config).toEqual({
      mode: 'unlimited',
      reminder_minutes: null,
    })
  })
})

describe('HttpSessionsApi', () => {
  it('posts a batch to the sync endpoint with the session cookie and reads per-item results', async () => {
    const record = makeRecord()
    const fetch = respond(200, {
      created: 1,
      existing: 0,
      rejected: 1,
      results: [
        {
          index: 0,
          id: record.id,
          status: 'created',
          session: { id: record.id, tag: 'work', goal: null, archived_at: null },
        },
        {
          index: 1,
          id: null,
          status: 'rejected',
          error: { code: 'validation_error', message: 'Invalid', details: [] },
        },
      ],
    })
    const api = new HttpSessionsApi({ fetch })
    const result = await api.sync([record])
    expect(result).toEqual({
      kind: 'ok',
      value: [
        {
          index: 0,
          id: record.id,
          status: 'created',
          session: { id: record.id, tag: 'work', goal: null, archivedAt: null },
          error: null,
        },
        {
          index: 1,
          id: null,
          status: 'rejected',
          session: null,
          error: { code: 'validation_error', message: 'Invalid' },
        },
      ],
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/sessions/sync')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(JSON.parse(String(init?.body))).toEqual({ sessions: [toSessionIn(record)] })
  })

  it('sends an edit as PATCH with only the changed fields', async () => {
    const fetch = respond(200, { id: 'abc', tag: 'read', goal: null, archived_at: null })
    const api = new HttpSessionsApi({ fetch })
    const result = await api.edit('abc', { goal: null })
    expect(result).toEqual({
      kind: 'ok',
      value: { id: 'abc', tag: 'read', goal: null, archivedAt: null },
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/sessions/abc')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ goal: null })
  })

  it.each([
    [401, { error: { code: 'unauthorized', message: 'x' } }, { kind: 'unauthorized' }],
    [404, { error: { code: 'not_found', message: 'x' } }, { kind: 'not_found' }],
    [
      409,
      { error: { code: 'conflict', message: 'Archived' } },
      { kind: 'conflict', error: { code: 'conflict', message: 'Archived' } },
    ],
    [
      422,
      { error: { code: 'validation_error', message: 'Bad' } },
      { kind: 'invalid', error: { code: 'validation_error', message: 'Bad' } },
    ],
    [500, { error: { code: 'internal', message: 'x' } }, { kind: 'unavailable' }],
    [503, 'Bad gateway', { kind: 'unavailable' }],
    [429, { error: { code: 'rate_limited', message: 'x' } }, { kind: 'unavailable' }],
    [200, 'not json', { kind: 'unavailable' }],
    [200, { unexpected: true }, { kind: 'unavailable' }],
  ])('classifies HTTP %i as the sync engine needs it', async (status, body, expected) => {
    const api = new HttpSessionsApi({ fetch: respond(status, body) })
    expect(await api.edit('abc', { tag: 'work' })).toEqual(expected)
  })

  it('treats a network error as unavailable', async () => {
    const api = new HttpSessionsApi({
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(await api.sync([makeRecord()])).toEqual({ kind: 'unavailable' })
  })

  it('treats a malformed sync reply as unavailable', async () => {
    const api = new HttpSessionsApi({ fetch: respond(200, { results: [{ index: 0 }] }) })
    expect(await api.sync([makeRecord()])).toEqual({ kind: 'unavailable' })
  })
})
