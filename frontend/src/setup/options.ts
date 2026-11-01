/** AC7.3 */
export const GOAL_MAX_LENGTH = 120

/** AC8.1. The choice is only recorded here; playback arrives with #17 (Rain) and #18 (YouTube). */
export const AUDIO_SOURCES = ['none', 'rain', 'youtube'] as const
export type AudioSource = (typeof AUDIO_SOURCES)[number]

/** AC2.6. The row can grow by one: the recent custom time (#409) goes after these. */
export const COUNTDOWN_PRESETS: readonly number[] = [15, 30, 45, 60, 90]

/** A custom Countdown length worth remembering: whole minutes in 1-240 that no preset covers (AC2.7). */
export function recentCustomMinutes(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 240 &&
    !COUNTDOWN_PRESETS.includes(value)
    ? value
    : null
}

/** The end time under the dial is recomputed this often; it only repaints, never announces. */
export const CLOCK_REFRESH_MS = 20_000

export const AUDIO_LABELS: Record<AudioSource, string> = {
  none: 'None',
  rain: 'Rain',
  youtube: 'YouTube',
}

/** Line breaks in a goal become a single space (AC7.3). */
export function cleanGoal(text: string): string {
  return text.replace(/[\r\n]+/g, ' ')
}
