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
import { icsBlobUrl, isIos } from './download.ts'
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

  // The .ics is made when the menu opens, so the choice is a plain link the tap activates itself:
  // iOS Safari blocks a window.open after any async step and only shows the Calendar sheet for
  // a navigation the user started (#445).
  const [icsUrl, setIcsUrl] = useState<string | null>(null)
  const icsName = icsFileName(session.startedAt, timeZone)
  useEffect(() => {
    if (!icsUrl) return
    // Replaced on the next open and freed on unmount, a while late: the browser may still be
    // reading it after the tap.
    return () => void setTimeout(() => URL.revokeObjectURL(icsUrl), 60_000)
  }, [icsUrl])

  // A tap or click outside closes the menu. This replaces closing on blur: iOS Safari does not
  // focus a tapped button or link, so the blur (relatedTarget null) fires before the click and
  // used to remove the choice before it was activated.
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node | null)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  useEffect(() => {
    if (open)
      root.current?.querySelector<HTMLElement>('.add-to-calendar-choices :is(a, button)')?.focus()
  }, [open])

  const date = new Intl.DateTimeFormat(undefined, { ...SHORT_DATE, timeZone }).format(
    new Date(session.startedAt),
  )
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(session.startedAt))
  const label = `Add to calendar: ${tagName}, ${formatDuration(session.focusSeconds)} on ${date} at ${time}`

  function close(returnFocus: boolean) {
    setOpen(false)
    if (returnFocus) toggle.current?.focus()
  }

  /** Closes once the link's own navigation or download has started: unmounting it first could cancel it. */
  function closeAfterNavigation(returnFocus: boolean) {
    setTimeout(() => close(returnFocus), 0)
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
        // Tabbing out of the control closes it, without stealing focus back. A null
        // relatedTarget (a tap on iOS, which focuses nothing) is not tabbing out.
        const next = e.relatedTarget as Node | null
        if (open && next && !root.current?.contains(next)) setOpen(false)
      }}
    >
      <button
        type="button"
        ref={toggle}
        aria-expanded={open}
        aria-controls={`${id}-choices`}
        aria-label={label}
        onClick={() => {
          if (!open) setIcsUrl(icsBlobUrl(eventsToIcs([event], now())))
          setOpen(!open)
        }}
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
                onClick={() => closeAfterNavigation(false)}
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
            <a
              className="link-button"
              href={icsUrl ?? undefined}
              {...(isIos() ? { target: '_blank', rel: 'noopener' } : { download: icsName })}
              onClick={() => closeAfterNavigation(true)}
            >
              Apple Calendar / other (.ics)
            </a>
          </li>
        </ul>
      )}
    </div>
  )
}
