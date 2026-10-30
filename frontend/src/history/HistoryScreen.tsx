// History (F10): focus time by day, week, month, all time or a custom range.

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { notifySessionExpired, signedInUserId } from '../auth/localData.ts'
import { HttpArchiveApi, type ArchiveApi } from '../archive/api.ts'
import { useSettingsState } from '../settings/SettingsContext.ts'
import { GOAL_MAX_LENGTH, tagLabel } from '../setup/options.ts'
import { HttpSessionsApi, type SessionEdit, type SessionsApi } from '../sync/api.ts'
import { clearArchivedOnDevice, reconcileMissing } from '../sync/reconcile.ts'
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
  listedAsLive,
  missingFromServer,
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
  // The archive to undo; `deviceOnly` for a rejected session, which only this device has.
  const [undo, setUndo] = useState<{ id: string; deviceOnly: boolean } | null>(null)
  const [problem, setProblem] = useState('')
  const undoButton = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  // Sessions being archived: left out of every answer until the server has confirmed or refused.
  const archiving = useRef(new Set<string>())
  // Archived on this screen (confirmed) and not undone since: a server answer read before that
  // may still list the session, and must not clear the mark.
  const archivedHere = useRef(new Set<string>())
  // Undo started on this screen: a reconcile still in flight must not mark the session archived
  // after Undo's own write.
  const restored = useRef(new Set<string>())
  const isSkipped = (id: string) =>
    archiving.current.has(id) || archivedHere.current.has(id) || restored.current.has(id)
  // Read by the load effect without re-running it when a caller passes a fresh object.
  const archiveApiRef = useRef(archiveApi)
  useEffect(() => {
    archiveApiRef.current = archiveApi
  }, [archiveApi])
  const lastEdited = useRef<string | null>(null)
  // After Save the list reloads and its rows are rebuilt: focus goes back to that row's Edit
  // button once the new list is on screen.
  const pendingFocus = useRef<string | null>(null)

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
  // Closing the edit form returns focus to that row's Edit button.
  useEffect(() => {
    if (editingId !== null) {
      lastEdited.current = editingId
      return
    }
    const id = lastEdited.current
    lastEdited.current = null
    if (id === null) return
    ;(editButton(id) ?? heading.current)?.focus()
  }, [editingId])
  useEffect(() => {
    const id = pendingFocus.current
    if (id === null || load.kind !== 'ready') return
    pendingFocus.current = null
    ;(editButton(id) ?? heading.current)?.focus()
  }, [load])
  useEffect(() => {
    const onOnline = () => setReload((n) => n + 1)
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  // A sync that changed something on the device (a session saved to the account, an edit
  // applied) refreshes the list, its "not saved" note and the rows' badges (AC10.9).
  useEffect(() => sync?.onChange(() => setReload((n) => n + 1)), [sync])

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
      // A session marked gone is deleted only by a pair that started after its mark (#227).
      const loadStartedAt = Date.now()
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
          rejected: d.syncState === 'rejected',
        } satisfies HistorySession,
        archived: d.archivedAt !== null,
        // Selected by upload state, not by the badge: a synced session with a queued edit also
        // shows a badge, but the server already has it.
        notUploaded: d.syncState !== 'synced',
      }))
      // Marked gone on the server (#227): hidden, but kept until a later load confirms it.
      const goneIds = new Set(local.filter((d) => d.goneOnServer).map((d) => d.record.id))
      const alive = device.filter(
        (d) => !d.archived && !archiving.current.has(d.session.id) && !goneIds.has(d.session.id),
      )
      const archivedIds = new Set(device.filter((d) => d.archived).map((d) => d.session.id))
      const leaveOut = (data: HistoryData) =>
        archiving.current.size > 0 ? removeSessions(data, archiving.current) : data
      // Changes the server hasn't confirmed yet: shown now (AC11.1), with their sync badge.
      const changes = new Map<string, SessionChange>()
      for (const d of local) {
        if (d.editState !== null && d.edit !== null && d.archivedAt === null) {
          changes.set(d.record.id, {
            ...d.edit,
            indicator: d.indicator,
            editRejected: d.editState === 'rejected',
          })
        }
      }
      const unsynced = alive.filter((d) => d.notUploaded).map((d) => d.session)
      if (result.kind === 'ok') {
        cache.current.set(queryKey, result.value)
        // Sessions archived or deleted on another device: the device copy follows.
        if (owner !== null && sessions) {
          const missing = missingFromServer(
            result.value,
            local.map((d) => ({
              id: d.record.id,
              startedAt: d.record.startedAt,
              synced: d.syncState === 'synced',
              archived: d.archivedAt !== null,
            })),
            query.tags,
            archiving.current,
          )
          void reconcileMissing(
            sessions,
            archiveApiRef.current,
            owner,
            missing,
            isSkipped,
            loadStartedAt,
          ).catch(() => undefined)
          // Listed again (restored elsewhere, or a backup restored): it isn't gone after all.
          const listed = new Set(result.value.sessions.map((s) => s.id))
          void sessions
            .clearGone(
              owner,
              [...goneIds].filter((id) => listed.has(id)),
            )
            .catch(() => undefined)
          // Restored on another device: the server lists it as live again.
          void clearArchivedOnDevice(
            sessions,
            owner,
            listedAsLive(
              result.value,
              local.map((d) => ({ id: d.record.id, archived: d.archivedAt !== null })),
            ),
            isSkipped,
          ).catch(() => undefined)
        }
        setLoad({
          kind: 'ready',
          data: applyChanges(leaveOut(mergeSessions(result.value, unsynced, query.tags)), changes),
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
        new Set([...archivedIds, ...goneIds]),
      )
      // Everything on the device that isn't archived (merging de-duplicates by id), so a session
      // that synced after the cached answer was fetched isn't lost.
      const extra = alive.map((d) => d.session)
      setLoad({
        kind: 'ready',
        data: applyChanges(leaveOut(mergeSessions(base, extra, query.tags)), changes),
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
    if (kind === 'not_found') {
      setProblem(`Couldn’t ${action}. The session may have been deleted on another device.`)
    } else if (kind === 'unavailable' || kind === 'unauthorized') {
      setProblem(`Couldn’t ${action}. Check your connection and try again.`)
    } else {
      setProblem(`Couldn’t ${action}.`)
    }
  }

  const ARCHIVED_ELSEWHERE = 'This session was archived on another device, so it can’t be edited.'

  /**
   * AC11.1: a session on this device is edited on the device first and sent as soon as it can
   * be; one only the server has (finished on another device) is edited online.
   */
  async function saveEdit(session: HistorySession, change: SessionEdit) {
    setProblem('')
    try {
      const onDevice =
        owner !== null && sessions ? (await sessions.get(session.id))?.ownerId === owner : false
      if (owner !== null && sessions && onDevice) {
        await sessions.edit(owner, session.id, change)
        setEditingId(null)
        pendingFocus.current = session.id
        setReload((n) => n + 1)
        void sync?.syncNow().then((report) => {
          if (!mounted.current) return
          // Only when this sync dropped the edit after a 409 (the engine says so), and not while
          // this session is being archived here: then the archive is what the user asked for.
          if (report.dropped.includes(session.id) && !archiving.current.has(session.id)) {
            setProblem(ARCHIVED_ELSEWHERE)
          }
          // The reload rebuilds the rows: keep focus on this row's Edit button if it's there.
          const active = document.activeElement
          if (active === null || active === document.body || active === editButton(session.id)) {
            pendingFocus.current = session.id
          }
          setReload((n) => n + 1)
        })
        return
      }
    } catch {
      setProblem('Couldn’t save the change on this device. Try again.')
      return
    }
    const result = await sessionsApi.edit(session.id, change)
    if (result.kind === 'ok') {
      setEditingId(null)
      pendingFocus.current = session.id
      cache.current.clear()
      setReload((n) => n + 1)
    } else if (result.kind === 'conflict') {
      setProblem(ARCHIVED_ELSEWHERE)
      setEditingId(null)
      pendingFocus.current = session.id
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
    const gone = new Set([session.id])
    archiving.current.add(session.id)
    restored.current.delete(session.id)
    setLoad({ ...load, data: removeSessions(load.data, gone) })
    // The cache is left alone until the server confirms: `archiving` keeps the session out of
    // every answer meanwhile, and a failed archive (offline) must not wipe what's cached for
    // offline use, such as other devices' sessions.
    const rollBack = (kind: string) => {
      archiving.current.delete(session.id)
      setReload((n) => n + 1)
      if (kind === 'unsynced') {
        setProblem('Couldn’t archive the session: your change hasn’t synced yet. Try again soon.')
      } else {
        fail(kind, 'archive the session')
      }
    }
    // A queued edit goes first, so the archive (and a later restore) never loses it: if it
    // still hasn't reached the server, the archive is refused.
    try {
      if (owner !== null && sessions && (await sessions.get(session.id))?.editState === 'pending') {
        await sync?.syncNow()
        if ((await sessions.get(session.id))?.editState === 'pending') return rollBack('unsynced')
      }
    } catch {
      return rollBack('unsynced')
    }
    const result = await archiveApi.archive(session.id)
    if (!mounted.current) return
    if (result.kind !== 'ok') return rollBack(result.kind)
    if (owner !== null) {
      await sessions?.setArchived(owner, session.id, result.value).catch(() => undefined)
    }
    archivedHere.current.add(session.id)
    archiving.current.delete(session.id)
    for (const [key, data] of cache.current) cache.current.set(key, removeSessions(data, gone))
    setUndo({ id: session.id, deviceOnly: false })
    setReload((n) => n + 1)
  }

  /**
   * A session the server rejected can never be archived there. Archive it on this device only:
   * out of History and totals at once, nothing sent, offline included.
   */
  async function archiveOnDevice(session: HistorySession) {
    if (load.kind !== 'ready' || owner === null || !sessions) return
    setProblem('')
    setUndo(null)
    setEditingId(null)
    setLoad({ ...load, data: removeSessions(load.data, new Set([session.id])) })
    try {
      await sessions.archiveOnDevice(owner, session.id)
    } catch {
      setReload((n) => n + 1)
      setProblem('Couldn’t archive the session on this device. Try again.')
      return
    }
    if (!mounted.current) return
    setUndo({ id: session.id, deviceOnly: true })
    setReload((n) => n + 1)
  }

  /** Whether the change was discarded; on `false` the row keeps its edit and says why. */
  async function discardChange(session: HistorySession): Promise<boolean> {
    if (owner === null || !sessions) return false
    setProblem('')
    try {
      await sessions.discardEdit(owner, session.id)
    } catch {
      setProblem('Couldn’t discard the change. Try again.')
      return false
    }
    if (!mounted.current) return true
    pendingFocus.current = session.id
    setReload((n) => n + 1)
    return true
  }

  async function undoArchive() {
    if (undo === null) return
    setProblem('')
    if (undo.deviceOnly) {
      // Nothing was sent to the server, so nothing is sent to undo it.
      if (owner === null || !sessions) return
      try {
        await sessions.restoreOnDevice(owner, undo.id)
      } catch {
        return setProblem('Couldn’t undo the archive. Try again.')
      }
      if (!mounted.current) return
      // Only this archive's message: a newer one (another archive meanwhile) stays.
      setUndo((current) => (current?.id === undo.id ? null : current))
      setReload((n) => n + 1)
      return
    }
    const id = undo.id
    restored.current.add(id)
    const result = await archiveApi.restore(id)
    if (!mounted.current) return
    if (result.kind !== 'ok') {
      restored.current.delete(id)
      return fail(result.kind, 'undo the archive')
    }
    archivedHere.current.delete(id)
    // Cleared before the next await, so the message is gone by the time the row is back. A reply
    // that comes late must not clear a newer message (another archive in the meantime).
    setUndo((current) => (current?.id === id ? null : current))
    if (owner !== null) await sessions?.setArchived(owner, id, null).catch(() => undefined)
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
            <span>
              {undo.deviceOnly ? 'Session archived on this device only.' : 'Session archived.'}
            </span>{' '}
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
          onArchiveOnDevice={archiveOnDevice}
          onDiscard={discardChange}
        />
      )}
    </section>
  )
}

function editButton(id: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-edit-for]')).find(
    (el) => el.dataset.editFor === id,
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
  onArchiveOnDevice,
  onDiscard,
}: {
  data: HistoryData
  offline: boolean
  filtered: boolean
  onNewSession?: () => void
  editingId: string | null
  onEdit: (id: string | null) => void
  onSave: (session: HistorySession, change: SessionEdit) => Promise<void>
  onArchive: (session: HistorySession) => Promise<void>
  onArchiveOnDevice: (session: HistorySession) => Promise<void>
  onDiscard: (session: HistorySession) => Promise<boolean>
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
                  onArchiveOnDevice={() => void onArchiveOnDevice(s)}
                  onDiscard={() => onDiscard(s)}
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
  onArchiveOnDevice: () => void
  onDiscard: () => Promise<boolean>
}

