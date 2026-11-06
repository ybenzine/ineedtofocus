// "Add to calendar" for one session (F14, AC14.7), on the session summary and each History row.
//
// A button that opens two choices: Google Calendar (a pre-filled page in a new tab, which needs
// a connection) and Apple Calendar / other (a one-event .ics). Off iOS the file is built on the device, so it
// works offline and for unsynced sessions; on iOS it is the server's copy (#454). Signed-in users only:
// the screens that can show a session without an account don't render this.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useSettingsState } from '../settings/SettingsContext.ts'
import { useOnline } from '../sounds/useOnline.ts'
import { useTagsView } from '../tags/context.ts'
import { formatDuration } from '../timerscreen/format.ts'
import { deviceTimeZone } from '../history/api.ts'
import { signedInUserId } from '../auth/localData.ts'
import { icsBlobUrl, isIos, sessionIcsPath } from './download.ts'
import { useIcsProbe } from './useIcsProbe.ts'
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
  /**
   * The server has this session (#454). On iOS the .ics is served by the server, so the choice
   * needs it; other platforms build the file on the device and ignore this.
   */
  synced?: boolean
  /** The clock for the file's DTSTAMP; injectable for tests. */
  now?: () => Date
}

export default function AddToCalendar({
  session,
  timeZone,
  synced = false,
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

  // Other platforms: the .ics is made when the menu opens, so the choice is a plain link the tap
  // activates itself (a window.open after an async step is blocked, #445). It is made again if
  // the event changes while the menu is open, so the file always matches the menu.
  // iOS: a data: or blob: URL can't be opened there (#451 did not work, #454), so the choice is a
  // same-tab link to the server's own copy of the session, which needs an account, a connection
  // and a synced session.
  const ios = isIos()
  const icsName = icsFileName(session.startedAt, timeZone)
  const zone = timeZone ?? deviceTimeZone()
  const signedIn = signedInUserId() !== null
  const icsUrl = useMemo(() => {
    if (!open || ios) return null
    return icsBlobUrl(eventsToIcs([event], now()))
    // `now` only stamps the file; a new function each render must not rebuild it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, event, ios])
  const localHint = !signedIn
    ? 'Sign in first'
    : !online
      ? 'Needs a connection'
      : !synced
        ? 'Not synced yet'
        : null
  // The server must agree before the link is offered (#458): a refusal would leave the installed
  // app on a JSON page with no way back. The link itself stays a plain tap.
  const icsPath = sessionIcsPath(session.id, zone)
  const probe = useIcsProbe(icsPath, open && ios && localHint === null)
  const iosHint =
    localHint ??
    (probe === 'ok'
      ? null
      : probe === 'checking'
        ? 'Checking…'
        : probe === 'unauthorized'
          ? 'Sign in again to add this session'
          : "Can't add this session right now")
  useEffect(() => {
    if (!icsUrl?.startsWith('blob:')) return
    // Freed a while late: the browser may still be reading it after the tap.
    return () => void setTimeout(() => URL.revokeObjectURL(icsUrl), 60_000)
  }, [icsUrl])

  // True from a press inside the control until the next key press, so a blur with no related
  // target can tell a tap (iOS focuses nothing) from Tab leaving the page.
  const pressedInside = useRef(false)

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

  // The disabled choice becomes the link when the probe passes; focus it if the swap dropped focus.
  useEffect(() => {
    if (open && ios && iosHint === null && document.activeElement === document.body)
      root.current?.querySelector<HTMLElement>('a[target="_self"]')?.focus()
  }, [open, ios, iosHint])

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
        pressedInside.current = false
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          close(true)
        }
      }}
      onPointerDown={() => void (pressedInside.current = true)}
      onBlur={(e) => {
        // Tabbing out of the control closes it, without stealing focus back. A null
        // relatedTarget is a tap on iOS (which focuses nothing, and pressed inside first) or
        // Tab moving focus out of the page (no press): only the second closes.
        const next = e.relatedTarget as Node | null
        if (!open) return
        if (next ? !root.current?.contains(next) : !pressedInside.current) setOpen(false)
      }}
    >
      <button
        type="button"
        ref={toggle}
        aria-expanded={open}
        aria-controls={`${id}-choices`}
        aria-label={label}
        onClick={() => {
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
            {ios && iosHint ? (
              <>
                <button type="button" aria-disabled="true" aria-describedby={`${id}-ics-hint`}>
                  Apple Calendar / other (.ics)
                </button>
                <span id={`${id}-ics-hint`} className="field-hint" role="status">
                  {iosHint}
                </span>
              </>
            ) : (
              <a
                className="link-button"
                href={ios ? icsPath : (icsUrl ?? undefined)}
                {...(ios ? { target: '_self' } : { download: icsName })}
                onClick={() => closeAfterNavigation(true)}
              >
                Apple Calendar / other (.ics)
              </a>
            )}
          </li>
        </ul>
      )}
    </div>
  )
}
