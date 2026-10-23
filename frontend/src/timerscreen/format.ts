// Display helpers for the timer screen.

const SECOND_MS = 1000

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatSeconds(total: number): string {
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** "24:59" or "1:05:00". Rounds up, so a countdown shows 00:00 only when it is really over. */
export function formatCountdown(ms: number): string {
  return formatSeconds(Math.ceil(Math.max(0, ms) / SECOND_MS))
}

/** Elapsed time, rounded down, counting up from 00:00. */
export function formatElapsed(ms: number): string {
  return formatSeconds(Math.floor(Math.max(0, ms) / SECOND_MS))
}

/** "1 h 05 min", "25 min", "40 s": for the summary. */
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours > 0) return `${hours} h ${pad(minutes)} min`
  if (minutes > 0) return `${minutes} min`
  return `${totalSeconds} s`
}
