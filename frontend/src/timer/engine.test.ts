import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_POMODORO,
  MINUTE_MS,
  type PomodoroConfig,
  type ReminderMinutes,
  type TimerConfig,
} from './config.ts'
import {
  InvalidConfigError,
  TOO_SHORT_MESSAGE,
  TimerError,
  advance,
  pauseSession,
  pomodoroPlan,
  resumeSession,
  skipBreak,
  snapshot,
  startSession,
  stopSession,
  type ActiveSession,
  type FinishOutcome,
  type SessionRecord,
} from './engine.ts'

// Fake clock: Vitest's fake timers own Date.now(); nothing here waits for real time.
const T0 = Date.UTC(2026, 9, 23, 9, 0, 0)
const SECOND = 1000
const HOUR = 60 * MINUTE_MS

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

const now = () => Date.now()
const wait = (ms: number) => vi.advanceTimersByTime(ms)
const iso = (ms: number) => new Date(ms).toISOString()

function start(config: TimerConfig): ActiveSession {
  return startSession({ id: 'session-1', config, tag: 'work', goal: 'Write the report' }, now())
}

function saved(outcome: FinishOutcome): SessionRecord {
  if (outcome.kind !== 'saved') throw new Error(`expected a saved session, got ${outcome.kind}`)
  return outcome.record
}

const pomodoro = (overrides: Partial<PomodoroConfig> = {}): PomodoroConfig => ({
  ...DEFAULT_POMODORO,
  ...overrides,
})

describe('countdown (F2)', () => {
  it('ac2_1 cannot start outside 1–240 whole minutes', () => {
    for (const minutes of [0, 241, 2.5]) {
      expect(() => start({ mode: 'countdown', minutes })).toThrow(InvalidConfigError)
    }
    expect(start({ mode: 'countdown', minutes: 1 }).config).toEqual({
      mode: 'countdown',
      minutes: 1,
    })
    expect(start({ mode: 'countdown', minutes: 240 }).startedAt).toBe(T0)
  })

  it('ac2_2 shows remaining time from timestamps and counts down to 00:00', () => {
    const session = start({ mode: 'countdown', minutes: 25 })
    expect(snapshot(session, now()).remainingMs).toBe(25 * MINUTE_MS)
    // No ticks in between: the value comes from the clock, as after a backgrounded tab.
    wait(10 * MINUTE_MS + 30 * SECOND)
    expect(snapshot(session, now()).remainingMs).toBe(14 * MINUTE_MS + 30 * SECOND)
    wait(2 * HOUR)
    const end = snapshot(session, now())
    expect(end.remainingMs).toBe(0)
    expect(end.focusMs).toBe(25 * MINUTE_MS)
    expect(end.reachedEnd).toBe(true)
  })

  it('ac2_3 at 00:00 reports the end and saves Completed at the scheduled end', () => {
    let session = start({ mode: 'countdown', minutes: 25 })
    wait(25 * MINUTE_MS - 1)
    const before = advance(session, now())
    expect(before.events).toEqual([])
    expect(before.endedAt).toBeNull()
    session = before.session
    wait(1)
    const atEnd = advance(session, now())
    expect(atEnd.events).toEqual([
      {
        type: 'session-end',
        at: T0 + 25 * MINUTE_MS,
        atActiveMs: 25 * MINUTE_MS,
        reason: 'completed',
      },
    ])
    expect(atEnd.endedAt).toBe(T0 + 25 * MINUTE_MS)
    wait(5 * MINUTE_MS) // stopping later still records the scheduled end
    expect(saved(stopSession(atEnd.session, now()))).toEqual({
      id: 'session-1',
      mode: 'countdown',
      tag: 'work',
      goal: 'Write the report',
      startedAt: iso(T0),
      endedAt: iso(T0 + 25 * MINUTE_MS),
      focusSeconds: 25 * 60,
      pausedSeconds: 0,
      status: 'completed',
      modeConfig: { mode: 'countdown', minutes: 25 },
      blocksCompleted: 0,
    })
  })

  it('ac2_4 paused time does not count toward focus time', () => {
    let session = start({ mode: 'countdown', minutes: 10 })
    wait(4 * MINUTE_MS)
    session = pauseSession(session, now())
    expect(snapshot(session, now()).paused).toBe(true)
    wait(30 * MINUTE_MS)
    const paused = snapshot(session, now())
    expect(paused.remainingMs).toBe(6 * MINUTE_MS)
    expect(paused.pausedMs).toBe(30 * MINUTE_MS)
    expect(advance(session, now()).endedAt).toBeNull()
    session = resumeSession(session, now())
    expect(snapshot(session, now()).paused).toBe(false)
    wait(6 * MINUTE_MS)
    const end = advance(session, now())
    expect(end.endedAt).toBe(T0 + 40 * MINUTE_MS)
    const record = saved(stopSession(end.session, now()))
    expect(record.focusSeconds).toBe(10 * 60)
    expect(record.pausedSeconds).toBe(30 * 60)
    expect(record.status).toBe('completed')
  })

  it('ac2_4 cannot pause twice or resume while running', () => {
    const session = start({ mode: 'countdown', minutes: 10 })
    expect(() => resumeSession(session, now())).toThrow(TimerError)
    const paused = pauseSession(session, now())
    expect(() => pauseSession(paused, now())).toThrow(TimerError)
  })

  it('ac2_5 stopping early saves Ended early with the actual focus time', () => {
    let session = start({ mode: 'countdown', minutes: 30 })
    wait(12 * MINUTE_MS + 40 * SECOND)
    session = pauseSession(session, now())
    wait(3 * MINUTE_MS)
    const record = saved(stopSession(session, now()))
    expect(record.status).toBe('ended_early')
    expect(record.focusSeconds).toBe(12 * 60 + 40)
    expect(record.pausedSeconds).toBe(3 * 60)
    expect(record.endedAt).toBe(iso(now()))
  })
})

