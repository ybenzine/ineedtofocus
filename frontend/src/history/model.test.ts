import { describe, expect, it } from 'vitest'
import type { HistorySession } from './api.ts'
import {
  addMonths,
  bucketUnitFor,
  emptyData,
  localDate,
  mergeSessions,
  periodFor,
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
