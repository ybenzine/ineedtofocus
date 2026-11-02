// One session as a calendar event (F14, AC14.2, AC14.3, AC14.7), built on the device.
//
// The rules and the output are the backend's (`backend/app/calendar_ics.py`) and are checked
// against the shared fixture `_docs/api/fixtures/calendar-events.json`, so the one-event file
// made here matches the feed and the History download, UID included. The builder is pure and
// holds no session or settings store, so the History download (#382) can reuse it per session.
//
// Privacy: goals and custom tag names are user content (AC14.8). Nothing here logs or sends.

import { formatDuration } from '../timerscreen/format.ts'

export const UID_DOMAIN = 'ineedtofoc.us'
export const FALLBACK_TITLE = 'Focus session'
const PRODID = '-//I Need To Focus//Calendar export//EN'
const CRLF = '\r\n'

/** The calendar settings that shape an event (AC12.8). */
export interface CalendarEventSettings {
  titleTemplate: string
  includeGoal: boolean
  includeDescription: boolean
}

/** A session as the event needs it; `tagName` is the tag's display name, not its id. */
export interface EventSession {
  id: string
  mode: string
  /** The tag's display name (AC7.8): built-in, a custom tag's current name, or "Tag". */
  tagName: string
  goal: string | null
  /** ISO 8601 instants. */
  startedAt: string
  endedAt: string
  focusSeconds: number
  pausedSeconds: number
  endedEarly: boolean
  /** The Pomodoro configuration's blocks; null for the other modes. */
  blocks: number | null
  blocksCompleted: number
}

export interface CalendarEvent {
  uid: string
  /** `20261030T090000Z` */
  dtstart: string
  dtend: string
  summary: string
  /** Lines joined by LF; null when the description is off (no DESCRIPTION property). */
  description: string | null
  categories: string
}

const MODE_NAMES: Record<string, string> = {
  countdown: 'Countdown',
  pomodoro: 'Pomodoro',
  unlimited: 'Unlimited',
}

// AC14.3: spaces and these separators at either end of the title are trimmed.
const TRIM = new Set([' ', '·', ':', '-', '–'])
// Every boundary Python's str.splitlines() recognises, as the backend uses for goals.
// eslint-disable-next-line no-control-regex
const LINE_BREAKS = /[\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029]+/g

function trimEnds(text: string): string {
  const chars = Array.from(text)
  let start = 0
  let end = chars.length
  while (start < end && TRIM.has(chars[start] as string)) start += 1
  while (end > start && TRIM.has(chars[end - 1] as string)) end -= 1
  return chars.slice(start, end).join('')
}

/** AC14.3: one pass over the placeholders; values are never rescanned. */
export function renderTitle(template: string, values: Record<string, string>): string {
  const text = template.replace(
    /\{(tag|goal|mode|focus_time)\}/g,
    (_match, name: string) => values[name] ?? '',
  )
  return trimEnds(text.replace(/ {2,}/g, ' ')) || FALLBACK_TITLE
}

/** `20261030T090000Z`, to the whole second (fractions are dropped, not rounded). */
export function icsStamp(iso: string): string {
  const ms = Date.parse(iso)
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:]|\.000/g, '')
}

export function buildEvent(
  session: EventSession,
  settings: CalendarEventSettings,
  origin: string,
): CalendarEvent {
  let goal = session.goal ? session.goal.replace(LINE_BREAKS, ' ') : ''
  if (!settings.includeGoal) goal = ''
  const mode =
    MODE_NAMES[session.mode] ?? session.mode.charAt(0).toUpperCase() + session.mode.slice(1)
  const focusTime = formatDuration(session.focusSeconds)
  const summary = renderTitle(settings.titleTemplate, {
    tag: session.tagName,
    goal,
    mode,
    focus_time: focusTime,
  })
  let description: string | null = null
  if (settings.includeDescription) {
    const lines = goal ? [`Goal: ${goal}`] : []
    lines.push(`Tag: ${session.tagName}`, `Mode: ${mode}`, `Focus time: ${focusTime}`)
    if (session.pausedSeconds > 0) lines.push(`Paused: ${formatDuration(session.pausedSeconds)}`)
    if (session.mode === 'pomodoro' && session.blocks !== null) {
      lines.push(`Blocks completed: ${session.blocksCompleted} of ${session.blocks}`)
    }
    if (session.endedEarly) lines.push('Ended early')
    lines.push(`History: ${origin}/history`)
    description = lines.join('\n')
  }
  return {
    uid: `${session.id}@${UID_DOMAIN}`,
    dtstart: icsStamp(session.startedAt),
    dtend: icsStamp(session.endedAt),
    summary,
    description,
    categories: session.tagName,
  }
}

