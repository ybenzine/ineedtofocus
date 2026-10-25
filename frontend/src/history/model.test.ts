import { describe, expect, it } from 'vitest'
import type { HistorySession } from './api.ts'
import {
  addMonths,
  bucketUnitFor,
  emptyData,
  localDate,
  listedAsLive,
  missingFromServer,
  applyChanges,
  mergeSessions,
  oneLine,
  periodFor,
  removeSessions,
  shiftAnchor,
} from './model.ts'

function session(overrides: Partial<HistorySession> = {}): HistorySession {
  return {
    id: crypto.randomUUID(),
    mode: 'countdown',
    tag: 'work',
    goal: null,
    startedAt: '2026-10-21T10:00:00Z',
    focusSeconds: 600,
    status: 'completed',
    indicator: 'not-synced-yet',
    ...overrides,
  }
}

describe('periods', () => {
  it('starts weeks on the configured day', () => {
    // 2026-10-21 is a Wednesday.
    expect(periodFor('week', '2026-10-21', 0)).toEqual({ start: '2026-10-18', end: '2026-10-24' })
    expect(periodFor('week', '2026-10-21', 1)).toEqual({ start: '2026-10-19', end: '2026-10-25' })
  })

  it('covers a whole month', () => {
    expect(periodFor('month', '2026-02-10', 0)).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('moves by one period', () => {
    expect(shiftAnchor('day', '2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftAnchor('week', '2026-10-21', 1)).toBe('2026-10-28')
    expect(shiftAnchor('month', '2026-01-31', -1)).toBe('2025-12-01')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-01')
  })

  it('uses day bars up to 62 days and month bars from 63', () => {
    expect(bucketUnitFor('custom', { start: '2026-07-01', end: '2026-08-31' })).toBe('day')
    expect(bucketUnitFor('custom', { start: '2026-07-01', end: '2026-09-01' })).toBe('month')
    expect(bucketUnitFor('all', null)).toBe('month')
    expect(bucketUnitFor('week', { start: '2026-10-18', end: '2026-10-24' })).toBe('day')
  })

  it('finds the local date in a zone', () => {
    expect(localDate('2026-10-21T23:30:00Z', 'UTC')).toBe('2026-10-21')
    expect(localDate('2026-10-21T23:30:00Z', 'Asia/Tokyo')).toBe('2026-10-22')
    expect(localDate('2026-10-21T01:30:00Z', 'America/New_York')).toBe('2026-10-20')
  })

  it('assigns the right local date across DST changes', () => {
    const ny = 'America/New_York'
    // Fall back (25 h day): 1 Nov 2026.
    expect(localDate('2026-11-01T05:30:00Z', ny)).toBe('2026-11-01')
    expect(localDate('2026-11-02T04:59:00Z', ny)).toBe('2026-11-01')
    expect(localDate('2026-11-02T05:00:00Z', ny)).toBe('2026-11-02')
    // Spring forward (23 h day): 8 Mar 2026.
    expect(localDate('2026-03-08T06:59:00Z', ny)).toBe('2026-03-08')
    expect(localDate('2026-03-09T03:59:00Z', ny)).toBe('2026-03-08')
    expect(localDate('2026-03-09T04:00:00Z', ny)).toBe('2026-03-09')
  })
})

describe('mergeSessions', () => {
  const week = () => emptyData('week', 'UTC', 0, { start: '2026-10-18', end: '2026-10-24' })

  it('adds an unsynced session to the list, totals, tags and its day bar', () => {
    const merged = mergeSessions(week(), [session()], [])
    expect(merged.sessionCount).toBe(1)
    expect(merged.totalFocusSeconds).toBe(600)
    expect(merged.tags).toEqual([{ tag: 'work', focusSeconds: 600, sessions: 1 }])
    expect(merged.buckets).toHaveLength(7)
    expect(merged.buckets.find((b) => b.date === '2026-10-21')?.focusSeconds).toBe(600)
    expect(merged.sessions).toHaveLength(1)
  })

  it('leaves out sessions outside the period, other tags and ones the server has', () => {
    const base = mergeSessions(week(), [session({ id: 'a', indicator: 'synced' })], [])
    const merged = mergeSessions(
      base,
      [
        session({ id: 'a' }),
        session({ startedAt: '2026-10-25T10:00:00Z' }),
        session({ tag: 'read' }),
      ],
      ['work'],
    )
    expect(merged.sessionCount).toBe(1)
  })

  it('lists newest first', () => {
    const merged = mergeSessions(
      week(),
      [
        session({ id: 'old', startedAt: '2026-10-19T10:00:00Z' }),
        session({ id: 'new', startedAt: '2026-10-22T10:00:00Z' }),
      ],
      [],
    )
    expect(merged.sessions.map((s) => s.id)).toEqual(['new', 'old'])
  })

  it('builds month bars for All time, zero-filled between', () => {
    const merged = mergeSessions(
      emptyData('all', 'UTC', 0, null),
      [
        session({ startedAt: '2026-08-05T10:00:00Z' }),
        session({ startedAt: '2026-10-05T10:00:00Z' }),
      ],
      [],
    )
    expect(merged.bucket).toBe('month')
    expect(merged.buckets.map((b) => [b.date, b.sessions])).toEqual([
      ['2026-08-01', 1],
      ['2026-09-01', 0],
      ['2026-10-01', 1],
    ])
    expect(merged.start).toBe('2026-08-05')
    expect(merged.end).toBe('2026-10-05')
  })
})

describe('removeSessions', () => {
  it('takes archived sessions out of the list, totals, tags and bars', () => {
    const keep = session({ tag: 'work', focusSeconds: 600 })
    const gone = session({ tag: 'nap', focusSeconds: 300 })
    const base = mergeSessions(
      emptyData('day', 'UTC', 1, { start: '2026-10-21', end: '2026-10-21' }),
      [keep, gone],
      [],
    )
    const next = removeSessions(base, new Set([gone.id]))
    expect(next.sessionCount).toBe(1)
    expect(next.totalFocusSeconds).toBe(600)
    expect(next.tags.map((t) => t.tag)).toEqual(['work'])
    expect(next.buckets[0]).toMatchObject({ focusSeconds: 600, sessions: 1 })
    expect(next.sessions).toEqual([keep])
    expect(removeSessions(base, new Set(['other']))).toBe(base)
  })
})

describe('applyChanges', () => {
  it('shows an unconfirmed edit and moves its time between tags', () => {
    const edited = session({ tag: 'work', focusSeconds: 600 })
    const base = mergeSessions(
      emptyData('day', 'UTC', 1, { start: '2026-10-21', end: '2026-10-21' }),
      [edited],
      [],
    )
    const next = applyChanges(base, new Map([[edited.id, { tag: 'read' as const, goal: 'New' }]]))
    expect(next.sessions[0]).toMatchObject({ tag: 'read', goal: 'New' })
    expect(next.tags).toEqual([{ tag: 'read', focusSeconds: 600, sessions: 1 }])
    expect(next.totalFocusSeconds).toBe(600)
    expect(applyChanges(base, new Map())).toBe(base)
  })
})

describe('oneLine', () => {
  it('turns line breaks into single spaces (AC7.3)', () => {
    expect(oneLine('a\nb\r\n  c')).toBe('a b c')
  })
})

describe('missingFromServer', () => {
  const dev = (
    id: string,
    startedAt: string,
    o: { synced?: boolean; archived?: boolean } = {},
  ) => ({
    id,
    startedAt,
    synced: true,
    archived: false,
    ...o,
  })
  const none = new Set<string>()
  const week = emptyData('week', 'UTC', 1, { start: '2026-10-19', end: '2026-10-25' })

  it('lists synced sessions inside the period that the server does not', () => {
    const base = { ...week, sessions: [session({ id: 'known' })] }
    const device = [dev('known', '2026-10-21T10:00:00Z'), dev('gone', '2026-10-21T11:00:00Z')]
    expect(missingFromServer(base, device, [], none)).toEqual(['gone'])
  })

  it('returns nothing when a tag filter is on', () => {
    expect(missingFromServer(week, [dev('a', '2026-10-21T10:00:00Z')], ['work'], none)).toEqual([])
  })

  it('leaves out ids in skip, archived and unsynced sessions', () => {
    const device = [
      dev('skipped', '2026-10-21T10:00:00Z'),
      dev('archived', '2026-10-21T10:00:00Z', { archived: true }),
      dev('unsynced', '2026-10-21T10:00:00Z', { synced: false }),
    ]
    expect(missingFromServer(week, device, [], new Set(['skipped']))).toEqual([])
  })

  it('checks every synced session in the All time view, which has no start or end', () => {
    const all = emptyData('all', 'UTC', 1, null)
    expect(missingFromServer(all, [dev('old', '2020-01-01T00:00:00Z')], [], none)).toEqual(['old'])
  })

  it('uses the local date, not the UTC date', () => {
    // 2026-10-26 02:00 UTC is still Sunday 25th, the last day of the week, in Los Angeles.
    const la = emptyData('week', 'America/Los_Angeles', 1, {
      start: '2026-10-19',
      end: '2026-10-25',
    })
    expect(missingFromServer(la, [dev('late', '2026-10-26T02:00:00Z')], [], none)).toEqual(['late'])
    // 2026-10-19 03:00 UTC is still Sunday 18th in Los Angeles: before the week.
    expect(missingFromServer(la, [dev('early', '2026-10-19T03:00:00Z')], [], none)).toEqual([])
  })

  it('checks the first and last days of a custom range, with a margin at the edges', () => {
    const range = emptyData('custom', 'UTC', 1, { start: '2026-10-10', end: '2026-10-12' })
    const ids = (startedAt: string) => missingFromServer(range, [dev('x', startedAt)], [], none)
    expect(ids('2026-10-10T12:00:00Z')).toEqual(['x'])
    expect(ids('2026-10-12T12:00:00Z')).toEqual(['x'])
    expect(ids('2026-10-10T01:00:00Z')).toEqual([])
    expect(ids('2026-10-12T22:30:00Z')).toEqual([])
    expect(ids('2026-10-13T01:00:00Z')).toEqual([])
    expect(ids('2026-10-09T23:00:00Z')).toEqual([])
  })
})

describe('listedAsLive', () => {
  const base = emptyData('week', 'UTC', 1, { start: '2026-10-19', end: '2026-10-25' })

  it('lists device sessions marked archived that the server lists as live', () => {
    const withServer = { ...base, sessions: [session({ id: 'a' }), session({ id: 'b' })] }
    const device = [
      { id: 'a', archived: true },
      { id: 'b', archived: false },
      { id: 'c', archived: true },
    ]
    expect(listedAsLive(withServer, device)).toEqual(['a'])
  })

  it('lists nothing for an empty answer', () => {
    expect(listedAsLive(base, [{ id: 'a', archived: true }])).toEqual([])
  })
})
