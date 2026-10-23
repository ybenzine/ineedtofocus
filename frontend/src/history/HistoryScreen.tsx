// History (F10): focus time by day, week, month, all time or a custom range.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { notifySessionExpired, signedInUserId } from '../auth/localData.ts'
import type { SessionStore } from '../sync/sessionStore.ts'
import { TAGS, type Tag } from '../timer/config.ts'
import { formatDuration } from '../timerscreen/format.ts'
import {
  deviceTimeZone,
  historyQueryString,
  HttpHistoryApi,
  type HistoryApi,
  type HistoryData,
  type HistoryQuery,
  type HistorySession,
  type HistoryView,
} from './api.ts'
import {
  bucketLabel,
  bucketTitle,
  emptyData,
  formatDate,
  formatTime,
  localDate,
  mergeSessions,
  periodFor,
  periodLabel,
  shiftAnchor,
  type Period,
} from './model.ts'

export interface HistoryScreenProps {
  api?: HistoryApi
  /** The device's session store; without it only the server's sessions are shown. */
  sessions?: SessionStore | null
  /** Whose sessions to show from the device. Nobody known: none (never another account's). */
  ownerId?: string | null
  timeZone?: string
  now?: () => number
  onNewSession?: () => void
}

const VIEWS: { id: HistoryView; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
]

const defaultApi = new HttpHistoryApi()

type Load =
  { kind: 'loading' } | { kind: 'ready'; data: HistoryData; offline: boolean } | { kind: 'error' }

const STATUS_LABEL = { completed: 'Completed', ended_early: 'Ended early' } as const
const MODE_LABEL = { countdown: 'Countdown', pomodoro: 'Pomodoro', unlimited: 'Unlimited' } as const

