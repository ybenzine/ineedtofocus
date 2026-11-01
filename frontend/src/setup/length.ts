// The summary line under the dial (AC2.6, AC3.8, AC4.6): "30m → 2:35 pm", "1h 55m → 4:10 pm".

import { MINUTE_MS, pomodoroPlan, type PomodoroConfig } from '../timer/index.ts'

/** A length: `30m`, `1h`, `1h 55m`. No space between a number and its unit; a whole hour drops the minutes. */
export function formatLength(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

/**
 * The clock time a session of `minutes` ends if it starts at `now`, in the locale's own hour
 * cycle and without a date: `2:35 pm` (a lowercase am/pm after a space) or `14:35`.
 */
export function formatEndTime(now: number, minutes: number, locale?: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(new Date(now + minutes * MINUTE_MS))
  return parts
    .map((part) => {
      if (part.type === 'dayPeriod') return part.value.toLowerCase()
      // Newer ICU puts a narrow no-break space before the am/pm; a plain space reads the same.
      if (part.type === 'literal') return part.value.replace(/\s+/g, ' ')
      return part.value
    })
    .join('')
}

/** `30m → 2:35 pm` */
export function summaryLine(now: number, minutes: number, locale?: string): string {
  return `${formatLength(minutes)} → ${formatEndTime(now, minutes, locale)}`
}

/** The length of a whole Pomodoro: every focus block and every break between them (AC3.3, AC3.8). */
export function pomodoroTotalMinutes(config: PomodoroConfig): number {
  return pomodoroPlan(config).reduce((sum, phase) => sum + phase.durationMs / MINUTE_MS, 0)
}

/** `chime every 30m`, or `no reminders` (AC4.6). */
export function chimeLine(reminderMinutes: number | null): string {
  return reminderMinutes === null ? 'no reminders' : `chime every ${formatLength(reminderMinutes)}`
}
