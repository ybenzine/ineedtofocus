// The dial's geometry and stepping (AC2.6, AC3.8, AC9.5). Pure, so it is tested without a DOM.

import { pomodoroPlan, type PomodoroConfig } from '../timer/index.ts'

/** The ring reads like a clock: one lap is 60 minutes (AC9.5). */
export const LAP_MINUTES = 60

export type Shade = 'accent' | 'light'

/** A stretch of the ring, as fractions of a lap from the top, clockwise. */
export interface Arc {
  shade: Shade
  from: number
  to: number
}

/**
 * A Countdown's arcs, bottom to top. Up to 60 minutes: `minutes / 60` of a lap in the accent.
 * Past 60 the full laps alternate between the accent and the lighter shade, starting with the
 * accent, and the current partial lap is drawn on top: 90 is an accent lap and half a lighter
 * lap; 150 is a lighter lap and half an accent lap. Only the last full lap can show beneath the
 * partial one, so only it is returned.
 */
export function countdownArcs(minutes: number): Arc[] {
  if (!Number.isFinite(minutes) || minutes <= 0) return []
  const laps = Math.floor(minutes / LAP_MINUTES)
  const rest = (minutes % LAP_MINUTES) / LAP_MINUTES
  const shadeOfLap = (lap: number): Shade => (lap % 2 === 1 ? 'accent' : 'light')
  const arcs: Arc[] = []
  if (laps >= 1) arcs.push({ shade: shadeOfLap(laps), from: 0, to: 1 })
  if (rest > 0) arcs.push({ shade: shadeOfLap(laps + 1), from: 0, to: rest })
  return arcs
}

/**
 * A Pomodoro as one full lap split in proportion: a focus arc per block in the accent, the
 * breaks left as the unfilled track (so there is nothing to return for them).
 */
export function pomodoroArcs(config: PomodoroConfig): Arc[] {
  const plan = pomodoroPlan(config)
  const total = plan.reduce((sum, phase) => sum + phase.durationMs, 0)
  if (total <= 0) return []
  const arcs: Arc[] = []
  let cursor = 0
  for (const phase of plan) {
    const to = cursor + phase.durationMs
    if (phase.kind === 'focus') arcs.push({ shade: 'accent', from: cursor / total, to: to / total })
    cursor = to
  }
  return arcs
}

/**
 * Where the Unlimited dial's ticks sit, in minutes round the lap: the top (0) and every further
 * multiple of the reminder interval below 60. 15 gives 0, 15, 30, 45; 30 gives 0, 30; 45 gives
 * 0, 45; 60, 90 and 120 give only the top; Off gives none (AC9.5).
 */
export function reminderTicks(reminderMinutes: number | null): number[] {
  if (reminderMinutes === null || reminderMinutes <= 0) return []
  const ticks: number[] = []
  for (let at = 0; at < LAP_MINUTES; at += reminderMinutes) ticks.push(at)
  return ticks
}

/** The circle stroke that draws an arc: dash length and offset, in the circle's own units. */
export function arcDash(
  arc: Arc,
  circumference: number,
): { dasharray: string; dashoffset: number } {
  const length = (arc.to - arc.from) * circumference
  return {
    dasharray: `${length.toFixed(3)} ${circumference.toFixed(3)}`,
    dashoffset: -arc.from * circumference,
  }
}

/** The two ends of a radial tick at `fraction` of a lap round a ring centred on (centre, centre). */
export function tickLine(
  fraction: number,
  centre: number,
  outerRadius: number,
  innerRadius: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const angle = fraction * 2 * Math.PI - Math.PI / 2
  const at = (radius: number) => ({
    x: centre + radius * Math.cos(angle),
    y: centre + radius * Math.sin(angle),
  })
  const outer = at(outerRadius)
  const inner = at(innerRadius)
  return { x1: outer.x, y1: outer.y, x2: inner.x, y2: inner.y }
}

/**
 * The next lower or higher multiple of `step` than `value`, kept within `min`..`max`:
 * 23 → 20 or 25, 1 → 5, 5 → 1 (step 5, min 1); 52 → 50 or 55 (min 5). An unreadable `value`
 * (NaN) starts from `fallback`.
 */
export function stepTo(
  value: number,
  direction: 1 | -1,
  step: number,
  limits: { min: number; max: number },
  fallback: number,
): number {
  const from = Number.isFinite(value) ? value : fallback
  const next =
    direction === 1 ? (Math.floor(from / step) + 1) * step : (Math.ceil(from / step) - 1) * step
  return Math.min(limits.max, Math.max(limits.min, next))
}
