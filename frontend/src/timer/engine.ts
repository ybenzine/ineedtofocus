// Pure, timestamp-based timer engine for all three modes (F2, F3, F4, F6).
//
// A session is stored as its configuration plus the wall-clock timestamps of what happened
// (start, each pause and resume, each skipped break). Everything shown — elapsed focus time,
// paused time, the current Pomodoro phase, remaining time — is derived from those timestamps
// and the current time. Nothing counts ticks, so the time is right after the tab was in the
// background, the device slept, or the page was reloaded.
//
// "Active time" below is wall-clock time since the start minus paused time. Countdown and
// unlimited focus time is active time; a Pomodoro lays its phases out along active time.

import {
  LONG_BREAK_EVERY,
  MINUTE_MS,
  MIN_SAVED_FOCUS_MS,
  UNLIMITED_MAX_MS,
  validateConfig,
  type Mode,
  type PomodoroConfig,
  type Tag,
  type TimerConfig,
} from './config.ts'

export const SESSION_SCHEMA_VERSION = 1

export interface Pause {
  /** Wall-clock ms when the timer was paused. */
  pausedAt: number
  /** Wall-clock ms when it was resumed; `null` while still paused. */
  resumedAt: number | null
}

export interface BreakSkip {
  /** Index of the skipped break in the Pomodoro plan. */
  phaseIndex: number
  /** Active time at which the break was skipped. */
  atActiveMs: number
}

/** The active session, exactly as persisted on the device (AC6.4). */
export interface ActiveSession {
  version: typeof SESSION_SCHEMA_VERSION
  /** Client-generated UUID; it becomes the saved session's id (idempotent sync, AC13.4). */
  id: string
  config: TimerConfig
  tag: Tag
  goal: string | null
  /** Wall-clock ms (UTC epoch). */
  startedAt: number
  pauses: Pause[]
  skips: BreakSkip[]
  /** Active time up to which events (bells, chimes) have already been reported. */
  observedActiveMs: number
}

export type PhaseKind = 'focus' | 'break' | 'long-break'

export interface Phase {
  kind: PhaseKind
  /** 1-based focus block number: the block itself, or for a break the block it follows. */
  block: number
  /** Active-time bounds, `[startMs, endMs)`. */
  startMs: number
  endMs: number
}

export type SessionStatus = 'completed' | 'ended_early'

/** What a finished session saves (AC6.3). Times are ISO 8601 UTC strings. */
export interface SessionRecord {
  id: string
  mode: Mode
  tag: Tag
  goal: string | null
  startedAt: string
  endedAt: string
  focusSeconds: number
  pausedSeconds: number
  status: SessionStatus
  modeConfig: TimerConfig
  /** Pomodoro focus blocks completed (AC3.6); 0 for the other modes. */
  blocksCompleted: number
}

export const TOO_SHORT_MESSAGE = 'Sessions under 1 minute of focus time aren’t saved.'

export type FinishOutcome =
  | { kind: 'saved'; record: SessionRecord }
  | { kind: 'discarded'; reason: 'too_short'; focusSeconds: number; message: string }

export type TimerEvent =
  | {
      /** A Pomodoro phase changed: the end bell plays (AC3.3). */
      type: 'phase-change'
      at: number
      atActiveMs: number
      from: PhaseKind
      to: PhaseKind
      block: number
      skipped: boolean
    }
  | {
      /** An unlimited-timer reminder interval passed: the chime plays (AC4.2). */
      type: 'reminder'
      at: number
      atActiveMs: number
      /** 1 for the first reminder, 2 for the second, … */
      count: number
    }
  | {
      /** The session reached its end on its own: the end bell plays (AC2.3, AC3.3, AC4.5). */
      type: 'session-end'
      at: number
      atActiveMs: number
      reason: 'completed' | 'time-limit'
    }

export interface PomodoroProgress {
  phase: PhaseKind
  /** "Block 2 of 4" (AC3.4). */
  block: number
  totalBlocks: number
  blocksCompleted: number
  phaseRemainingMs: number
}

export interface TimerSnapshot {
  id: string
  mode: Mode
  config: TimerConfig
  tag: Tag
  goal: string | null
  startedAt: number
  paused: boolean
  /** True once the timer has reached its own end (countdown 00:00, last block, 12 h). */
  reachedEnd: boolean
  activeMs: number
  focusMs: number
  pausedMs: number
  /** Countdown: time left; Pomodoro: time left in the current phase; unlimited: `null`. */
  remainingMs: number | null
  pomodoro: PomodoroProgress | null
  /** Unlimited with reminders: focus time until the next chime; otherwise `null`. */
  nextReminderInMs: number | null
  /** Active time until the next event (phase change, reminder or end); useful for scheduling. */
  msUntilNextEvent: number
}

