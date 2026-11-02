// The Settings API (#12): GET and partial PATCH of /api/settings.

import { recentCustomMinutes } from '../setup/options.ts'
import { type Tag } from '../timer/index.ts'

/** The Pomodoro configuration as the API stores it (snake_case, no `mode`). */
export interface ApiPomodoroConfig {
  focus_minutes: number
  break_minutes: number
  blocks: number
  long_break_enabled: boolean
  long_break_minutes: number
}

export type ReminderSetting = 15 | 30 | 45 | 60 | 90 | 120 | null

/** Colour theme (#214): System follows the device's light/dark setting. */
export type ThemeSetting = 'system' | 'dark' | 'light'
export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'dark', 'light']

export interface Settings {
  /** 0 = Sunday ... 6 = Saturday (AC12.1) */
  week_start_day: number
  /** Deprecated (#336): the sound levels are device settings now. Only read to seed a device. */
  alert_volume: number
  /** Deprecated (#336), as `alert_volume`. */
  background_volume: number
  /** AC12.3 */
  keep_screen_awake: boolean
  /** AC12.6: pause Rain/YouTube during Pomodoro breaks */
  pause_audio_on_breaks: boolean
  /** AC12.4; null = Off */
  default_reminder_minutes: ReminderSetting
  /** AC12.5; null until first use */
  pomodoro_config: ApiPomodoroConfig | null
  /** AC12.5; null means Work */
  last_tag: Tag | null
  /** #214 */
  theme: ThemeSetting
  /** The last custom Countdown length (AC2.7, #409); null = none. */
  countdown_recent_minutes: number | null
  /** Calendar export (F14, AC12.8). The Settings section is #382; #383 reads the first three. */
  calendar_title_template: string
  calendar_include_goal: boolean
  calendar_include_description: boolean
  /** Tag identifiers left out of the subscription feed. */
  calendar_excluded_tags: string[]
  calendar_min_minutes: CalendarMinMinutes
  calendar_name: string
}

/** The calendar settings: for signed-in users only, never kept in a guest's copy. */
export const CALENDAR_KEYS = [
  'calendar_title_template',
  'calendar_include_goal',
  'calendar_include_description',
  'calendar_excluded_tags',
  'calendar_min_minutes',
  'calendar_name',
] as const satisfies readonly (keyof Settings)[]

/** Length in code points, as the server counts. */
const chars = (value: string): number => Array.from(value).length

export type CalendarMinMinutes = 0 | 5 | 10 | 15
export const CALENDAR_MIN_MINUTES: readonly CalendarMinMinutes[] = [0, 5, 10, 15]
export const DEFAULT_CALENDAR_TITLE = '{tag}: {goal}'

/** What an edit may change: the sound levels are not synced (#336). */
export type SettingsPatch = Partial<Omit<Settings, 'alert_volume' | 'background_volume'>>

/** The settings that sync. */
export const SETTINGS_KEYS = [
  'week_start_day',
  'keep_screen_awake',
  'pause_audio_on_breaks',
  'default_reminder_minutes',
  'pomodoro_config',
  'last_tag',
  'theme',
  'countdown_recent_minutes',
  'calendar_title_template',
  'calendar_include_goal',
  'calendar_include_description',
  'calendar_excluded_tags',
  'calendar_min_minutes',
  'calendar_name',
] as const satisfies readonly (keyof SettingsPatch)[]

/** Defaults for a new user (decision log 2026-10-21, AC12.x). */
export const DEFAULT_SETTINGS: Settings = {
  week_start_day: 0,
  alert_volume: 80,
  background_volume: 50,
  keep_screen_awake: false,
  pause_audio_on_breaks: true,
  default_reminder_minutes: null,
  pomodoro_config: null,
  last_tag: null,
  theme: 'system',
  countdown_recent_minutes: null,
  calendar_title_template: DEFAULT_CALENDAR_TITLE,
  calendar_include_goal: true,
  calendar_include_description: true,
  calendar_excluded_tags: [],
  calendar_min_minutes: 0,
  calendar_name: 'I Need To Focus',
}

export type SettingsErrorKind = 'network' | 'unauthorized' | 'invalid' | 'server'

export class SettingsError extends Error {
  readonly kind: SettingsErrorKind
  /** For `invalid`: the settings the server named as rejected; empty when it didn't say. */
  readonly fields: string[]
  constructor(kind: SettingsErrorKind, message: string, fields: string[] = []) {
    super(message)
    this.kind = kind
    this.fields = fields
  }
}