function SessionRow({
  session,
  timeZone,
  editing,
  onEdit,
  onCancel,
  onSave,
  onArchive,
  onArchiveOnDevice,
  onDiscard,
}: SessionRowProps) {
  const label = `${formatDate(session.startedAt, timeZone)} ${formatTime(session.startedAt, timeZone)}`
  const [discarding, setDiscarding] = useState(false)
  const [busy, setBusy] = useState(false)
  const cancelDiscard = useRef<HTMLButtonElement>(null)
  const discardButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  // The confirmation takes focus on Cancel (the default); closing it with Cancel or Escape hands
  // focus back to the button that opened it. A confirmed discard leaves focus to the screen,
  // which puts it on this row's Edit button once the list has reloaded.
  useEffect(() => {
    if (discarding) cancelDiscard.current?.focus()
    else if (returnFocus.current) {
      returnFocus.current = false
      discardButton.current?.focus()
    }
  }, [discarding])
  function closeDiscard() {
    returnFocus.current = true
    setDiscarding(false)
  }
  async function confirmDiscard() {
    setBusy(true)
    let discarded = false
    try {
      discarded = await onDiscard()
    } finally {
      setBusy(false)
      // A discard that failed leaves the Discard button, with the error shown, as the focus
      // target; a confirmed one leaves focus to the screen (the row's Edit button).
      returnFocus.current = !discarded
      setDiscarding(false)
    }
  }
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
      {discarding && (
        <div
          role="alertdialog"
          aria-label={`Discard change to session from ${label}`}
          className="archive-confirm"
          onKeyDown={(event) => {
            if (event.key === 'Escape') closeDiscard()
          }}
        >
          <p>Discard this change? The session keeps its last synced tag and goal.</p>
          <button type="button" ref={cancelDiscard} onClick={closeDiscard}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void confirmDiscard()}
          >
            Discard change
          </button>
        </div>
      )}
      {editing ? (
        <EditForm session={session} label={label} onCancel={onCancel} onSave={onSave} />
      ) : (
        <div className="history-row-actions">
          <button
            type="button"
            data-edit-for={session.id}
            disabled={discarding}
            aria-label={`Edit session from ${label}`}
            onClick={onEdit}
          >
            Edit
          </button>
          {session.editRejected && !discarding && (
            <button
              type="button"
              ref={discardButton}
              aria-label={`Discard change to session from ${label}`}
              onClick={() => setDiscarding(true)}
            >
              Discard change
            </button>
          )}
          {session.rejected ? (
            <>
              <button
                type="button"
                aria-label={`Archive session from ${label} on this device only`}
                onClick={onArchiveOnDevice}
              >
                Archive on this device only
              </button>
              <span className="field-hint">The server didn’t accept this session.</span>
            </>
          ) : session.unsaved ? (
            <span className="field-hint">Can be archived once it has synced.</span>
          ) : session.editRejected ? (
            <span className="field-hint">Can be archived once the change is discarded.</span>
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
      data-holds-update=""
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
              {tagLabel(t)}
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
      </div>
      <div className="history-edit-actions">
        <button type="submit" className="primary" disabled={busy}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