export default function HistoryScreen({
  api = defaultApi,
  sessions = null,
  ownerId,
  timeZone,
  now = Date.now,
  onNewSession,
}: HistoryScreenProps) {
  const tz = useMemo(() => timeZone ?? deviceTimeZone(), [timeZone])
  const owner = ownerId === undefined ? signedInUserId() : ownerId
  const today = localDate(new Date(now()).toISOString(), tz)

  const [view, setView] = useState<HistoryView>('day')
  const [anchor, setAnchor] = useState(today)
  const [tags, setTags] = useState<Tag[]>([])
  const [custom, setCustom] = useState<Period | null>(null)
  const [draft, setDraft] = useState({ start: today, end: today })
  const [formError, setFormError] = useState('')
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const cache = useRef(new Map<string, HistoryData>())
  const weekStart = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => heading.current?.focus(), [])
  useEffect(() => {
    const onOnline = () => setReload((n) => n + 1)
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  const needsRange = view === 'custom' && custom === null
  const query = useMemo<HistoryQuery>(
    () => ({
      view,
      tz,
      tags,
      ...(view === 'custom' ? { start: custom?.start, end: custom?.end } : { date: anchor }),
    }),
    [view, tz, tags, custom, anchor],
  )
  const queryKey = historyQueryString(query)

  useEffect(() => {
    if (needsRange) return
    let cancelled = false
    void (async () => {
      setLoad({ kind: 'loading' })
      const [result, local] = await Promise.all([
        api.get(query),
        (owner !== null && sessions ? sessions.list(owner) : Promise.resolve([])).catch(() => []),
      ])
      if (cancelled) return
      const device = local.map((d) => ({
        session: {
          id: d.record.id,
          mode: d.record.mode,
          tag: d.record.tag,
          goal: d.record.goal,
          startedAt: d.record.startedAt,
          focusSeconds: d.record.focusSeconds,
          status: d.record.status,
          indicator: d.indicator,
          unsaved: d.syncState !== 'synced',
        } satisfies HistorySession,
        archived: d.archivedAt !== null,
        // Selected by upload state, not by the badge: a synced session with a queued edit also
        // shows a badge, but the server already has it.
        notUploaded: d.syncState !== 'synced',
      }))
      const alive = device.filter((d) => !d.archived)
      const unsynced = alive.filter((d) => d.notUploaded).map((d) => d.session)
      if (result.kind === 'ok') {
        weekStart.current = result.value.weekStartDay
        cache.current.set(queryKey, result.value)
        setLoad({
          kind: 'ready',
          data: mergeSessions(result.value, unsynced, query.tags),
          offline: false,
        })
        return
      }
      if (result.kind === 'invalid') {
        setLoad({ kind: 'error' })
        return
      }
      if (result.kind === 'unauthorized') notifySessionExpired()
      // Offline or the server is down: the last answer for this view plus what is on the
      // device, or, with no earlier answer, the view built from the device's own sessions.
      const cached = cache.current.get(queryKey)
      const period = periodOf(query, weekStart.current)
      const base = cached ?? emptyData(query.view, tz, weekStart.current, period)
      // Everything on the device that isn't archived (merging de-duplicates by id), so a session
      // that synced after the cached answer was fetched isn't lost.
      const extra = alive.map((d) => d.session)
      setLoad({ kind: 'ready', data: mergeSessions(base, extra, query.tags), offline: true })
    })()
    return () => {
      cancelled = true
    }
  }, [api, sessions, owner, query, queryKey, tz, needsRange, reload])

  function toggleTag(tag: Tag) {
    setTags((current) =>
      current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag],
    )
  }

  function submitCustom(event: FormEvent) {
    event.preventDefault()
    if (!draft.start || !draft.end) {
      setFormError('Choose a start and an end date.')
    } else if (draft.end < draft.start) {
      setFormError("The end date can't be before the start date.")
    } else {
      setFormError('')
      setCustom({ start: draft.start, end: draft.end })
    }
  }

  const stepper = view === 'day' || view === 'week' || view === 'month' ? view : null
  const data = load.kind === 'ready' ? load.data : null
  const periodEnd = data?.end ?? null

  return (
    <section className="history" aria-labelledby="history-title">
      <h1 id="history-title" ref={heading} tabIndex={-1}>
        History
      </h1>

      <div role="group" aria-label="View" className="history-views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            aria-pressed={view === v.id}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === 'custom' && (
        <form className="history-range" onSubmit={submitCustom} noValidate>
          <label>
            Start date
            <input
              type="date"
              value={draft.start}
              onChange={(e) => setDraft({ ...draft, start: e.target.value })}
            />
          </label>
          <label>
            End date
            <input
              type="date"
              value={draft.end}
              onChange={(e) => setDraft({ ...draft, end: e.target.value })}
            />
          </label>
          <button type="submit" className="primary">
            Show
          </button>
          {formError && (
            <p role="alert" className="field-error">
              {formError}
            </p>
          )}
        </form>
      )}

      <div role="group" aria-label="Tags" className="history-tags">
        <button type="button" aria-pressed={tags.length === 0} onClick={() => setTags([])}>
          All tags
        </button>
        {TAGS.map((tag) => (
          <button
            key={tag}
            type="button"
            aria-pressed={tags.includes(tag)}
            onClick={() => toggleTag(tag)}
          >
            {tag}
          </button>
        ))}
      </div>

      {stepper && (
        <div className="history-stepper">
          <button type="button" onClick={() => setAnchor(shiftAnchor(stepper, anchor, -1))}>
            Previous {stepper}
          </button>
          <p aria-live="polite">{data ? periodLabel(data) : ''}</p>
          <button
            type="button"
            disabled={load.kind === 'loading' || (periodEnd !== null && periodEnd >= today)}
            onClick={() => setAnchor(shiftAnchor(stepper, anchor, 1))}
          >
            Next {stepper}
          </button>
        </div>
      )}
      {!stepper && !needsRange && data && <p className="history-period">{periodLabel(data)}</p>}

      {needsRange ? (
        <p className="field-hint">Choose a start and an end date.</p>
      ) : load.kind === 'loading' ? (
        <p role="status">Loading…</p>
      ) : load.kind === 'error' ? (
        <p role="alert">Couldn’t load history. Check the dates and try again.</p>
      ) : (
        <Results
          data={load.data}
          offline={load.offline}
          filtered={tags.length > 0}
          onNewSession={onNewSession}
        />
      )}
    </section>
  )
}

