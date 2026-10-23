import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POMODORO,
  isValidConfig,
  validateConfig,
  type PomodoroConfig,
  type TimerConfig,
} from './config.ts'

const pomodoro = (overrides: Partial<PomodoroConfig>): PomodoroConfig => ({
  ...DEFAULT_POMODORO,
  ...overrides,
})

describe('countdown config (AC2.1)', () => {
  it.each([1, 25, 240])('accepts %i whole minutes', (minutes) => {
    expect(isValidConfig({ mode: 'countdown', minutes })).toBe(true)
  })

  it.each([0, -5, 241, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (minutes) => {
    expect(validateConfig({ mode: 'countdown', minutes })).toEqual([
      { field: 'minutes', message: expect.stringContaining('1 to 240') },
    ])
  })
})

describe('Pomodoro config (AC3.1, AC3.2)', () => {
  it('ac3_1 defaults to 25 min focus, 5 min break, 4 blocks, long break off (15 min ready)', () => {
    expect(DEFAULT_POMODORO).toEqual({
      mode: 'pomodoro',
      focusMinutes: 25,
      breakMinutes: 5,
      blocks: 4,
      longBreakEnabled: false,
      longBreakMinutes: 15,
    })
    expect(isValidConfig(DEFAULT_POMODORO)).toBe(true)
  })

  it.each([
    ['focusMinutes', 5, 90],
    ['breakMinutes', 1, 30],
    ['blocks', 1, 8],
    ['longBreakMinutes', 5, 60],
  ] as const)('ac3_2 %s accepts %i to %i and nothing outside', (field, min, max) => {
    expect(isValidConfig(pomodoro({ [field]: min }))).toBe(true)
    expect(isValidConfig(pomodoro({ [field]: max }))).toBe(true)
    for (const bad of [min - 1, max + 1, min + 0.5]) {
      const errors = validateConfig(pomodoro({ [field]: bad }))
      expect(errors.map((e) => e.field)).toEqual([field])
    }
  })

  it('ac3_2 accepts the long break on or off', () => {
    expect(isValidConfig(pomodoro({ longBreakEnabled: true }))).toBe(true)
    expect(isValidConfig(pomodoro({ longBreakEnabled: false }))).toBe(true)
  })
})

describe('unlimited config (AC4.2)', () => {
  it.each([null, 15, 30, 45, 60, 90, 120])('accepts reminders %s', (reminderMinutes) => {
    expect(isValidConfig({ mode: 'unlimited', reminderMinutes } as TimerConfig)).toBe(true)
  })

  it.each([0, 10, 20, 180])('rejects a %i-minute reminder', (reminderMinutes) => {
    expect(
      validateConfig({ mode: 'unlimited', reminderMinutes } as unknown as TimerConfig),
    ).toHaveLength(1)
  })
})

it('rejects an unknown mode', () => {
  expect(validateConfig({ mode: 'stopwatch' } as unknown as TimerConfig)).toEqual([
    { field: 'mode', message: 'Unknown timer mode.' },
  ])
})
