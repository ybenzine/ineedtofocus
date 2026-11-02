// The event builder against the shared fixture (AC14.2, AC14.3, AC14.7): raw values and the
// exact serialized lines, plus the constant properties the fixture leaves out.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CustomTag } from '../tags/api.ts'
import { buildTagsView } from '../tags/view.ts'
import {
  buildEvent,
  escapeText,
  eventsToIcs,
  foldLine,
  googleCalendarUrl,
  icsFileName,
  type CalendarEventSettings,
  type EventSession,
} from './event.ts'

interface FixtureCase {
  reason: string
  session: {
    id: string
    mode: string
    tag: string
    goal: string | null
    started_at: string
    ended_at: string
    focus_seconds: number
    paused_seconds: number
    status: string
    blocks_completed: number
    mode_config: { mode: string; blocks?: number }
  }
  settings: {
    calendar_title_template: string
    calendar_include_goal: boolean
    calendar_include_description: boolean
  }
  expected: {
    uid: string
    dtstart: string
    dtend: string
    summary: string
    description: string | null
    categories: string
    ics: Record<string, string>
  }
}

const fixture = JSON.parse(
  // Vitest runs from `frontend/`.
  readFileSync(resolve(process.cwd(), '../_docs/api/fixtures/calendar-events.json'), 'utf-8'),
) as {
  origin: string
  tags: { id: string; name: string; removed: boolean }[]
  cases: FixtureCase[]
}

const customTags: CustomTag[] = fixture.tags.map((t) => ({
  id: t.id,
  name: t.name,
  color: 'indigo',
  createdAt: '2026-10-01T00:00:00Z',
  removedAt: t.removed ? '2026-10-20T00:00:00Z' : null,
}))
const view = buildTagsView(customTags)

function toEventSession(c: FixtureCase): EventSession {
  const s = c.session
  return {
    id: s.id,
    mode: s.mode,
    tagName: view.info(s.tag).name,
    goal: s.goal,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    focusSeconds: s.focus_seconds,
    pausedSeconds: s.paused_seconds,
    endedEarly: s.status === 'ended_early',
    blocks: s.mode_config.mode === 'pomodoro' ? (s.mode_config.blocks ?? null) : null,
    blocksCompleted: s.blocks_completed,
  }
}

function toSettings(c: FixtureCase): CalendarEventSettings {
  return {
    titleTemplate: c.settings.calendar_title_template,
    includeGoal: c.settings.calendar_include_goal,
    includeDescription: c.settings.calendar_include_description,
  }
}

/** Content lines of the first VEVENT, in their folded form, by property name. */
function properties(ics: string): Record<string, string> {
  const logical: string[] = []
  for (const line of ics.split('\r\n')) {
    if (line.startsWith(' ') && logical.length > 0) logical[logical.length - 1] += `\r\n${line}`
    else logical.push(line)
  }
  const out: Record<string, string> = {}
  let inEvent = false
  for (const line of logical) {
    if (line === 'BEGIN:VEVENT') inEvent = true
    else if (line === 'END:VEVENT') inEvent = false
    else if (inEvent) out[line.split(':', 1)[0] as string] = line
  }
  return out
}

describe('fixture calendar-events.json', () => {
  it('has the 16 cases this suite is written for', () => {
    expect(fixture.cases).toHaveLength(16)
  })

  describe.each(fixture.cases.map((c) => [c.reason, c] as const))('%s', (_reason, c) => {
    const event = buildEvent(toEventSession(c), toSettings(c), fixture.origin)

    it('gives the raw values', () => {
      expect(event.uid).toBe(c.expected.uid)
      expect(event.dtstart).toBe(c.expected.dtstart)
      expect(event.dtend).toBe(c.expected.dtend)
      expect(event.summary).toBe(c.expected.summary)
      expect(event.description).toBe(c.expected.description)
      expect(event.categories).toBe(c.expected.categories)
    })

    it('serializes each line exactly', () => {
      const props = properties(eventsToIcs([event], new Date('2026-11-02T10:00:00.900Z')))
      // A null entry means the property is absent (description off).
      const ics = Object.entries(c.expected.ics as Record<string, string | null>)
      for (const [name, line] of ics) expect(props[name]).toBe(line ?? undefined)
      // Nothing else but the constants.
      const present = ics.filter(([, line]) => line !== null).map(([name]) => name)
      expect(Object.keys(props).sort()).toEqual([...present, 'DTSTAMP', 'TRANSP'].sort())
    })
  })
})

