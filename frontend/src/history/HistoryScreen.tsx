// History (F10): focus time by day, week, month, all time or a custom range.

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { notifySessionExpired, signedInUserId } from '../auth/localData.ts'
import { HttpArchiveApi, type ArchiveApi } from '../archive/api.ts'
import { useSettingsState } from '../settings/SettingsContext.ts'
import { GOAL_MAX_LENGTH } from '../setup/options.ts'
import { HttpSessionsApi, type SessionEdit, type SessionsApi } from '../sync/api.ts'
import type { SessionStore } from '../sync/sessionStore.ts'
import type { SyncEngine } from '../sync/syncEngine.ts'
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
  applyChanges,
  bucketLabel,
  bucketTitle,
  emptyData,
  formatDate,
  formatTime,
  localDate,
  mergeSessions,
  oneLine,
  periodFor,
  periodLabel,
  removeSessions,
  shiftAnchor,
  type Period,
  type SessionChange,
} from './model.ts'

export interface HistoryScreenProps {
  api?: HistoryApi
  /** The device's session store; without it only the server's sessions are shown. */
  sessions?: SessionStore | null
  /** Whose sessions to show from the device. Nobody known: none (never another account's). */
  ownerId?: string | null
  /** Sends queued edits as soon as they are made (AC11.1); they also go on the usual triggers. */
  sync?: SyncEngine | null
  /** Edit for a session only the server has (AC11.1). */
  sessionsApi?: Pick<SessionsApi, 'edit'>
  /** Archive and restore (AC11.2). */
  archiveApi?: ArchiveApi
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
const defaultSessionsApi = new HttpSessionsApi()
const defaultArchiveApi = new HttpArchiveApi()

type Load =
  { kind: 'loading' } | { kind: 'ready'; data: HistoryData; offline: boolean } | { kind: 'error' }

const STATUS_LABEL = { completed: 'Completed', ended_early: 'Ended early' } as const
const MODE_LABEL = { countdown: 'Countdown', pomodoro: 'Pomodoro', unlimited: 'Unlimited' } as const

export default function HistoryScreen({
  api = defaultApi,
  sessions = null,
  ownerId,
  sync = null,
  sessionsApi = defaultSessionsApi,
  archiveApi = defaultArchiveApi,
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
  // The offline fallback's week start: the settings copy (cached on the device).
  const { values } = useSettingsState()
  const weekStart = values.week_start_day
  const heading = useRef<HTMLHeadingElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [undo, setUndo] = useState<string | null>(null)
  const [problem, setProblem] = useState('')
  const undoButton = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)

  useEffect(() => heading.current?.focus(), [])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (undo !== null) undoButton.current?.focus()
  }, [undo])
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
      const archivedIds = new Set(device.filter((d) => d.archived).map((d) => d.session.id))
      // Changes the server hasn't confirmed yet: shown now (AC11.1), with their sync badge.
      const changes = new Map<string, SessionChange>()
      for (const d of local) {
        if (d.editState !== null && d.edit !== null && d.archivedAt === null) {
          changes.set(d.record.id, { ...d.edit, indicator: d.indicator })
        }
      }
      const unsynced = alive.filter((d) => d.notUploaded).map((d) => d.session)
      if (result.kind === 'ok') {
        cache.current.set(queryKey, result.value)
        setLoad({
          kind: 'ready',
          data: applyChanges(mergeSessions(result.value, unsynced, query.tags), changes),
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
      const period = periodOf(query, weekStart)
      // Sessions archived here since that answer are left out of it (AC11.2).
      const base = removeSessions(
        cached ?? emptyData(query.view, tz, weekStart, period),
        archivedIds,
      )
      // Everything on the device that isn't archived (merging de-duplicates by id), so a session
      // that synced after the cached answer was fetched isn't lost.
      const extra = alive.map((d) => d.session)
      setLoad({
        kind: 'ready',
        data: applyChanges(mergeSessions(base, extra, query.tags), changes),
        offline: true,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [api, sessions, owner, query, queryKey, tz, needsRange, reload, weekStart])

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

  function fail(kind: string, action: string) {
    if (kind === 'unauthorized') notifySessionExpired()
    setProblem(`Couldn’t ${action}. Check your connection and try again.`)
  }

  /**
   * AC11.1: a session on this device is edited on the device first and sent as soon as it can
   * be; one only the server has (finished on another device) is edited online.
   */
  async function saveEdit(session: HistorySession, change: SessionEdit) {
    setProblem('')
    const onDevice =
      owner !== null && sessions ? (await sessions.get(session.id))?.ownerId === owner : false
    if (owner !== null && sessions && onDevice) {
      await sessions.edit(owner, session.id, change)
      setEditingId(null)
      setReload((n) => n + 1)
      void sync?.syncNow().then(() => {
        if (mounted.current) setReload((n) => n + 1)
      })
      return
    }
    const result = await sessionsApi.edit(session.id, change)
    if (result.kind === 'ok') {
      setEditingId(null)
      cache.current.clear()
      setReload((n) => n + 1)
    } else if (result.kind === 'conflict') {
      setProblem('This session was archived on another device, so it can’t be edited.')
      setEditingId(null)
      cache.current.clear()
      setReload((n) => n + 1)
    } else {
      fail(result.kind, 'save the change')
    }
  }

  /** AC11.2: gone at once, with Undo; put back if the server doesn't confirm it. */
  async function archive(session: HistorySession) {
    if (load.kind !== 'ready') return
    setProblem('')
    setUndo(null)
    setEditingId(null)
    const previous = load
    const gone = new Set([session.id])
    setLoad({ ...previous, data: removeSessions(previous.data, gone) })
    for (const [key, data] of cache.current) cache.current.set(key, removeSessions(data, gone))
    // A queued edit goes first, so restoring later brings the session back as the user left it.
    if (owner !== null && (await sessions?.get(session.id))?.editState === 'pending') {
      await sync?.syncNow()
    }
    const result = await archiveApi.archive(session.id)
    if (!mounted.current) return
    if (result.kind !== 'ok') {
      setLoad(previous)
      cache.current.clear()
      fail(result.kind, 'archive the session')
      return
    }
    if (owner !== null) {
      await sessions?.setArchived(owner, session.id, result.value).catch(() => undefined)
    }
    setUndo(session.id)
  }

  async function undoArchive() {
    if (undo === null) return
    setProblem('')
    const result = await archiveApi.restore(undo)
    if (!mounted.current) return
    if (result.kind !== 'ok') return fail(result.kind, 'undo the archive')
    if (owner !== null) await sessions?.setArchived(owner, undo, null).catch(() => undefined)
    setUndo(null)
    cache.current.clear()
    setReload((n) => n + 1)
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

      <div role="status" className="history-undo">
        {undo !== null && (
          <>
            <span>Session archived.</span>{' '}
            <button type="button" ref={undoButton} onClick={() => void undoArchive()}>
              Undo
            </button>
          </>
        )}
      </div>
      {problem && <p role="alert">{problem}</p>}

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
          editingId={editingId}
          onEdit={setEditingId}
          onSave={saveEdit}
          onArchive={archive}
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
  editingId,
  onEdit,
  onSave,
  onArchive,
}: {
  data: HistoryData
  offline: boolean
  filtered: boolean
  onNewSession?: () => void
  editingId: string | null
  onEdit: (id: string | null) => void
  onSave: (session: HistorySession, change: SessionEdit) => Promise<void>
  onArchive: (session: HistorySession) => Promise<void>
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
                <SessionRow
                  key={s.id}
                  session={s}
                  timeZone={data.timeZone}
                  editing={editingId === s.id}
                  onEdit={() => onEdit(s.id)}
                  onCancel={() => onEdit(null)}
                  onSave={(change) => onSave(s, change)}
                  onArchive={() => void onArchive(s)}
                />
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

interface SessionRowProps {
  session: HistorySession
  timeZone: string
  editing: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: (change: SessionEdit) => Promise<void>
  onArchive: () => void
}

function SessionRow({
  session,
  timeZone,
  editing,
  onEdit,
  onCancel,
  onSave,
  onArchive,
}: SessionRowProps) {
  const label = `${formatDate(session.startedAt, timeZone)} ${formatTime(session.startedAt, timeZone)}`
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
      {editing ? (
        <EditForm session={session} label={label} onCancel={onCancel} onSave={onSave} />
      ) : (
        <div className="history-row-actions">
          <button type="button" aria-label={`Edit session from ${label}`} onClick={onEdit}>
            Edit
          </button>
          {session.unsaved ? (
            <span className="field-hint">Can be archived once it has synced.</span>
          ) : (
            <button type="button" aria-label={`Archive session from ${label}`} onClick={onArchive}>
              Archive
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function EditForm({
  session,
  label,
  onCancel,
  onSave,
}: {
  session: HistorySession
  label: string
  onCancel: () => void
  onSave: (change: SessionEdit) => Promise<void>
}) {
  const id = useId()
  const [tag, setTag] = useState<Tag>(session.tag)
  const [goal, setGoal] = useState(session.goal ?? '')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLSelectElement>(null)
  useEffect(() => first.current?.focus(), [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const nextGoal = oneLine(goal).trim() === '' ? null : oneLine(goal).trim()
    const change: SessionEdit = {}
    if (tag !== session.tag) change.tag = tag
    if (nextGoal !== session.goal) change.goal = nextGoal
    if (Object.keys(change).length === 0) return onCancel()
    setBusy(true)
    try {
      await onSave(change)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="history-edit"
      aria-label={`Edit session from ${label}`}
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="field">
        <label htmlFor={`${id}-tag`}>Tag</label>
        <select
          id={`${id}-tag`}
          ref={first}
          value={tag}
          onChange={(event) => setTag(event.target.value as Tag)}
        >
          {TAGS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-goal`}>Goal</label>
        <input
          id={`${id}-goal`}
          type="text"
          value={goal}
          maxLength={GOAL_MAX_LENGTH}
          onChange={(event) => setGoal(oneLine(event.target.value))}
        />
        <p className="field-hint">
          {goal.length}/{GOAL_MAX_LENGTH}
        </p>
      </div>
      <p className="field-hint">Times and durations can’t be changed.</p>
      <button type="submit" className="primary" disabled={busy}>
        Save
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  )
}
