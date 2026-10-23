// The Settings API (#12): GET and partial PATCH of /api/settings.

import { TAGS, type Tag } from '../timer/index.ts'

/** The Pomodoro configuration as the API stores it (snake_case, no `mode`). */
export interface ApiPomodoroConfig {
  focus_minutes: number
  break_minutes: number
  blocks: number
  long_break_enabled: boolean
  long_break_minutes: number
}

export type ReminderSetting = 15 | 30 | 45 | 60 | 90 | 120 | null

export interface Settings {
  /** 0 = Sunday ... 6 = Saturday (AC12.1) */
  week_start_day: number
  /** 0–100 (AC12.2) */
  alert_volume: number
  /** 0–100 (AC12.2) */
  background_volume: number
  /** AC12.3 */
  keep_screen_awake: boolean
  /** AC12.4; null = Off */
  default_reminder_minutes: ReminderSetting
  /** AC12.5; null until first use */
  pomodoro_config: ApiPomodoroConfig | null
  /** AC12.5; null means Work */
  last_tag: Tag | null
}

export type SettingsPatch = Partial<Settings>

export const SETTINGS_KEYS = [
  'week_start_day',
  'alert_volume',
  'background_volume',
  'keep_screen_awake',
  'default_reminder_minutes',
  'pomodoro_config',
  'last_tag',
] as const satisfies readonly (keyof Settings)[]

/** Defaults for a new user (decision log 2026-10-21, AC12.x). */
export const DEFAULT_SETTINGS: Settings = {
  week_start_day: 0,
  alert_volume: 80,
  background_volume: 50,
  keep_screen_awake: false,
  default_reminder_minutes: null,
  pomodoro_config: null,
  last_tag: null,
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
    default_reminder_minutes: [15, 30, 45, 60, 90, 120].includes(reminder as number)
      ? (reminder as ReminderSetting)
      : null,
    pomodoro_config: parsePomodoro(value.pomodoro_config),
    last_tag: (TAGS as readonly unknown[]).includes(value.last_tag)
      ? (value.last_tag as Tag)
      : null,
  }
}

/** Names of the settings a 422 body points at (`error.details[].field`, last path segment). */
async function rejectedFields(response: Response): Promise<string[]> {
  try {
    const body = (await response.json()) as { error?: { details?: { field?: unknown }[] | null } }
    const fields = (body.error?.details ?? []).flatMap((detail) =>
      typeof detail.field === 'string' ? [detail.field.split('.').pop() ?? ''] : [],
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