export class TimerError extends Error {
  override name = 'TimerError'
}

export class InvalidConfigError extends TimerError {
  override name = 'InvalidConfigError'
}

// --- Timeline ------------------------------------------------------------------------------

export function isPaused(session: ActiveSession): boolean {
  const last = session.pauses.at(-1)
  return last !== undefined && last.resumedAt === null
}

/** Paused wall-clock time between the start and `now`. */
export function pausedMsAt(session: ActiveSession, now: number): number {
  let total = 0
  for (const pause of session.pauses) {
    if (pause.pausedAt >= now) break
    total += Math.min(pause.resumedAt ?? now, now) - pause.pausedAt
  }
  return total
}

/** Active (unpaused) time between the start and `now`. */
export function activeMsAt(session: ActiveSession, now: number): number {
  return Math.max(0, now - session.startedAt - pausedMsAt(session, now))
}

/**
 * The wall-clock time at which the session's active time reaches `activeMs`, or `null` if it
 * hasn't yet because the session is paused before that point.
 */
export function wallTimeAtActive(session: ActiveSession, activeMs: number): number | null {
  let cursor = session.startedAt
  let remaining = activeMs
  for (const pause of session.pauses) {
    const runSpan = pause.pausedAt - cursor
    if (remaining <= runSpan) return cursor + remaining
    remaining -= runSpan
    if (pause.resumedAt === null) return null
    cursor = pause.resumedAt
  }
  return cursor + remaining
}

function wallTimeAtReachedActive(session: ActiveSession, activeMs: number): number {
  const at = wallTimeAtActive(session, activeMs)
  if (at === null) throw new TimerError('Active time not reached yet')
  return at
}

// --- Pomodoro plan -------------------------------------------------------------------------

/** The phases of a Pomodoro as configured: no break after the final block (AC3.3). */
export function pomodoroPlan(
  config: PomodoroConfig,
): { kind: PhaseKind; block: number; durationMs: number }[] {
  const plan: { kind: PhaseKind; block: number; durationMs: number }[] = []
  for (let block = 1; block <= config.blocks; block++) {
    plan.push({ kind: 'focus', block, durationMs: config.focusMinutes * MINUTE_MS })
    if (block === config.blocks) break
    const long = config.longBreakEnabled && block % LONG_BREAK_EVERY === 0
    plan.push({
      kind: long ? 'long-break' : 'break',
      block,
      durationMs: (long ? config.longBreakMinutes : config.breakMinutes) * MINUTE_MS,
    })
  }
  return plan
}

/** The Pomodoro's phases along active time, with skipped breaks cut short (AC3.5). */
export function pomodoroPhases(session: ActiveSession): Phase[] {
  if (session.config.mode !== 'pomodoro') return []
  const phases: Phase[] = []
  let cursor = 0
  pomodoroPlan(session.config).forEach((planned, index) => {
    const skip = session.skips.find((s) => s.phaseIndex === index)
    const endMs = skip ? Math.max(cursor, skip.atActiveMs) : cursor + planned.durationMs
    phases.push({ kind: planned.kind, block: planned.block, startMs: cursor, endMs })
    cursor = endMs
  })
  return phases
}

function phaseIndexAt(phases: Phase[], activeMs: number): number {
  const index = phases.findIndex((p) => activeMs < p.endMs)
  return index === -1 ? phases.length - 1 : index
}

// --- Derived values ------------------------------------------------------------------------

/** Active time at which the session ends on its own. */
export function totalActiveMs(session: ActiveSession): number {
  switch (session.config.mode) {
    case 'countdown':
      return session.config.minutes * MINUTE_MS
    case 'pomodoro':
      return pomodoroPhases(session).at(-1)?.endMs ?? 0
    case 'unlimited':
      return UNLIMITED_MAX_MS
  }
}

function focusMsAtActive(session: ActiveSession, activeMs: number): number {
  const clamped = Math.min(activeMs, totalActiveMs(session))
  if (session.config.mode !== 'pomodoro') return clamped
  return pomodoroPhases(session)
    .filter((p) => p.kind === 'focus')
    .reduce((sum, p) => sum + Math.max(0, Math.min(clamped, p.endMs) - p.startMs), 0)
}

function blocksCompletedAtActive(session: ActiveSession, activeMs: number): number {
  if (session.config.mode !== 'pomodoro') return 0
  return pomodoroPhases(session).filter((p) => p.kind === 'focus' && p.endMs <= activeMs).length
}

