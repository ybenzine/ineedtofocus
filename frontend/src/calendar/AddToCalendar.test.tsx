// The Add to calendar control (F14, AC14.7): choices, settings applied, offline, keyboard.

import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsContext } from '../settings/SettingsContext.ts'
import { SettingsStore } from '../settings/store.ts'
import { TagsContext } from '../tags/context.ts'
import { TagsStore } from '../tags/store.ts'
import { FakeTagsApi } from '../test/fakeTagsApi.ts'
import SessionSummary from '../timerscreen/SessionSummary.tsx'
import type { SessionRecord } from '../timer/index.ts'
import AddToCalendar, { type CalendarSession } from './AddToCalendar.tsx'

const session: CalendarSession = {
  id: '0f6e2b9a-3c1d-4e5f-8a7b-0000000000aa',
  mode: 'countdown',
  tag: 'work',
  goal: 'Write chapter 3',
  startedAt: '2026-10-30T09:00:00.000Z',
  endedAt: '2026-10-30T09:25:00.000Z',
  focusSeconds: 1500,
  pausedSeconds: 0,
  status: 'completed',
  blocks: null,
  blocksCompleted: 0,
}

const record: SessionRecord = {
  id: session.id,
  mode: 'countdown',
  tag: 'work',
  goal: 'Write chapter 3',
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  focusSeconds: 1500,
  pausedSeconds: 0,
  status: 'completed',
  modeConfig: { mode: 'countdown', minutes: 25 },
  blocksCompleted: 0,
}

function withProviders(ui: ReactElement, settings = new SettingsStore(), tags = new TagsStore()) {
  return (
    <SettingsContext.Provider value={settings}>
      <TagsContext.Provider value={tags}>{ui}</TagsContext.Provider>
    </SettingsContext.Provider>
  )
}

function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online)
}

const label = /^Add to calendar: Work, 25 min on /

beforeEach(() => setOnline(true))
afterEach(() => vi.restoreAllMocks())

describe('the control', () => {
  it('is a button named by the session, which opens two choices', () => {
    render(withProviders(<AddToCalendar session={session} timeZone="UTC" />))
    const button = screen.getByRole('button', {
      name: /^Add to calendar: Work, 25 min on Oct 30 at 9:00\s?AM$/,
    })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'Google Calendar' })).not.toBeInTheDocument()
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Google Calendar' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Apple Calendar / other (.ics)' }),
    ).toBeInTheDocument()
  })

  it('names a custom tag by its current name, and an unknown tag "Tag"', async () => {
    const api = new FakeTagsApi()
    const tag = api.add('Side, project')
    const tags = new TagsStore({ api, owner: 'u1' })
    await tags.refresh()
    const { rerender } = render(
      withProviders(<AddToCalendar session={{ ...session, tag: tag.id }} />, undefined, tags),
    )
    expect(
      screen.getByRole('button', { name: /^Add to calendar: Side, project, 25 min on / }),
    ).toBeInTheDocument()
    rerender(
      withProviders(
        <AddToCalendar session={{ ...session, tag: 'not-a-known-id' }} />,
        undefined,
        tags,
      ),
    )
    expect(screen.getByRole('button', { name: /^Add to calendar: Tag, 25 min on / })).toBeVisible()
  })

  it('moves focus into the choices, closes on Escape and gives focus back', () => {
    render(withProviders(<AddToCalendar session={session} />))
    const button = screen.getByRole('button', { name: label })
    button.focus()
    fireEvent.click(button)
    expect(screen.getByRole('link', { name: 'Google Calendar' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('link', { name: 'Google Calendar' }), { key: 'Escape' })
    expect(screen.queryByRole('link', { name: 'Google Calendar' })).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })
})

