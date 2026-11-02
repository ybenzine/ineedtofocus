// Settings → Calendar (F14, AC12.8, AC14.4): the calendar settings with a live preview, the
// tags to include, and the private subscription link.
//
// Signed-in users only: without an account the section is just a nudge to sign up or log in.
// Nothing calendar-related is kept on a guest's device.
//
// Privacy (AC14.4, AC14.8): the link's secret lives only in this component's state while it is
// shown. It is never written to localStorage, the settings cache, logs or telemetry.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAnonymous } from '../anonymous/AnonymousContext.ts'
import { AuthLink } from '../anonymous/AuthLink.tsx'
import { signedInUserId } from '../auth/localData.ts'
import { CALENDAR_MIN_MINUTES, type CalendarMinMinutes } from '../settings/api.ts'
import { useSettingsState, useSettingsStore } from '../settings/SettingsContext.ts'
import { useOnline } from '../sounds/useOnline.ts'
import type { SessionStore } from '../sync/sessionStore.ts'
import { useTagsView } from '../tags/context.ts'
import { TagDot } from '../tags/TagName.tsx'
import { HttpCalendarApi, type CalendarApi, type FeedStatus } from './api.ts'
import type { CalendarSession } from './AddToCalendar.tsx'
import { buildEvent, type CalendarEvent } from './event.ts'
import { relativeTime, subscribeLinks } from './links.ts'
import { recordToCalendarSession } from './session.ts'

const GUEST_NUDGE = 'to add your sessions to your calendar.'
const TITLE_MAX = 120
const NAME_MAX = 60
const PLACEHOLDERS = ['{tag}', '{goal}', '{mode}', '{focus_time}']

const defaultApi = new HttpCalendarApi()
const chars = (text: string): number => Array.from(text).length

/** What the preview shows when the user has no session yet. */
function sampleSession(now: number): CalendarSession {
  const end = now - 3_600_000
  return {
    id: '00000000-0000-4000-8000-000000000000',
    mode: 'countdown',
    tag: 'work',
    goal: 'Write chapter 3',
    startedAt: new Date(end - 25 * 60_000).toISOString(),
    endedAt: new Date(end).toISOString(),
    focusSeconds: 25 * 60,
    pausedSeconds: 0,
    status: 'completed',
    blocks: null,
    blocksCompleted: 0,
  }
}

type Feed =
  { kind: 'loading' } | { kind: 'ready'; status: FeedStatus } | { kind: 'error'; message: string }

export interface CalendarSectionProps {
  api?: CalendarApi
  /** The device's sessions, for the preview's latest session; a sample is used without it. */
  sessions?: SessionStore | null
  now?: () => number
}