describe('Pomodoro (F3)', () => {
  it('ac3_3 has no break after the final block', () => {
    expect(pomodoroPlan(pomodoro()).map((p) => p.kind)).toEqual([
      'focus',
      'break',
      'focus',
      'break',
      'focus',
      'break',
      'focus',
    ])
    expect(pomodoroPlan(pomodoro({ blocks: 1 })).map((p) => p.kind)).toEqual(['focus'])
  })

  it('ac3_2 an enabled long break follows every 4th block, never the last one', () => {
    const plan = pomodoroPlan(pomodoro({ blocks: 8, longBreakEnabled: true, longBreakMinutes: 20 }))
    expect(
      plan.filter((p) => p.kind !== 'focus').map((p) => [p.block, p.kind, p.durationMs]),
    ).toEqual([
      [1, 'break', 5 * MINUTE_MS],
      [2, 'break', 5 * MINUTE_MS],
      [3, 'break', 5 * MINUTE_MS],
      [4, 'long-break', 20 * MINUTE_MS],
      [5, 'break', 5 * MINUTE_MS],
      [6, 'break', 5 * MINUTE_MS],
      [7, 'break', 5 * MINUTE_MS],
    ])
    expect(plan.at(-1)?.kind).toBe('focus')
    // With 4 blocks the 4th is the last, so there is no long break at all.
    const four = pomodoroPlan(pomodoro({ longBreakEnabled: true }))
    expect(four.some((p) => p.kind === 'long-break')).toBe(false)
    // Off: every break is a short break.
    const off = pomodoroPlan(pomodoro({ blocks: 8 }))
    expect(off.some((p) => p.kind === 'long-break')).toBe(false)
  })

  it('ac3_2 cannot start outside the allowed ranges', () => {
    expect(() => start(pomodoro({ focusMinutes: 4 }))).toThrow(InvalidConfigError)
    expect(() => start(pomodoro({ breakMinutes: 31 }))).toThrow(InvalidConfigError)
    expect(() => start(pomodoro({ blocks: 9 }))).toThrow(InvalidConfigError)
    expect(() => start(pomodoro({ longBreakMinutes: 61 }))).toThrow(InvalidConfigError)
  })

  it('ac3_4 shows the current phase, its remaining time and the block progress', () => {
    const session = start(pomodoro())
    expect(snapshot(session, now()).pomodoro).toEqual({
      phase: 'focus',
      block: 1,
      totalBlocks: 4,
      blocksCompleted: 0,
      phaseRemainingMs: 25 * MINUTE_MS,
    })
    wait(27 * MINUTE_MS)
    expect(snapshot(session, now()).pomodoro).toEqual({
      phase: 'break',
      block: 1,
      totalBlocks: 4,
      blocksCompleted: 1,
      phaseRemainingMs: 3 * MINUTE_MS,
    })
    wait(13 * MINUTE_MS) // 40 min: 10 min into block 2
    const s = snapshot(session, now())
    expect(s.pomodoro).toMatchObject({ phase: 'focus', block: 2, blocksCompleted: 1 })
    expect(s.remainingMs).toBe(15 * MINUTE_MS)
    expect(s.focusMs).toBe(35 * MINUTE_MS)
  })

  it('ac3_3 advances automatically and reports every phase change, then the end', () => {
    let session = start(pomodoro({ blocks: 2, focusMinutes: 10, breakMinutes: 2 }))
    wait(10 * MINUTE_MS)
    const first = advance(session, now())
    expect(first.events).toEqual([
      {
        type: 'phase-change',
        at: T0 + 10 * MINUTE_MS,
        atActiveMs: 10 * MINUTE_MS,
        from: 'focus',
        to: 'break',
        block: 1,
        skipped: false,
      },
    ])
    session = first.session
    // A second call at the same moment reports nothing new.
    expect(advance(session, now()).events).toEqual([])
    wait(2 * MINUTE_MS)
    const second = advance(session, now())
    expect(second.events).toMatchObject([
      { type: 'phase-change', from: 'break', to: 'focus', block: 2 },
    ])
    session = second.session
    wait(10 * MINUTE_MS)
    const end = advance(session, now())
    expect(end.events).toMatchObject([{ type: 'session-end', reason: 'completed' }])
    expect(end.endedAt).toBe(T0 + 22 * MINUTE_MS)
  })

  it('ac3_3 reports every phase change it missed, in order, after a long gap', () => {
    const session = start(pomodoro({ blocks: 3, focusMinutes: 5, breakMinutes: 1 }))
    wait(HOUR)
    const result = advance(session, now())
    expect(result.events.map((e) => e.type)).toEqual([
      'phase-change',
      'phase-change',
      'phase-change',
      'phase-change',
      'session-end',
    ])
    expect(result.events.map((e) => e.at)).toEqual(
      [5, 6, 11, 12, 17].map((m) => T0 + m * MINUTE_MS),
    )
    expect(result.endedAt).toBe(T0 + 17 * MINUTE_MS)
  })

  it('ac3_5 pause and resume work in focus and in breaks; paused time is excluded', () => {
    let session = start(pomodoro({ blocks: 2, focusMinutes: 10, breakMinutes: 5 }))
    wait(4 * MINUTE_MS)
    session = pauseSession(session, now())
    wait(20 * MINUTE_MS)
    session = resumeSession(session, now())
    expect(snapshot(session, now()).remainingMs).toBe(6 * MINUTE_MS)
    wait(8 * MINUTE_MS) // 2 min into the break
    session = pauseSession(advance(session, now()).session, now())
    wait(7 * MINUTE_MS)
    expect(snapshot(session, now()).pomodoro).toMatchObject({
      phase: 'break',
      phaseRemainingMs: 3 * MINUTE_MS,
    })
    session = resumeSession(session, now())
    wait(13 * MINUTE_MS)
    const end = advance(session, now())
    expect(end.endedAt).toBe(T0 + (4 + 20 + 8 + 7 + 13) * MINUTE_MS)
    const record = saved(stopSession(end.session, now()))
    expect(record.focusSeconds).toBe(20 * 60)
    expect(record.pausedSeconds).toBe(27 * 60)
  })

  it('ac3_5 skipping a break starts the next focus block now', () => {
    let session = start(pomodoro({ blocks: 2, focusMinutes: 10, breakMinutes: 5 }))
    wait(11 * MINUTE_MS)
    session = advance(session, now()).session
    const skip = skipBreak(session, now())
    expect(skip.event).toEqual({
      type: 'phase-change',
      at: T0 + 11 * MINUTE_MS,
      atActiveMs: 11 * MINUTE_MS,
      from: 'break',
      to: 'focus',
      block: 2,
      skipped: true,
    })
    session = skip.session
    expect(snapshot(session, now()).pomodoro).toMatchObject({
      phase: 'focus',
      block: 2,
      phaseRemainingMs: 10 * MINUTE_MS,
    })
    // The skip itself is not reported again by the next advance.
    expect(advance(session, now()).events).toEqual([])
    wait(10 * MINUTE_MS)
    const end = advance(session, now())
    expect(end.events).toMatchObject([{ type: 'session-end' }])
    expect(end.endedAt).toBe(T0 + 21 * MINUTE_MS)
    expect(saved(stopSession(end.session, now())).focusSeconds).toBe(20 * 60)
  })

  it('ac3_5 there is no break to skip during focus or in other modes', () => {
    const session = start(pomodoro())
    wait(MINUTE_MS)
    expect(() => skipBreak(session, now())).toThrow(TimerError)
    expect(() => skipBreak(start({ mode: 'countdown', minutes: 5 }), now())).toThrow(TimerError)
  })

  it('ac3_6 a completed Pomodoro is one entry with only focus time and its completed blocks', () => {
    const config = pomodoro({ blocks: 5, longBreakEnabled: true })
    const session = start(config)
    wait(10 * HOUR)
    const end = advance(session, now())
    // 5 × 25 min focus + 3 × 5 min breaks + 1 × 15 min long break
    expect(end.endedAt).toBe(T0 + (125 + 15 + 15) * MINUTE_MS)
    expect(saved(stopSession(end.session, now()))).toEqual({
      id: 'session-1',
      mode: 'pomodoro',
      tag: 'work',
      goal: 'Write the report',
      startedAt: iso(T0),
      endedAt: iso(T0 + 155 * MINUTE_MS),
      focusSeconds: 125 * 60,
      pausedSeconds: 0,
      status: 'completed',
      modeConfig: config,
      blocksCompleted: 5,
    })
  })

  it('ac3_7 stopping before the last block saves Ended early with the focus so far', () => {
    const session = start(pomodoro())
    wait((25 + 5 + 25 + 5 + 7) * MINUTE_MS) // 7 min into block 3
    const record = saved(stopSession(session, now()))
    expect(record.status).toBe('ended_early')
    expect(record.focusSeconds).toBe(57 * 60)
    expect(record.blocksCompleted).toBe(2)
  })

  it('ac3_7 stopping during a break excludes the break from focus time', () => {
    const session = start(pomodoro())
    wait(28 * MINUTE_MS)
    const record = saved(stopSession(session, now()))
    expect(record).toMatchObject({
      status: 'ended_early',
      focusSeconds: 25 * 60,
      blocksCompleted: 1,
    })
  })

  it('ac3_7 stopping during the last block is still Ended early', () => {
    const session = start(pomodoro({ blocks: 1, focusMinutes: 5 }))
    wait(5 * MINUTE_MS - SECOND)
    expect(saved(stopSession(session, now()))).toMatchObject({
      status: 'ended_early',
      blocksCompleted: 0,
    })
  })
})

