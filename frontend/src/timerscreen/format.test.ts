import { describe, expect, it } from 'vitest'
import { formatCountdown, formatDuration, formatElapsed } from './format.ts'

describe('format', () => {
  it('rounds a countdown up so 00:00 means over', () => {
    expect(formatCountdown(25 * 60_000)).toBe('25:00')
    expect(formatCountdown(24 * 60_000 + 59_001)).toBe('25:00')
    expect(formatCountdown(1)).toBe('00:01')
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(-5)).toBe('00:00')
    expect(formatCountdown(3_900_000)).toBe('1:05:00')
  })

  it('rounds elapsed time down', () => {
    expect(formatElapsed(999)).toBe('00:00')
    expect(formatElapsed(65_999)).toBe('01:05')
    expect(formatElapsed(12 * 3_600_000)).toBe('12:00:00')
  })

  it('formats durations for the summary', () => {
    expect(formatDuration(40)).toBe('40 s')
    expect(formatDuration(25 * 60)).toBe('25 min')
    expect(formatDuration(3900)).toBe('1 h 05 min')
  })
})
