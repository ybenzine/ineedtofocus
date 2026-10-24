// The Archive (F11): archived sessions, newest archived first. Read-only (AC11.4): the only
// actions are Restore and "Delete all archived sessions", which asks first (AC11.6).

import { useCallback, useEffect, useRef, useState } from 'react'
import { notifySessionExpired, signedInUserId } from '../auth/localData.ts'
import { deviceTimeZone } from '../history/api.ts'
import { formatDate, formatTime } from '../history/model.ts'
import { markArchivedOnDevice } from '../sync/reconcile.ts'
import type { SessionStore } from '../sync/sessionStore.ts'
import { formatDuration } from '../timerscreen/format.ts'
import { HttpArchiveApi, type ArchiveApi, type ArchivedSession } from './api.ts'

export interface ArchiveScreenProps {
  api?: ArchiveApi
  /** The device's sessions, kept in step with what is restored or deleted. */
  sessions?: SessionStore | null
  ownerId?: string | null
  timeZone?: string
}

const defaultApi = new HttpArchiveApi()

const MODE_LABEL = { countdown: 'Countdown', pomodoro: 'Pomodoro', unlimited: 'Unlimited' } as const
const STATUS_LABEL = { completed: 'Completed', ended_early: 'Ended early' } as const

type Load = { kind: 'loading' } | { kind: 'ready'; sessions: ArchivedSession[] } | { kind: 'error' }

export default function ArchiveScreen({
  api = defaultApi,
  sessions: store = null,
  ownerId,
  timeZone,
}: ArchiveScreenProps) {
  const tz = timeZone ?? deviceTimeZone()
  const owner = ownerId === undefined ? signedInUserId() : ownerId
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)

  useEffect(() => heading.current?.focus(), [])
  useEffect(() => {
    if (confirming) cancel.current?.focus()
  }, [confirming])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoad({ kind: 'loading' })
      const result = await api.list()
      if (cancelled) return
      if (result.kind === 'ok') {
        setLoad({ kind: 'ready', sessions: result.value })
        // Archived on another device: the device copy follows (#133).
        if (owner !== null && store) {
          void markArchivedOnDevice(store, owner, result.value).catch(() => undefined)
        }
      } else {
        if (result.kind === 'unauthorized') notifySessionExpired()
        setLoad({ kind: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, reload, store, owner])

  const fail = useCallback((kind: string, action: string) => {
    if (kind === 'unauthorized') notifySessionExpired()
    if (kind === 'not_found') {
      setProblem(`Couldn’t ${action}. The session may have been deleted on another device.`)
    } else if (kind === 'unavailable' || kind === 'unauthorized') {
      setProblem(`Couldn’t ${action}. Check your connection and try again.`)
    } else {
      setProblem(`Couldn’t ${action}.`)
    }
  }, [])

  async function restore(session: ArchivedSession) {
    setProblem('')
    setNotice('')
    setBusy(true)
    try {
      const result = await api.restore(session.id)
      if (result.kind !== 'ok') return fail(result.kind, 'restore the session')
      if (owner !== null) await store?.setArchived(owner, session.id, null).catch(() => undefined)
      setLoad((current) =>
        current.kind === 'ready'
          ? { kind: 'ready', sessions: current.sessions.filter((s) => s.id !== session.id) }
          : current,
      )
      setNotice('Session restored to History.')
      heading.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  async function deleteAll() {
    setProblem('')
    setBusy(true)
    try {
      const result = await api.deleteAll()
      setConfirming(false)
      if (result.kind !== 'ok') {
        fail(result.kind, 'delete the archived sessions')
        deleteButton.current?.focus()
        return
      }
      // Also sessions archived on another device that this device hasn't been told about.
      if (owner !== null) {
        const ids = sessions.map((s) => s.id)
        await store?.removeArchived(owner, ids).catch(() => undefined)
      }
      setLoad({ kind: 'ready', sessions: [] })
      heading.current?.focus()
      const n = result.value
      setNotice(`Deleted ${n} archived ${n === 1 ? 'session' : 'sessions'}.`)
    } finally {
      setBusy(false)
    }
  }

  const sessions = load.kind === 'ready' ? load.sessions : []
  const count = sessions.length

  return (
    <section className="history archive" aria-labelledby="archive-title">
      <h1 id="archive-title" ref={heading} tabIndex={-1}>
        Archive
      </h1>
      <p className="field-hint">
        Archived sessions are out of History and your totals. You can restore them, or delete them
        for good.
      </p>

      <div role="status">{notice}</div>
      {problem && <p role="alert">{problem}</p>}

      {load.kind === 'loading' ? (
        <p role="status">Loading…</p>
      ) : load.kind === 'error' ? (
        <div>
          <p role="alert">Couldn’t load archived sessions. Check your connection and try again.</p>
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : count === 0 ? (
        <p>No archived sessions.</p>
      ) : (
        <>
          <ul className="history-list">
            {sessions.map((s) => (
              <li key={s.id} className="history-row">
                <p className="history-row-when">
                  <span>{formatDate(s.startedAt, tz)}</span>{' '}
                  <span>{formatTime(s.startedAt, tz)}</span>
                </p>
                <p className="history-row-main">
                  <span>{MODE_LABEL[s.mode]}</span>
                  <span className="timer-tag">{s.tag}</span>
                  <span>{formatDuration(s.focusSeconds)}</span>
                  <span>{STATUS_LABEL[s.status]}</span>
                </p>
                {s.goal && <p className="history-row-goal">{s.goal}</p>}
                <p className="field-hint">Archived {formatDate(s.archivedAt, tz)}</p>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Restore session from ${formatDate(s.startedAt, tz)} ${formatTime(s.startedAt, tz)}`}
                  onClick={() => void restore(s)}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            ref={deleteButton}
            className="danger"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Delete all archived sessions
          </button>
        </>
      )}

      {confirming && (
        <div
          role="alertdialog"
          aria-labelledby="archive-confirm-title"
          className="archive-confirm"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setConfirming(false)
              deleteButton.current?.focus()
            }
          }}
        >
          <p id="archive-confirm-title">
            Permanently delete {count} archived {count === 1 ? 'session' : 'sessions'}? This can’t
            be undone.
          </p>
          <button
            type="button"
            ref={cancel}
            onClick={() => {
              setConfirming(false)
              deleteButton.current?.focus()
            }}
          >
            Cancel
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => void deleteAll()}>
            Delete {count} {count === 1 ? 'session' : 'sessions'}
          </button>
        </div>
      )}
    </section>
  )
}