describe('Google Calendar', () => {
  it('opens the pre-filled page in a new tab, with the settings applied', () => {
    const settings = new SettingsStore()
    settings.update({ calendar_title_template: '{focus_time} of {tag}: {goal}' })
    render(withProviders(<AddToCalendar session={session} />, settings))
    fireEvent.click(screen.getByRole('button', { name: label }))
    const link = screen.getByRole('link', { name: 'Google Calendar' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    const url = new URL(link.getAttribute('href') ?? '')
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(url.searchParams.get('text')).toBe('25 min of Work: Write chapter 3')
    expect(url.searchParams.get('dates')).toBe('20261030T090000Z/20261030T092500Z')
    expect(url.searchParams.get('details')).toContain('Goal: Write chapter 3')
  })

  it('leaves the goal out when goals are off, and the details when the description is off', () => {
    const settings = new SettingsStore()
    settings.update({ calendar_include_goal: false, calendar_include_description: false })
    render(withProviders(<AddToCalendar session={session} />, settings))
    fireEvent.click(screen.getByRole('button', { name: label }))
    const url = new URL(
      screen.getByRole('link', { name: 'Google Calendar' }).getAttribute('href') ?? '',
    )
    expect(url.searchParams.get('text')).toBe('Work')
    expect(url.searchParams.has('details')).toBe(false)
  })

  it('does not apply the tag or minimum-length settings: the session was picked on purpose', () => {
    const settings = new SettingsStore()
    settings.update({ calendar_excluded_tags: ['work'], calendar_min_minutes: 15 })
    render(withProviders(<AddToCalendar session={{ ...session, focusSeconds: 90 }} />, settings))
    expect(screen.getByRole('button', { name: /^Add to calendar: Work, 1 min on / })).toBeVisible()
  })

  it('is disabled offline, with a hint, and does nothing', () => {
    setOnline(false)
    render(withProviders(<AddToCalendar session={session} />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(screen.queryByRole('link', { name: 'Google Calendar' })).not.toBeInTheDocument()
    const google = screen.getByRole('button', { name: 'Google Calendar' })
    expect(google).toHaveAttribute('aria-disabled', 'true')
    expect(google).toHaveAccessibleDescription('Needs a connection')
    const open = vi.spyOn(window, 'open')
    fireEvent.click(google)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('Apple Calendar / other (.ics)', () => {
  function capture() {
    const blobs: Blob[] = []
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob)
          return 'blob:test'
        },
        revokeObjectURL: vi.fn(),
      }),
    )
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download)
    })
    return { blobs, downloads }
  }

  it('saves ineedtofocus-<local date>-<HHMM>.ics with a one-event file', async () => {
    const { blobs, downloads } = capture()
    render(withProviders(<AddToCalendar session={session} timeZone="UTC" />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    fireEvent.click(screen.getByRole('button', { name: 'Apple Calendar / other (.ics)' }))
    expect(downloads).toEqual(['ineedtofocus-2026-10-30-0900.ics'])
    expect(blobs[0]?.type).toBe('text/calendar;charset=utf-8')
    const text = await (blobs[0] as Blob).text()
    expect(text).toContain('BEGIN:VCALENDAR\r\n')
    expect(text).toContain('UID:0f6e2b9a-3c1d-4e5f-8a7b-0000000000aa@ineedtofoc.us\r\n')
    expect(text).toContain('SUMMARY:Work: Write chapter 3\r\n')
    expect(text).toContain('DTSTART:20261030T090000Z\r\nDTEND:20261030T092500Z\r\n')
    expect(text).toContain('TRANSP:TRANSPARENT\r\n')
    expect(text).not.toContain('VALARM')
    // Closed afterwards, focus back on the button.
    expect(screen.getByRole('button', { name: label })).toHaveFocus()
  })

  it('works offline', async () => {
    setOnline(false)
    const { blobs, downloads } = capture()
    render(withProviders(<AddToCalendar session={session} timeZone="UTC" />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    fireEvent.click(screen.getByRole('button', { name: 'Apple Calendar / other (.ics)' }))
    expect(downloads).toHaveLength(1)
    expect(await (blobs[0] as Blob).text()).toContain('SUMMARY:Work: Write chapter 3')
  })

  it('opens the file on iOS, which shows the Calendar sheet', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)',
    )
    capture()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(withProviders(<AddToCalendar session={session} />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    fireEvent.click(screen.getByRole('button', { name: 'Apple Calendar / other (.ics)' }))
    expect(open).toHaveBeenCalledWith('blob:test', '_blank')
  })
})

describe('on the session summary (AC14.7)', () => {
  it('is on a signed-in summary, also for a session not synced yet', () => {
    render(
      withProviders(
        <SessionSummary outcome={{ kind: 'saved', record }} recordPending onNewSession={vi.fn()} />,
      ),
    )
    expect(screen.getByText(/Not saved yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: label })).toBeVisible()
  })

  it('is absent from a summary without an account, and appears on it once it is the account’s', () => {
    const ui = (savePrompt: boolean, inAccount: boolean) =>
      withProviders(
        <SessionSummary
          outcome={{ kind: 'saved', record }}
          savePrompt={savePrompt}
          inAccount={inAccount}
          onNewSession={vi.fn()}
        />,
      )
    const { rerender } = render(ui(true, false))
    expect(screen.getByText(/to save this session/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Add to calendar: / })).not.toBeInTheDocument()
    rerender(ui(false, true))
    expect(screen.queryByText(/to save this session/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: label })).toBeVisible()
  })

  it('is absent when the session was not saved', () => {
    render(
      withProviders(
        <SessionSummary
          outcome={{
            kind: 'discarded',
            reason: 'too_short',
            focusSeconds: 10,
            message: 'Too short',
          }}
          onNewSession={vi.fn()}
        />,
      ),
    )
    expect(screen.queryByRole('button', { name: /^Add to calendar: / })).not.toBeInTheDocument()
  })
})
