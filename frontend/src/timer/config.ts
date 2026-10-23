// Timer mode configurations and their validation (F2, F3, F4).

export const MINUTE_MS = 60_000

export type Mode = 'countdown' | 'pomodoro' | 'unlimited'

/** AC7.1: the fixed set of tags, in display order. */
export const TAGS = ['work', 'study', 'nap', 'read', 'meditation', 'exercise'] as const

export type Tag = (typeof TAGS)[number]

/** AC2.1: 1–240 whole minutes. */
export interface CountdownConfig {
  mode: 'countdown'
  minutes: number
}

/** AC3.1/AC3.2. The long break replaces the short break after every 4th focus block when enabled. */
export interface PomodoroConfig {
  mode: 'pomodoro'
  focusMinutes: number
  breakMinutes: number
  blocks: number
  longBreakEnabled: boolean
  longBreakMinutes: number
}

/** AC4.2: `null` means reminders are off. */
export interface UnlimitedConfig {
  mode: 'unlimited'
  reminderMinutes: ReminderMinutes | null
}

export type TimerConfig = CountdownConfig | PomodoroConfig | UnlimitedConfig

export const COUNTDOWN_LIMITS = { min: 1, max: 240 } as const

export const POMODORO_LIMITS = {
  focusMinutes: { min: 5, max: 90 },
  breakMinutes: { min: 1, max: 30 },
  blocks: { min: 1, max: 8 },
  longBreakMinutes: { min: 5, max: 60 },
} as const

/** A long break (when enabled) follows every Nth focus block (AC3.2). */
export const LONG_BREAK_EVERY = 4

/** AC3.1 defaults; the long break is off, with 15 min ready for when it is turned on. */
export const DEFAULT_POMODORO: PomodoroConfig = {
  mode: 'pomodoro',
  focusMinutes: 25,
  breakMinutes: 5,
  blocks: 4,
  longBreakEnabled: false,
  longBreakMinutes: 15,
}

export const REMINDER_OPTIONS = [15, 30, 45, 60, 90, 120] as const
export type ReminderMinutes = (typeof REMINDER_OPTIONS)[number]

/** AC4.5: the unlimited timer stops itself after 12 hours of focus time. */
export const UNLIMITED_MAX_MS = 12 * 60 * MINUTE_MS

/** AC6.2: sessions with less focus time than this are not saved. */
export const MIN_SAVED_FOCUS_MS = MINUTE_MS

export interface ConfigError {
  field: string
  message: string
}

function checkWholeMinutes(
  errors: ConfigError[],
  field: string,
  value: number,
  limits: { min: number; max: number },
): void {
  if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
    errors.push({
      field,
      message: `Must be a whole number of minutes from ${limits.min} to ${limits.max}.`,
    })
  }
}

/** Returns every problem with a configuration; an empty list means it can be started. */
export function validateConfig(config: TimerConfig): ConfigError[] {
  const errors: ConfigError[] = []
  switch (config.mode) {
    case 'countdown':
      checkWholeMinutes(errors, 'minutes', config.minutes, COUNTDOWN_LIMITS)
      break
    case 'pomodoro':
      checkWholeMinutes(errors, 'focusMinutes', config.focusMinutes, POMODORO_LIMITS.focusMinutes)
      checkWholeMinutes(errors, 'breakMinutes', config.breakMinutes, POMODORO_LIMITS.breakMinutes)
      if (
        !Number.isInteger(config.blocks) ||
        config.blocks < POMODORO_LIMITS.blocks.min ||
        config.blocks > POMODORO_LIMITS.blocks.max
      ) {
        errors.push({
          field: 'blocks',
          message: `Must be a whole number of blocks from ${POMODORO_LIMITS.blocks.min} to ${POMODORO_LIMITS.blocks.max}.`,
        })
      }
      if (typeof config.longBreakEnabled !== 'boolean') {
        errors.push({ field: 'longBreakEnabled', message: 'Must be on or off.' })
      }
      // The long-break length is validated even when off, since it is remembered for next time.
      checkWholeMinutes(
        errors,
        'longBreakMinutes',
        config.longBreakMinutes,
        POMODORO_LIMITS.longBreakMinutes,
      )
      break
    case 'unlimited':
      if (
        config.reminderMinutes !== null &&
        !(REMINDER_OPTIONS as readonly number[]).includes(config.reminderMinutes)
      ) {
        errors.push({
          field: 'reminderMinutes',
          message: `Must be off or one of ${REMINDER_OPTIONS.join(', ')} minutes.`,
        })
      }
      break
    default:
      errors.push({ field: 'mode', message: 'Unknown timer mode.' })
  }
  return errors
}

export function isValidConfig(config: TimerConfig): boolean {
  return validateConfig(config).length === 0
}
