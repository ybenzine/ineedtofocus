import { describe, expect, it } from 'vitest'
import { DEFAULT_POMODORO } from '../timer/index.ts'
import { arcDash, countdownArcs, pomodoroArcs, reminderTicks, stepTo, tickLine } from './dial.ts'
import { chimeLine, formatEndTime, formatLength, pomodoroTotalMinutes } from './length.ts'

describe('countdownArcs (AC9.5)', () => {
  it('fills minutes / 60 of one lap up to 60', () => {
    expect(countdownArcs(30)).toEqual([{ shade: 'accent', from: 0, to: 0.5 }])
    expect(countdownArcs(60)).toEqual([{ shade: 'accent', from: 0, to: 1 }])
    expect(countdownArcs(1)[0]?.to).toBeCloseTo(1 / 60)
  })

  it('90 is an accent lap and half a lighter lap', () => {
    expect(countdownArcs(90)).toEqual([
      { shade: 'accent', from: 0, to: 1 },
      { shade: 'light', from: 0, to: 0.5 },
    ])
  })

  it('150 is a lighter lap and half an accent lap', () => {
    expect(countdownArcs(150)).toEqual([
      { shade: 'light', from: 0, to: 1 },
      { shade: 'accent', from: 0, to: 0.5 },
    ])
  })

  it('shows a whole number of laps as one full ring in the last lap’s shade', () => {
    expect(countdownArcs(120)).toEqual([{ shade: 'light', from: 0, to: 1 }])
    expect(countdownArcs(240)).toEqual([{ shade: 'light', from: 0, to: 1 }])
    expect(countdownArcs(180)).toEqual([{ shade: 'accent', from: 0, to: 1 }])
  })

  it('draws nothing for an unreadable length', () => {
    expect(countdownArcs(Number.NaN)).toEqual([])
    expect(countdownArcs(0)).toEqual([])
  })
})

describe('pomodoroArcs', () => {
  it('splits one lap in proportion, with only the focus blocks drawn', () => {
    // 4 × 25 + 3 × 5 = 115 minutes.
    const arcs = pomodoroArcs(DEFAULT_POMODORO)
    expect(arcs).toHaveLength(4)
    expect(arcs[0]?.from).toBe(0)
    expect(arcs[0]?.to).toBeCloseTo(25 / 115)
    expect(arcs[1]?.from).toBeCloseTo(30 / 115)
    expect(arcs[3]?.to).toBe(1)
    expect(arcs.every((a) => a.shade === 'accent')).toBe(true)
  })

  it('leaves the long break as track too', () => {
    const arcs = pomodoroArcs({
      ...DEFAULT_POMODORO,
      blocks: 5,
      longBreakEnabled: true,
      longBreakMinutes: 15,
    })
    // 5 × 25 + 3 × 5 + 15 = 155; block 5 starts at 25 × 4 + 15 + 15 = 130.
    expect(arcs[4]?.from).toBeCloseTo(130 / 155)
  })
})

describe('reminderTicks (AC9.5)', () => {
  it.each([
    [15, [0, 15, 30, 45]],
    [30, [0, 30]],
    [45, [0, 45]],
    [60, [0]],
    [90, [0]],
    [120, [0]],
    [null, []],
  ])('%s gives %j', (interval, ticks) => {
    expect(reminderTicks(interval)).toEqual(ticks)
  })
})

describe('arc and tick geometry', () => {
  it('turns an arc into a dash with a square end', () => {
    const { dasharray, dashoffset } = arcDash({ shade: 'accent', from: 0.25, to: 0.5 }, 100)
    expect(dasharray).toBe('25.000 100.000')
    expect(dashoffset).toBe(-25)
  })

  it('puts the first tick at the top and the 15-minute one at the right', () => {
    const top = tickLine(0, 114, 110, 98)
    expect(top.x1).toBeCloseTo(114)
    expect(top.y1).toBeCloseTo(4)
    expect(top.y2).toBeCloseTo(16)
    const right = tickLine(0.25, 114, 110, 98)
    expect(right.x1).toBeCloseTo(224)
    expect(right.y1).toBeCloseTo(114)
  })
})

describe('stepTo (AC2.6, AC3.8)', () => {
  const countdown = { min: 1, max: 240 }
  const focus = { min: 5, max: 90 }
  it.each([
    [23, 1, 25],
    [23, -1, 20],
    [30, 1, 35],
    [30, -1, 25],
    [1, 1, 5],
    [5, -1, 1],
    [1, -1, 1],
    [240, 1, 240],
    [236, 1, 240],
    [0, 1, 5],
    [400, -1, 240],
  ])('countdown %i with direction %i gives %i', (from, direction, to) => {
    expect(stepTo(from, direction as 1 | -1, 5, countdown, 30)).toBe(to)
  })

  it.each([
    [52, 1, 55],
    [52, -1, 50],
    [5, -1, 5],
    [90, 1, 90],
    [6, -1, 5],
  ])('focus %i with direction %i gives %i', (from, direction, to) => {
    expect(stepTo(from, direction as 1 | -1, 5, focus, 25)).toBe(to)
  })

  it('steps by one within a small range', () => {
    expect(stepTo(4, 1, 1, { min: 1, max: 8 }, 4)).toBe(5)
    expect(stepTo(8, 1, 1, { min: 1, max: 8 }, 4)).toBe(8)
    expect(stepTo(1, -1, 1, { min: 1, max: 8 }, 4)).toBe(1)
  })

  it('starts from the fallback when the value is unreadable', () => {
    expect(stepTo(Number.NaN, 1, 5, countdown, 30)).toBe(35)
  })
})

describe('length formats (AC2.6, AC4.6)', () => {
  it.each([
    [1, '1m'],
    [30, '30m'],
    [59, '59m'],
    [60, '1h'],
    [90, '1h 30m'],
    [115, '1h 55m'],
    [120, '2h'],
    [240, '4h'],
  ])('%i is %s', (minutes, text) => {
    expect(formatLength(minutes)).toBe(text)
  })

  it('formats the end time in 12-hour and 24-hour locales, with no date', () => {
    const at = new Date(2026, 10, 1, 14, 5).getTime()
    expect(formatEndTime(at, 30, 'en-US')).toBe('2:35 pm')
    expect(formatEndTime(at, 30, 'en-GB')).toBe('14:35')
    expect(formatEndTime(new Date(2026, 10, 1, 23, 50).getTime(), 30, 'en-US')).toBe('12:20 am')
  })

  it('totals a Pomodoro with and without the long break', () => {
    expect(pomodoroTotalMinutes(DEFAULT_POMODORO)).toBe(115)
    expect(pomodoroTotalMinutes({ ...DEFAULT_POMODORO, blocks: 8, longBreakEnabled: true })).toBe(
      8 * 25 + 6 * 5 + 15,
    )
  })

  it('words the reminder', () => {
    expect(chimeLine(30)).toBe('chime every 30m')
    expect(chimeLine(90)).toBe('chime every 1h 30m')
    expect(chimeLine(120)).toBe('chime every 2h')
    expect(chimeLine(null)).toBe('no reminders')
  })
})