/** TEXT escaping: backslash, semicolon, comma and line break (`\n`). */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\\;,]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n')
}

const encoder = new TextEncoder()

/**
 * Folds a content line at 75 octets (continuations: a space plus at most 74), greedily, never
 * inside a UTF-8 character. Acts on the already escaped line; no trailing CRLF.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line
  const parts: string[] = []
  let current = ''
  let used = 0
  let limit = 75
  for (const char of line) {
    const size = encoder.encode(char).length
    if (used + size > limit) {
      parts.push(current)
      current = ''
      used = 0
      limit = 74
    }
    current += char
    used += size
  }
  parts.push(current)
  return parts.join(`${CRLF} `)
}

function property(name: string, value: string): string {
  return foldLine(`${name}:${value}`)
}

/** The folded property lines of one VEVENT. */
export function eventLines(event: CalendarEvent, dtstamp: string): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${event.dtstart}`,
    `DTEND:${event.dtend}`,
    property('SUMMARY', escapeText(event.summary)),
  ]
  if (event.description !== null) {
    lines.push(property('DESCRIPTION', escapeText(event.description)))
  }
  lines.push(
    property('CATEGORIES', escapeText(event.categories)),
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
  )
  return lines
}

/** A whole VCALENDAR of the given events, CRLF-terminated. `now` is the DTSTAMP. */
export function eventsToIcs(events: readonly CalendarEvent[], now: Date): string {
  const dtstamp = icsStamp(now.toISOString())
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events.flatMap((e) => eventLines(e, dtstamp)),
    'END:VCALENDAR',
  ]
  return lines.join(CRLF) + CRLF
}

const GOOGLE_RENDER = 'https://calendar.google.com/calendar/render'
export const GOOGLE_URL_BUDGET = 2000

function googleUrlWith(event: CalendarEvent, details: string | null): string {
  const query = [
    'action=TEMPLATE',
    `text=${encodeURIComponent(event.summary)}`,
    `dates=${event.dtstart}/${event.dtend}`,
  ]
  if (details !== null) query.push(`details=${encodeURIComponent(details)}`)
  return `${GOOGLE_RENDER}?${query.join('&')}`
}

/**
 * The pre-filled Google Calendar page. The details are trimmed (ending in an ellipsis) so the
 * whole URL stays within `budget` characters; without a description there is no `details`.
 */
export function googleCalendarUrl(event: CalendarEvent, budget = GOOGLE_URL_BUDGET): string {
  if (event.description === null) return googleUrlWith(event, null)
  const full = googleUrlWith(event, event.description)
  if (full.length <= budget) return full
  const chars = Array.from(event.description)
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (googleUrlWith(event, chars.slice(0, mid).join('').trimEnd() + '…').length <= budget)
      low = mid
    else high = mid - 1
  }
  return googleUrlWith(event, chars.slice(0, low).join('').trimEnd() + '…')
}

function localParts(iso: string, timeZone?: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  return Object.fromEntries(parts.map((p) => [p.type, p.value]))
}

/** `ineedtofocus-<local date>-<HHMM>.ics`, from the session's start in the user's time zone. */
export function icsFileName(startedAt: string, timeZone?: string): string {
  const p = localParts(startedAt, timeZone)
  return `ineedtofocus-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}.ics`
}