/** Active-time points at which events fall, in order. */
function eventPoints(session: ActiveSession): { atActiveMs: number; make: () => TimerEvent }[] {
  const points: { atActiveMs: number; make: () => TimerEvent }[] = []
  const end = totalActiveMs(session)
  const at = (activeMs: number) => wallTimeAtReachedActive(session, activeMs)
  const config = session.config
  if (config.mode === 'pomodoro') {
    const phases = pomodoroPhases(session)
    phases.slice(0, -1).forEach((phase, i) => {
      const next = phases[i + 1]
      const skipped = session.skips.some((s) => s.phaseIndex === i)
      points.push({
        atActiveMs: phase.endMs,
        make: () => ({
          type: 'phase-change',
          at: at(phase.endMs),
          atActiveMs: phase.endMs,
          from: phase.kind,
          to: next.kind,
          block: next.block,
          skipped,
        }),
      })
    })
  }
  if (config.mode === 'unlimited' && config.reminderMinutes !== null) {
    const interval = config.reminderMinutes * MINUTE_MS
    // A reminder that falls exactly on the 12-hour limit is replaced by the end.
    for (let count = 1; count * interval < end; count++) {
      const point = count * interval
      points.push({
        atActiveMs: point,
        make: () => ({ type: 'reminder', at: at(point), atActiveMs: point, count }),
      })
    }
  }
  points.push({
    atActiveMs: end,
    make: () => ({
      type: 'session-end',
      at: at(end),
      atActiveMs: end,
      reason: config.mode === 'unlimited' ? 'time-limit' : 'completed',
    }),
  })
  return points
}

/** Events with active time in `(fromActiveMs, toActiveMs]`, oldest first. */
export function eventsBetween(
  session: ActiveSession,
  fromActiveMs: number,
  toActiveMs: number,
): TimerEvent[] {
  return eventPoints(session)
    .filter((p) => p.atActiveMs > fromActiveMs && p.atActiveMs <= toActiveMs)
    .map((p) => p.make())
}

export function snapshot(session: ActiveSession, now: number): TimerSnapshot {
  const end = totalActiveMs(session)
  const rawActive = activeMsAt(session, now)
  const activeMs = Math.min(rawActive, end)
  const config = session.config
  let remainingMs: number | null = null
  let pomodoro: PomodoroProgress | null = null
  let nextReminderInMs: number | null = null

  if (config.mode === 'countdown') {
    remainingMs = end - activeMs
  } else if (config.mode === 'pomodoro') {
    const phases = pomodoroPhases(session)
    const phase = phases[phaseIndexAt(phases, activeMs)]
    remainingMs = phase.endMs - activeMs
    pomodoro = {
      phase: phase.kind,
      block: phase.block,
      totalBlocks: config.blocks,
      blocksCompleted: blocksCompletedAtActive(session, activeMs),
      phaseRemainingMs: remainingMs,
    }
  } else if (config.reminderMinutes !== null) {
    const interval = config.reminderMinutes * MINUTE_MS
    const next = (Math.floor(activeMs / interval) + 1) * interval
    nextReminderInMs = next < end ? next - activeMs : null
  }

  const nextEvent = eventPoints(session).find((p) => p.atActiveMs > activeMs)
  return {
    id: session.id,
    mode: config.mode,
    config,
    tag: session.tag,
    goal: session.goal,
    startedAt: session.startedAt,
    paused: isPaused(session),
    reachedEnd: rawActive >= end,
    activeMs,
    focusMs: focusMsAtActive(session, activeMs),
    pausedMs: pausedMsAt(session, now),
    remainingMs,
    pomodoro,
    nextReminderInMs,
    msUntilNextEvent: nextEvent ? nextEvent.atActiveMs - activeMs : 0,
  }
}

// --- Transitions ---------------------------------------------------------------------------

export interface StartInput {
  id: string
  config: TimerConfig
  tag: Tag
  goal: string | null
}

/** Starts a session; configurations outside the allowed ranges cannot start (AC2.1, AC3.2, AC4.2). */
export function startSession(input: StartInput, now: number): ActiveSession {
  const errors = validateConfig(input.config)
  if (errors.length > 0) {
    throw new InvalidConfigError(errors.map((e) => `${e.field}: ${e.message}`).join(' '))
  }
  return {
    version: SESSION_SCHEMA_VERSION,
    id: input.id,
    config: { ...input.config },
    tag: input.tag,
    goal: input.goal,
    startedAt: now,
    pauses: [],
    skips: [],
    observedActiveMs: 0,
  }
}