function periodOf(query: HistoryQuery, weekStartDay: number): Period | null {
  if (query.view === 'all') return null
  if (query.view === 'custom') {
    return query.start && query.end ? { start: query.start, end: query.end } : null
  }
  return periodFor(query.view, query.date ?? '', weekStartDay)
}

function Results({
  data,
  offline,
  filtered,
  onNewSession,
}: {
  data: HistoryData
  offline: boolean
  filtered: boolean
  onNewSession?: () => void
}) {
  const unsynced = data.sessions.filter((s) => s.unsaved).length
  return (
    <>
      {offline && (
        <p role="status" className="history-offline">
          You’re offline or the server can’t be reached. Showing what’s saved on this device;
          sessions from other devices may be missing.
        </p>
      )}
      {data.sessionCount === 0 ? (
        <div className="history-empty">
          <p>
            {filtered
              ? 'No sessions with these tags in this period.'
              : 'No sessions in this period.'}
          </p>
          {onNewSession && (
            <button type="button" className="primary" onClick={onNewSession}>
              Start a session
            </button>
          )}
        </div>
      ) : (
        <>
          <dl className="history-totals">
            <div>
              <dt>Focus time</dt>
              <dd>{formatDuration(data.totalFocusSeconds)}</dd>
            </div>
            <div>
              <dt>Sessions</dt>
              <dd>{data.sessionCount}</dd>
            </div>
          </dl>
          {unsynced > 0 && (
            <p className="field-hint">
              Includes {unsynced} {unsynced === 1 ? 'session' : 'sessions'} not saved to your
              account yet.
            </p>
          )}
          <section aria-labelledby="by-tag">
            <h2 id="by-tag">By tag</h2>
            <ul className="history-tag-list">
              {data.tags.map((t) => (
                <li key={t.tag}>
                  <span className="timer-tag">{t.tag}</span>
                  <span>{formatDuration(t.focusSeconds)}</span>
                </li>
              ))}
            </ul>
          </section>
          {data.view !== 'day' && <Chart data={data} />}
          <section aria-labelledby="session-list">
            <h2 id="session-list">Sessions</h2>
            <ul className="history-list">
              {data.sessions.map((s) => (
                <SessionRow key={s.id} session={s} timeZone={data.timeZone} />
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  )
}

function Chart({ data }: { data: HistoryData }) {
  const max = Math.max(1, ...data.buckets.map((b) => b.focusSeconds))
  const step = Math.max(1, Math.ceil(data.buckets.length / 8))
  return (
    <section aria-labelledby="chart-title">
      <h2 id="chart-title">
        {data.bucket === 'month' ? 'Focus time by month' : 'Focus time by day'}
      </h2>
      <ol className="history-chart" aria-labelledby="chart-title" data-bucket={data.bucket}>
        {data.buckets.map((b, i) => (
          <li key={b.date}>
            <span className="bar-track">
              <span
                className="bar"
                style={{ height: `${Math.round((b.focusSeconds / max) * 100)}%` }}
              />
            </span>
            <span className="bar-label" aria-hidden="true">
              {i % step === 0 ? bucketLabel(b, data) : ''}
            </span>
            <span className="sr-only">
              {bucketTitle(b, data.bucket)}: {formatDuration(b.focusSeconds)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function SessionRow({ session, timeZone }: { session: HistorySession; timeZone: string }) {
  return (
    <li className="history-row">
      <p className="history-row-when">
        <span>{formatDate(session.startedAt, timeZone)}</span>{' '}
        <span>{formatTime(session.startedAt, timeZone)}</span>
      </p>
      <p className="history-row-main">
        <span>{MODE_LABEL[session.mode]}</span>
        <span className="timer-tag">{session.tag}</span>
        <span>{formatDuration(session.focusSeconds)}</span>
        <span>{STATUS_LABEL[session.status]}</span>
      </p>
      {session.goal && <p className="history-row-goal">{session.goal}</p>}
      {session.indicator === 'not-synced-yet' && <p className="history-badge">Not synced yet</p>}
      {session.indicator === 'couldnt-sync' && (
        <p className="history-badge history-badge-error">Couldn’t sync</p>
      )}
    </li>
  )
}