export default function CalendarSection(props: CalendarSectionProps) {
  const anonymous = useAnonymous() !== null
  const id = useId()
  if (anonymous) {
    return (
      <div role="region" className="calendar-section" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`}>Calendar</h2>
        <p className="field-hint">
          <AuthLink form="signup" origin="screen">
            Create an account
          </AuthLink>{' '}
          or{' '}
          <AuthLink form="signin" origin="screen">
            log in
          </AuthLink>{' '}
          {GUEST_NUDGE}
        </p>
      </div>
    )
  }
  return <AccountCalendar {...props} />
}

function AccountCalendar({
  api = defaultApi,
  sessions = null,
  now = Date.now,
}: CalendarSectionProps) {
  const store = useSettingsStore()
  const { values } = useSettingsState()
  const tagsView = useTagsView()
  const id = useId()

  const [templateDraft, setTemplateDraft] = useState(values.calendar_title_template)
  const [nameDraft, setNameDraft] = useState(values.calendar_name)
  const templateError =
    chars(templateDraft) > TITLE_MAX ? `The title can have at most ${TITLE_MAX} characters.` : null
  const trimmedName = nameDraft.trim()
  const nameError =
    chars(trimmedName) < 1
      ? 'Give the calendar a name.'
      : chars(trimmedName) > NAME_MAX
        ? `The name can have at most ${NAME_MAX} characters.`
        : null

  // A change from elsewhere (sync, another tab) replaces the draft; the user's own edit doesn't.
  const lastTemplate = useRef(values.calendar_title_template)
  useEffect(() => {
    if (values.calendar_title_template !== lastTemplate.current) {
      lastTemplate.current = values.calendar_title_template
      setTemplateDraft(values.calendar_title_template)
    }
  }, [values.calendar_title_template])
  const lastName = useRef(values.calendar_name)
  useEffect(() => {
    if (values.calendar_name !== lastName.current) {
      lastName.current = values.calendar_name
      setNameDraft(values.calendar_name)
    }
  }, [values.calendar_name])

  // The preview's session: the user's latest, or a sample.
  const [latest, setLatest] = useState<CalendarSession | null>(null)
  useEffect(() => {
    const owner = signedInUserId()
    if (!sessions || owner === null) return
    let cancelled = false
    void sessions
      .list(owner)
      .then((all) => {
        if (cancelled) return
        const newest = all
          .filter((d) => d.archivedAt === null && !d.goneOnServer)
          .sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt))[0]
        setLatest(newest ? recordToCalendarSession(newest.record) : null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessions])
  const sample = useMemo(() => sampleSession(now()), [now])
  const previewSession = latest ?? sample
  const preview: CalendarEvent = useMemo(
    () =>
      buildEvent(
        {
          id: previewSession.id,
          mode: previewSession.mode,
          tagName: tagsView.info(previewSession.tag).name,
          goal: previewSession.goal,
          startedAt: previewSession.startedAt,
          endedAt: previewSession.endedAt,
          focusSeconds: previewSession.focusSeconds,
          pausedSeconds: previewSession.pausedSeconds,
          endedEarly: previewSession.status === 'ended_early',
          blocks: previewSession.blocks,
          blocksCompleted: previewSession.blocksCompleted,
        },
        {
          titleTemplate: templateError ? values.calendar_title_template : templateDraft,
          includeGoal: values.calendar_include_goal,
          includeDescription: values.calendar_include_description,
        },
        window.location.origin,
      ),
    [previewSession, tagsView, templateDraft, templateError, values],
  )

  const excluded = values.calendar_excluded_tags
  const everyTagOut = tagsView.all.every((t) => excluded.includes(t.id))

  function toggleTag(tag: string, included: boolean) {
    const next = included
      ? excluded.filter((t) => t !== tag)
      : excluded.includes(tag)
        ? excluded
        : [...excluded, tag]
    store.update({ calendar_excluded_tags: next })
  }

  return (
    <div role="region" className="calendar-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Calendar</h2>

      <div className="field">
        <label htmlFor={`${id}-template`}>Event title</label>
        <input
          id={`${id}-template`}
          type="text"
          value={templateDraft}
          aria-invalid={templateError !== null}
          aria-describedby={`${id}-template-hint${templateError ? ` ${id}-template-error` : ''}`}
          onChange={(event) => {
            const text = event.target.value
            setTemplateDraft(text)
            if (chars(text) <= TITLE_MAX) {
              lastTemplate.current = text
              store.update({ calendar_title_template: text })
            }
          }}
        />
        <p id={`${id}-template-hint`} className="field-hint">
          Placeholders: {PLACEHOLDERS.join(', ')}.
        </p>
        {templateError && (
          <p id={`${id}-template-error`} role="alert" className="field-error">
            {templateError}
          </p>
        )}
        <div className="calendar-preview" role="group" aria-label="Preview of an event">
          <p className="field-hint">
            Preview, from {latest ? 'your latest session' : 'a sample session'}:
          </p>
          <p className="calendar-preview-title">{preview.summary}</p>
          {preview.description !== null && (
            <p className="calendar-preview-description">{preview.description}</p>
          )}
        </div>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={values.calendar_include_goal}
            onChange={(event) => store.update({ calendar_include_goal: event.target.checked })}
          />{' '}
          Include goals
        </label>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={values.calendar_include_description}
            onChange={(event) =>
              store.update({ calendar_include_description: event.target.checked })
            }
          />{' '}
          Include description
        </label>
      </div>

      <fieldset className="field">
        <legend>Tags in the calendar</legend>
        <div className="calendar-tags">
          {tagsView.all.map((tag) => (
            <label key={tag.id} className="choice">
              <input
                type="checkbox"
                checked={!excluded.includes(tag.id)}
                onChange={(event) => toggleTag(tag.id, event.target.checked)}
              />
              <TagDot color={tag.color} />
              <span className="tag-name-text">
                {tag.removed ? `${tag.name} (removed)` : tag.name}
              </span>
            </label>
          ))}
        </div>
        <p className="field-hint">
          Applies to the subscription link. A tag you add later is included.
        </p>
        <p role="status" className="field-hint">
          {everyTagOut ? 'No tags are selected, so your calendar stays empty.' : ''}
        </p>
      </fieldset>

      <div className="field">
        <label htmlFor={`${id}-min`}>Minimum length</label>
        <select
          id={`${id}-min`}
          value={values.calendar_min_minutes}
          onChange={(event) =>
            store.update({ calendar_min_minutes: Number(event.target.value) as CalendarMinMinutes })
          }
        >
          {CALENDAR_MIN_MINUTES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 0 ? 'None' : `${minutes} min`}
            </option>
          ))}
        </select>
        <p className="field-hint">
          Shorter sessions are left out of the subscription link and the History download.
        </p>
      </div>

      <div className="field">
        <label htmlFor={`${id}-name`}>Calendar name</label>
        <input
          id={`${id}-name`}
          type="text"
          value={nameDraft}
          aria-invalid={nameError !== null}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
          onChange={(event) => {
            const text = event.target.value
            setNameDraft(text)
            const trimmed = text.trim()
            if (chars(trimmed) >= 1 && chars(trimmed) <= NAME_MAX) {
              lastName.current = trimmed
              store.update({ calendar_name: trimmed })
            }
          }}
        />
        {nameError && (
          <p id={`${id}-name-error`} role="alert" className="field-error">
            {nameError}
          </p>
        )}
      </div>

      <Subscribe api={api} includeGoal={values.calendar_include_goal} now={now} />
    </div>
  )
}

function Subscribe({
  api,
  includeGoal,
  now,
}: {
  api: CalendarApi
  includeGoal: boolean
  now: () => number
}) {
  const id = useId()
  const online = useOnline()
  const [feed, setFeed] = useState<Feed>({ kind: 'loading' })
  // The secret path, shown once. Component state only: never stored anywhere.
  const [shown, setShown] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'reset' | 'off' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const [attempt, setAttempt] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const resetButton = useRef<HTMLButtonElement>(null)
  const offButton = useRef<HTMLButtonElement>(null)
  // Which button to give focus back to when a confirmation closes without acting.
  const returnTo = useRef<'reset' | 'off' | null>(null)

  const ready = feed.kind === 'ready'
  // The status loads when there is a connection and it isn't known yet; it reloads when the
  // connection returns or on Retry. Offline, nothing is requested.
  useEffect(() => {
    if (ready || !online) return
    let cancelled = false
    void api.feedStatus().then((result) => {
      if (cancelled) return
      if (result.kind === 'ok') setFeed({ kind: 'ready', status: result.value })
      else setFeed({ kind: 'error', message: 'Couldn’t load your calendar link.' })
    })
    return () => {
      cancelled = true
    }
  }, [api, online, ready, attempt])

  useEffect(() => {
    if (confirm) cancel.current?.focus()
    else if (returnTo.current) {
      ;(returnTo.current === 'reset' ? resetButton : offButton).current?.focus()
      returnTo.current = null
    }
  }, [confirm])
  // A failed reset hands focus back once the buttons are enabled again.
  useEffect(() => {
    if (!busy && returnTo.current && confirm === null) {
      ;(returnTo.current === 'reset' ? resetButton : offButton).current?.focus()
      returnTo.current = null
    }
  }, [busy, confirm])

  // The new link is announced by moving focus to its field (AC4).
  useEffect(() => {
    if (shown) field.current?.focus()
  }, [shown])

  function closeConfirm() {
    returnTo.current = confirm
    setConfirm(null)
  }

  const status = feed.kind === 'ready' ? feed.status : null

  async function create() {
    setBusy(true)
    setError('')
    setCopied('')
    const result = await api.createFeed()
    setBusy(false)
    if (result.kind !== 'ok') {
      setError('Couldn’t create the link. Try again.')
      return false
    }
    setShown(result.value.path)
    setFeed({
      kind: 'ready',
      status: { enabled: true, createdAt: result.value.createdAt, lastFetchedAt: null },
    })
    return true
  }

  async function remove() {
    setBusy(true)
    setError('')
    setCopied('')
    const result = await api.deleteFeed()
    setBusy(false)
    if (result.kind !== 'ok') {
      setError('Couldn’t turn off the link. Try again.')
      return false
    }
    setShown(null)
    setFeed({ kind: 'ready', status: { enabled: false, createdAt: null, lastFetchedAt: null } })
    return true
  }

  /** One `POST` replaces the link atomically: on failure the old one still works. */
  async function reset() {
    setConfirm(null)
    setBusy(true)
    setError('')
    setCopied('')
    const result = await api.createFeed()
    setBusy(false)
    if (result.kind !== 'ok') {
      setError('Couldn’t reset the link. The old one still works. Try again.')
      returnTo.current = 'reset'
      return
    }
    setShown(result.value.path)
    setFeed({
      kind: 'ready',
      status: { enabled: true, createdAt: result.value.createdAt, lastFetchedAt: null },
    })
  }

  async function turnOff() {
    setConfirm(null)
    await remove()
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied('Link copied.')
    } catch {
      field.current?.select()
      setCopied('Couldn’t copy. The link is selected: copy it now.')
    }
  }

  const links = shown ? subscribeLinks(shown, window.location.origin) : null
  const needsConnection = !online
  const hint = needsConnection ? (
    <span id={`${id}-offline`} className="field-hint">
      Needs a connection.
    </span>
  ) : null
  const offlineProps = {
    disabled: needsConnection || busy,
    'aria-describedby': needsConnection ? `${id}-offline` : undefined,
  }

  return (
    <div className="calendar-subscribe">
      <h3>Subscribe in your calendar app</h3>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      {feed.kind === 'loading' && online && <p role="status">Loading…</p>}
      {feed.kind === 'error' && online && (
        <>
          <p role="status">{feed.message}</p>
          <button
            type="button"
            onClick={() => {
              setFeed({ kind: 'loading' })
              setAttempt((n) => n + 1)
            }}
            disabled={needsConnection}
          >
            Retry
          </button>
        </>
      )}

      {!ready && needsConnection && (
        <>
          <button type="button" className="primary" {...offlineProps}>
            Create link
          </button>
          {hint}
        </>
      )}

      {status && !status.enabled && (
        <>
          <p className="field-hint">
            A private link your calendar app reads, so your sessions show up as their own calendar.
          </p>
          <button type="button" className="primary" onClick={() => void create()} {...offlineProps}>
            Create link
          </button>
          {hint}
        </>
      )}

      {status?.enabled && links && (
        <div className="calendar-link">
          <label htmlFor={`${id}-link`}>Subscription link</label>
          <input id={`${id}-link`} ref={field} type="text" readOnly value={links.https} />
          <div className="calendar-link-actions">
            <button type="button" onClick={() => void copy(links.https)}>
              Copy link
            </button>
            <a className="link-button" href={links.webcal}>
              Add to Apple Calendar
            </a>
            <a
              className="link-button"
              href={links.google}
              target="_blank"
              rel="noopener noreferrer"
            >
              Add to Google Calendar
            </a>
          </div>
          <p role="status" className="field-hint">
            {copied}
          </p>
          <p className="field-hint">
            This link is shown only now. Anyone with it can see your sessions
            {includeGoal ? ', including goals' : ''}. Reset it if it’s shared by mistake.
          </p>
        </div>
      )}

      {status?.enabled && !links && (
        <p role="status">
          Subscribed · last checked by your calendar app{' '}
          {status.lastFetchedAt ? relativeTime(status.lastFetchedAt, now()) : 'not yet'}
        </p>
      )}

      {status?.enabled && (
        <>
          {confirm === null ? (
            <div className="calendar-link-actions">
              <button
                type="button"
                ref={resetButton}
                onClick={() => setConfirm('reset')}
                {...offlineProps}
              >
                Reset link
              </button>
              <button
                type="button"
                ref={offButton}
                onClick={() => setConfirm('off')}
                {...offlineProps}
              >
                Turn off
              </button>
              {hint}
            </div>
          ) : (
            <div
              role="alertdialog"
              aria-label={confirm === 'reset' ? 'Reset the link' : 'Turn off the link'}
              className="archive-confirm"
              onKeyDown={(event) => {
                if (event.key === 'Escape') closeConfirm()
              }}
            >
              <p>
                {confirm === 'reset'
                  ? 'Reset the link? The old one stops working at once, and you add the new one in your calendar app.'
                  : 'Turn off the link? Calendar apps using it stop receiving your sessions.'}
              </p>
              <button type="button" ref={cancel} onClick={closeConfirm}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy || needsConnection}
                onClick={() => void (confirm === 'reset' ? reset() : turnOff())}
              >
                {confirm === 'reset' ? 'Reset link' : 'Turn off'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