export interface AdvanceResult {
  session: ActiveSession
  /** Events since the last advance, oldest first. */
  events: TimerEvent[]
  /** Set when the session reached its own end: the wall-clock time it ended at. */
  endedAt: number | null
}

/**
 * Brings the session up to `now`: reports the events that fell since the last call, and
 * whether the session reached its end (and exactly when, which may be well before `now`).
 */
export function advance(session: ActiveSession, now: number): AdvanceResult {
  const end = totalActiveMs(session)
  const activeMs = Math.min(activeMsAt(session, now), end)
  const events = eventsBetween(session, session.observedActiveMs, activeMs)
  const next =
    activeMs > session.observedActiveMs ? { ...session, observedActiveMs: activeMs } : session
  const endedAt = activeMs >= end ? wallTimeAtReachedActive(session, end) : null
  return { session: next, events, endedAt }
}

/** Pauses the timer (AC2.4, AC3.5, AC4.3). Paused time never counts as focus time. */
export function pauseSession(session: ActiveSession, now: number): ActiveSession {
  if (isPaused(session)) throw new TimerError('The timer is already paused')
  return { ...session, pauses: [...session.pauses, { pausedAt: now, resumedAt: null }] }
}

export function resumeSession(session: ActiveSession, now: number): ActiveSession {
  const last = session.pauses.at(-1)
  if (last === undefined || last.resumedAt !== null) {
    throw new TimerError('The timer is not paused')
  }
  return {
    ...session,
    pauses: [...session.pauses.slice(0, -1), { pausedAt: last.pausedAt, resumedAt: now }],
  }
}

/**
 * Skips the current Pomodoro break and starts the next focus block now (AC3.5). Returns the
 * session and the phase-change event. Call `advance` first so the current phase is up to date.
 */
export function skipBreak(
  session: ActiveSession,
  now: number,
): { session: ActiveSession; event: TimerEvent } {
  if (session.config.mode !== 'pomodoro') throw new TimerError('Only a Pomodoro has breaks')
  const activeMs = activeMsAt(session, now)
  const phases = pomodoroPhases(session)
  const index = phaseIndexAt(phases, activeMs)
  const phase = phases[index]
  if (phase.kind === 'focus' || activeMs >= phase.endMs) {
    throw new TimerError('There is no break to skip right now')
  }
  const next = phases[index + 1]
  const skipped: ActiveSession = {
    ...session,
    skips: [...session.skips, { phaseIndex: index, atActiveMs: activeMs }],
    observedActiveMs: Math.max(session.observedActiveMs, activeMs),
  }
  return {
    session: skipped,
    event: {
      type: 'phase-change',
      at: now,
      atActiveMs: activeMs,
      from: phase.kind,
      to: next.kind,
      block: next.block,
      skipped: true,
    },
  }
}

/** Builds the saved record, or discards the session if it has under 1 minute of focus (AC6.2). */
export function finishSession(
  session: ActiveSession,
  endedAt: number,
  status: SessionStatus,
): FinishOutcome {
  const activeMs = Math.min(activeMsAt(session, endedAt), totalActiveMs(session))
  const focusMs = focusMsAtActive(session, activeMs)
  const focusSeconds = Math.floor(focusMs / 1000)
  if (focusMs < MIN_SAVED_FOCUS_MS) {
    return { kind: 'discarded', reason: 'too_short', focusSeconds, message: TOO_SHORT_MESSAGE }
  }
  return {
    kind: 'saved',
    record: {
      id: session.id,
      mode: session.config.mode,
      tag: session.tag,
      goal: session.goal,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      focusSeconds,
      pausedSeconds: Math.floor(pausedMsAt(session, endedAt) / 1000),
      status,
      modeConfig: { ...session.config },
      blocksCompleted: blocksCompletedAtActive(session, activeMs),
    },
  }
}

/**
 * Ends the session at `now`. A session that already reached its own end is completed at that
 * scheduled time (AC2.3, AC3.3, AC4.5, AC6.5). Otherwise stopping a countdown or Pomodoro is
 * Ended early (AC2.5, AC3.7) and stopping an unlimited timer is Completed (AC4.4).
 */
export function stopSession(session: ActiveSession, now: number): FinishOutcome {
  const { endedAt } = advance(session, now)
  if (endedAt !== null) return finishSession(session, endedAt, 'completed')
  const status: SessionStatus = session.config.mode === 'unlimited' ? 'completed' : 'ended_early'
  return finishSession(session, now, status)
}