describe('unlimited (F4)', () => {
  const unlimited = (reminderMinutes: ReminderMinutes | null = null): TimerConfig => ({
    mode: 'unlimited',
    reminderMinutes,
  })

  it('ac4_1 counts up from 00:00', () => {
    const session = start(unlimited())
    expect(snapshot(session, now())).toMatchObject({ focusMs: 0, remainingMs: null })
    wait(3 * HOUR + 7 * SECOND)
    expect(snapshot(session, now()).focusMs).toBe(3 * HOUR + 7 * SECOND)
  })

  it('ac4_2 reminders are off by default and chime at each interval when on', () => {
    expect(advance(start(unlimited()), now() + 5 * HOUR).events).toEqual([])
    let session = start(unlimited(15))
    expect(snapshot(session, now()).nextReminderInMs).toBe(15 * MINUTE_MS)
    wait(15 * MINUTE_MS)
    const first = advance(session, now())
    expect(first.events).toEqual([
      { type: 'reminder', at: T0 + 15 * MINUTE_MS, atActiveMs: 15 * MINUTE_MS, count: 1 },
    ])
    session = first.session
    wait(31 * MINUTE_MS)
    expect(
      advance(session, now()).events.map((e) => (e.type === 'reminder' ? e.count : 0)),
    ).toEqual([2, 3])
  })

  it('ac4_2 rejects reminder intervals outside the options', () => {
    expect(() =>
      start({ mode: 'unlimited', reminderMinutes: 20 } as unknown as TimerConfig),
    ).toThrow(InvalidConfigError)
  })

  it('ac4_3 reminders follow focus time, not wall-clock time', () => {
    let session = start(unlimited(30))
    wait(20 * MINUTE_MS)
    session = pauseSession(advance(session, now()).session, now())
    wait(HOUR)
    expect(advance(session, now()).events).toEqual([])
    session = resumeSession(session, now())
    expect(snapshot(session, now()).nextReminderInMs).toBe(10 * MINUTE_MS)
    wait(10 * MINUTE_MS)
    expect(advance(session, now()).events).toEqual([
      { type: 'reminder', at: T0 + 90 * MINUTE_MS, atActiveMs: 30 * MINUTE_MS, count: 1 },
    ])
  })

  it('ac4_4 stopping saves Completed', () => {
    const session = start(unlimited(60))
    wait(42 * MINUTE_MS)
    expect(saved(stopSession(session, now()))).toMatchObject({
      mode: 'unlimited',
      status: 'completed',
      focusSeconds: 42 * 60,
      blocksCompleted: 0,
      modeConfig: { mode: 'unlimited', reminderMinutes: 60 },
    })
  })

  it('ac4_5 stops itself at 12 hours of focus time and saves the session', () => {
    let session = start(unlimited(120))
    wait(2 * HOUR)
    session = pauseSession(advance(session, now()).session, now())
    wait(HOUR)
    session = resumeSession(session, now())
    wait(9 * HOUR + 59 * MINUTE_MS)
    session = advance(session, now()).session
    expect(advance(session, now()).endedAt).toBeNull()
    wait(MINUTE_MS)
    const end = advance(session, now())
    // The 12-hour mark replaces the 6th reminder with the end.
    expect(end.events).toEqual([
      { type: 'session-end', at: T0 + 13 * HOUR, atActiveMs: 12 * HOUR, reason: 'time-limit' },
    ])
    expect(end.endedAt).toBe(T0 + 13 * HOUR)
    wait(HOUR)
    expect(snapshot(end.session, now()).focusMs).toBe(12 * HOUR)
    expect(saved(stopSession(end.session, now()))).toMatchObject({
      status: 'completed',
      focusSeconds: 12 * 3600,
      pausedSeconds: 3600,
      endedAt: iso(T0 + 13 * HOUR),
    })
  })
})

describe('session rules (F6)', () => {
  it('ac6_2 under 1 minute of focus is discarded with a reason', () => {
    let session = start({ mode: 'unlimited', reminderMinutes: null })
    wait(59 * SECOND)
    session = pauseSession(session, now())
    wait(HOUR) // paused time doesn't count toward the minute
    expect(stopSession(session, now())).toEqual({
      kind: 'discarded',
      reason: 'too_short',
      focusSeconds: 59,
      message: TOO_SHORT_MESSAGE,
    })
  })

  it('ac6_2 exactly 1 minute of focus is saved', () => {
    const session = start({ mode: 'countdown', minutes: 5 })
    wait(MINUTE_MS)
    expect(stopSession(session, now()).kind).toBe('saved')
  })

  it('ac6_2 a Pomodoro stopped in its first minute is discarded', () => {
    const session = start(pomodoro())
    wait(30 * SECOND)
    expect(stopSession(session, now()).kind).toBe('discarded')
  })
})
