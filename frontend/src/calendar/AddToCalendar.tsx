// "Add to calendar" for one session (F14, AC14.7), on the session summary and each History row.
//
// A button that opens two choices: Google Calendar (a pre-filled page in a new tab, which needs
// a connection) and Apple Calendar / other (a one-event .ics, which works offline). The event is
// built from the session this device has, so unsynced sessions work too. Signed-in users only:
// the screens that can show a session without an account don't render this.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useSettingsState } from '../settings/SettingsContext.ts'
import { useOnline } from '../sounds/useOnline.ts'
import { useTagsView } from '../tags/context.ts'
import { formatDuration } from '../timerscreen/format.ts'
import { saveIcs } from './download.ts'
import {
  buildEvent,
  eventsToIcs,
  googleCalendarUrl,
  icsFileName,
  type CalendarEvent,
} from './event.ts'

/** A session as the screens have it: the tag is an id, shown by its display name. */
export interface CalendarSession {
  id: string
  mode: string
  tag: string
  goal: string | null
  startedAt: string
  endedAt: string
  focusSeconds: number
  pausedSeconds: number
  status: 'completed' | 'ended_early'
  /** The Pomodoro configuration's blocks; null for the other modes. */
  blocks: number | null
  blocksCompleted: number
}

const SHORT_DATE = { month: 'short', day: 'numeric' } as const

export interface AddToCalendarProps {
  session: CalendarSession
  /** The user's time zone for the file name and label; the device's by default. */
  timeZone?: string
  /** The clock for the file's DTSTAMP; injectable for tests. */
  now?: () => Date
}

export default function AddToCalendar({
  session,
  timeZone,
  now = () => new Date(),
}: AddToCalendarProps) {
  const { values } = useSettingsState()
  const tagName = useTagsView().info(session.tag).name
  const online = useOnline()
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  const event: CalendarEvent = useMemo(
    () =>
      buildEvent(
        {
          id: session.id,
          mode: session.mode,
          tagName,
          goal: session.goal,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          focusSeconds: session.focusSeconds,
          pausedSeconds: session.pausedSeconds,
          endedEarly: session.status === 'ended_early',
          blocks: session.blocks,
          blocksCompleted: session.blocksCompleted,
        },
        {
          titleTemplate: values.calendar_title_template,
          includeGoal: values.calendar_include_goal,
          includeDescription: values.calendar_include_description,
        },
        window.location.origin,
      ),
    [session, tagName, values],
  )

  useEffect(() => {
    if (open)
      root.current?.querySelector<HTMLElement>('.add-to-calendar-choices :is(a, button)')?.focus()
  }, [open])

  const date = new Intl.DateTimeFormat(undefined, { ...SHORT_DATE, timeZone }).format(
    new Date(session.startedAt),
  )
  const label = `Add to calendar: ${tagName}, ${formatDuration(session.focusSeconds)} on ${date}`

  function close(returnFocus: boolean) {
    setOpen(false)
    if (returnFocus) toggle.current?.focus()
  }

  return (
    <div
      className="add-to-calendar"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          close(true)
        }
      }}
      onBlur={(e) => {
        // Tabbing out of the control closes it, without stealing focus back.
        if (open && !root.current?.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        type="button"
        ref={toggle}
        aria-expanded={open}
        aria-controls={`${id}-choices`}
        aria-label={label}
        onClick={() => setOpen(!open)}
      >
        Add to calendar
      </button>
      {open && (
        <ul id={`${id}-choices`} className="add-to-calendar-choices" aria-label="Add to calendar">
          <li>
            {online ? (
              <a
                className="link-button"
                href={googleCalendarUrl(event)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => close(false)}
              >
                Google Calendar
              </a>
            ) : (
              <>
                <button type="button" aria-disabled="true" aria-describedby={`${id}-offline`}>
                  Google Calendar
                </button>
                <span id={`${id}-offline`} className="field-hint">
                  Needs a connection
                </span>
              </>
            )}
          </li>
          <li>
            <button
              type="button"
              onClick={() => {
                saveIcs(eventsToIcs([event], now()), icsFileName(session.startedAt, timeZone))
                close(true)
              }}
            >
              Apple Calendar / other (.ics)
            </button>
          </li>
        </ul>
      )}
    </div>
  )
}
