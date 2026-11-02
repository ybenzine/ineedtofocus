import type { SessionRecord } from '../timer/index.ts'
import type { CalendarSession } from './AddToCalendar.tsx'

/** The calendar's view of a session record held on this device. */
export function recordToCalendarSession(record: SessionRecord): CalendarSession {
  return {
    id: record.id,
    mode: record.mode,
    tag: record.tag,
    goal: record.goal,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    focusSeconds: record.focusSeconds,
    pausedSeconds: record.pausedSeconds,
    status: record.status,
    blocks: record.modeConfig.mode === 'pomodoro' ? record.modeConfig.blocks : null,
    blocksCompleted: record.blocksCompleted,
  }
}
