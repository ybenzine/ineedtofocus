import { describe, expect, it } from 'vitest'
import { parseHistory } from './api.ts'

function history(session: Record<string, unknown>) {
  return {
    view: 'all',
    time_zone: 'UTC',
    week_start_day: 0,
    start: null,
    end: null,
    bucket: 'month',
    total_focus_seconds: 0,
    session_count: 1,
    tags: [],
    buckets: [],
    sessions: [
      {
        id: 's1',
        mode: 'countdown',
        tag: 'work',
        goal: null,
        started_at: '2026-10-30T09:00:00Z',
        focus_seconds: 1500,
        status: 'completed',
        ...session,
      },
    ],
  }
}

describe('parseHistory session fields for the calendar (AC14.7)', () => {
  it('reads the end, the pause and the block counts', () => {
    const parsed = parseHistory(
      history({
        mode: 'pomodoro',
        ended_at: '2026-10-30T10:00:00Z',
        paused_seconds: 300,
        blocks_completed: 2,
        mode_config: { mode: 'pomodoro', blocks: 4, focus_minutes: 25 },
      }),
    )
    expect(parsed?.sessions[0]).toMatchObject({
      endedAt: '2026-10-30T10:00:00Z',
      pausedSeconds: 300,
      blocks: 4,
      blocksCompleted: 2,
    })
  })

  it('has no blocks for other modes, even if a config carries the field', () => {
    const parsed = parseHistory(
      history({
        ended_at: '2026-10-30T09:25:00Z',
        mode_config: { mode: 'countdown', minutes: 25 },
      }),
    )
    expect(parsed?.sessions[0]).toMatchObject({
      blocks: null,
      pausedSeconds: 0,
      blocksCompleted: 0,
    })
    const odd = parseHistory(history({ mode_config: { blocks: 3 } }))
    expect(odd?.sessions[0]?.blocks).toBeNull()
  })

  it('falls back when fields are missing or of the wrong type', () => {
    const parsed = parseHistory(
      history({
        mode: 'pomodoro',
        ended_at: 5,
        paused_seconds: 'x',
        blocks_completed: null,
        mode_config: { mode: 'pomodoro', blocks: 'four' },
      }),
    )
    expect(parsed?.sessions[0]).toMatchObject({
      endedAt: '2026-10-30T09:00:00Z',
      pausedSeconds: 0,
      blocks: null,
      blocksCompleted: 0,
    })
  })
})