export interface SettingsApi {
  get(signal?: AbortSignal): Promise<Settings>
  patch(patch: SettingsPatch, signal?: AbortSignal): Promise<Settings>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function parsePomodoro(value: unknown): ApiPomodoroConfig | null {
  if (!isObject(value)) return null
  const { focus_minutes, break_minutes, blocks, long_break_enabled, long_break_minutes } = value
  if (
    intIn(focus_minutes, 5, 90) &&
    intIn(break_minutes, 1, 30) &&
    intIn(blocks, 1, 8) &&
    typeof long_break_enabled === 'boolean' &&
    intIn(long_break_minutes, 5, 60)
  ) {
    return { focus_minutes, break_minutes, blocks, long_break_enabled, long_break_minutes }
  }
  return null
}

/** Reads settings from untrusted JSON (the server or the device cache); bad fields get defaults. */
export function parseSettings(value: unknown): Settings {
  const d = DEFAULT_SETTINGS
  if (!isObject(value)) return d
  const reminder = value.default_reminder_minutes
  return {
    week_start_day: intIn(value.week_start_day, 0, 6) ? value.week_start_day : d.week_start_day,
    alert_volume: intIn(value.alert_volume, 0, 100) ? value.alert_volume : d.alert_volume,
    background_volume: intIn(value.background_volume, 0, 100)
      ? value.background_volume
      : d.background_volume,
    keep_screen_awake:
      typeof value.keep_screen_awake === 'boolean' ? value.keep_screen_awake : d.keep_screen_awake,
    pause_audio_on_breaks:
      typeof value.pause_audio_on_breaks === 'boolean'
        ? value.pause_audio_on_breaks
        : d.pause_audio_on_breaks,
    default_reminder_minutes: [15, 30, 45, 60, 90, 120].includes(reminder as number)
      ? (reminder as ReminderSetting)
      : null,
    pomodoro_config: parsePomodoro(value.pomodoro_config),
    last_tag:
      typeof value.last_tag === 'string' && value.last_tag !== '' ? (value.last_tag as Tag) : null,
    theme: (THEME_SETTINGS as readonly unknown[]).includes(value.theme)
      ? (value.theme as ThemeSetting)
      : d.theme,
    countdown_recent_minutes: recentCustomMinutes(value.countdown_recent_minutes),
    calendar_title_template:
      typeof value.calendar_title_template === 'string' &&
      chars(value.calendar_title_template) <= 120
        ? value.calendar_title_template
        : d.calendar_title_template,
    calendar_include_goal:
      typeof value.calendar_include_goal === 'boolean'
        ? value.calendar_include_goal
        : d.calendar_include_goal,
    calendar_include_description:
      typeof value.calendar_include_description === 'boolean'
        ? value.calendar_include_description
        : d.calendar_include_description,
    calendar_excluded_tags:
      Array.isArray(value.calendar_excluded_tags) &&
      value.calendar_excluded_tags.every((t) => typeof t === 'string')
        ? (value.calendar_excluded_tags as string[])
        : d.calendar_excluded_tags,
    calendar_min_minutes: (CALENDAR_MIN_MINUTES as readonly unknown[]).includes(
      value.calendar_min_minutes,
    )
      ? (value.calendar_min_minutes as CalendarMinMinutes)
      : d.calendar_min_minutes,
    calendar_name:
      typeof value.calendar_name === 'string' &&
      chars(value.calendar_name) >= 1 &&
      chars(value.calendar_name) <= 60
        ? value.calendar_name
        : d.calendar_name,
  }
}

/** Names of the settings a 422 body points at (`error.details[].field`, first path segment). */
async function rejectedFields(response: Response): Promise<string[]> {
  try {
    const body = (await response.json()) as { error?: { details?: { field?: unknown }[] | null } }
    const fields = (body.error?.details ?? []).flatMap((detail) =>
      typeof detail.field === 'string' ? [detail.field.split('.')[0] ?? ''] : [],
    )
    return fields.filter((field) => (SETTINGS_KEYS as readonly string[]).includes(field))
  } catch {
    return []
  }
}

async function call(
  method: 'GET' | 'PATCH',
  body?: SettingsPatch,
  signal?: AbortSignal,
): Promise<Settings> {
  let response: Response
  try {
    response = await fetch('/api/settings', {
      method,
      credentials: 'same-origin',
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new SettingsError('network', "Can't reach the server.")
  }
  if (response.status === 401) throw new SettingsError('unauthorized', 'Not signed in.')
  if (response.status === 422) {
    throw new SettingsError(
      'invalid',
      'The server rejected a value.',
      await rejectedFields(response),
    )
  }
  if (!response.ok) throw new SettingsError('server', 'The server could not save settings.')
  try {
    return parseSettings(await response.json())
  } catch {
    throw new SettingsError('server', 'Unreadable response.')
  }
}

export const httpSettingsApi: SettingsApi = {
  get: (signal) => call('GET', undefined, signal),
  patch: (patch, signal) => call('PATCH', patch, signal),
}