describe('the file', () => {
  const c = fixture.cases[0] as FixtureCase
  const event = buildEvent(toEventSession(c), toSettings(c), fixture.origin)
  const ics = eventsToIcs([event], new Date('2026-11-02T10:00:00.900Z'))

  it('is CRLF-terminated with a calendar around one event', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true)
    expect(ics.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1)
  })

  it('has the constant properties and a whole-second DTSTAMP', () => {
    const props = properties(ics)
    expect(props.DTSTAMP).toBe('DTSTAMP:20261102T100000Z')
    expect(props.TRANSP).toBe('TRANSP:TRANSPARENT')
    expect(props.CATEGORIES).toBe('CATEGORIES:Work')
    expect(ics).not.toContain('VALARM')
  })

  it('never has a physical line over 75 octets', () => {
    for (const each of fixture.cases) {
      const text = eventsToIcs(
        [buildEvent(toEventSession(each), toSettings(each), fixture.origin)],
        new Date(),
      )
      for (const line of text.split('\r\n')) {
        expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
      }
    }
  })
})

describe('escaping and folding', () => {
  it('escapes backslash, semicolon, comma and line breaks', () => {
    expect(escapeText('a,b;c\\d\ne\r\nf')).toBe('a\\,b\\;c\\\\d\\ne\\nf')
  })

  it('never splits a UTF-8 character or a surrogate pair', () => {
    const line = 'X:' + 'é'.repeat(80) + '😀'.repeat(30)
    const physical = foldLine(line).split('\r\n')
    expect(physical.length).toBeGreaterThan(1)
    physical.forEach((p, i) => {
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75)
      if (i > 0) expect(p.startsWith(' ')).toBe(true)
    })
    expect(physical.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line)
  })
})

describe('Google Calendar URL', () => {
  const c = fixture.cases[1] as FixtureCase // goal with , ; \ and a line break
  const event = buildEvent(toEventSession(c), toSettings(c), fixture.origin)

  it('encodes text and details and gives the dates in UTC', () => {
    const url = new URL(googleCalendarUrl(event))
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(url.searchParams.get('action')).toBe('TEMPLATE')
    expect(url.searchParams.get('text')).toBe(event.summary)
    expect(url.searchParams.get('dates')).toBe(`${event.dtstart}/${event.dtend}`)
    expect(url.searchParams.get('details')).toBe(event.description)
    expect(googleCalendarUrl(event)).toContain('details=Goal%3A')
    expect(googleCalendarUrl(event)).not.toMatch(/[ \n;,]/)
  })

  it('has no details when the description is off', () => {
    const off = buildEvent(
      toEventSession(c),
      { ...toSettings(c), includeDescription: false },
      fixture.origin,
    )
    expect(new URL(googleCalendarUrl(off)).searchParams.has('details')).toBe(false)
  })

  it('trims long details with an ellipsis to stay under 2,000 characters', () => {
    const long: EventSession = { ...toEventSession(c), goal: 'é, é; '.repeat(60) }
    const big = buildEvent(long, toSettings(c), fixture.origin)
    expect(googleCalendarUrl(big, 100_000).length).toBeGreaterThan(2000)
    const url = googleCalendarUrl(big)
    expect(url.length).toBeLessThanOrEqual(2000)
    const details = new URL(url).searchParams.get('details') as string
    expect(details.endsWith('…')).toBe(true)
    expect(big.description?.startsWith(details.slice(0, -1))).toBe(true)
    // Nearly full: the next character would not have fit.
    expect(url.length).toBeGreaterThan(1900)
  })
})

describe('file name', () => {
  it('is the local date and time of the start', () => {
    expect(icsFileName('2026-10-30T09:05:00Z', 'UTC')).toBe('ineedtofocus-2026-10-30-0905.ics')
    expect(icsFileName('2026-10-30T23:30:00Z', 'Europe/Paris')).toBe(
      'ineedtofocus-2026-10-31-0030.ics',
    )
  })
})
