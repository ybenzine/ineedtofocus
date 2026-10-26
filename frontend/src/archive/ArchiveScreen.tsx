// The Archive (F11): archived sessions, newest archived first. Read-only (AC11.4): the only
// actions are Restore and "Delete all archived sessions", which asks first (AC11.6).

import { useCallback, useEffect, useRef, useState } from 'react'
import { notifySessionExpired, signedInUserId } from '../auth/localData.ts'
import { deviceTimeZone } from '../history/api.ts'
import { formatDate, formatTime } from '../history/model.ts'
import { markArchivedOnDevice, reconcileArchivedGone } from '../sync/reconcile.ts'
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
  // Rejected sessions archived on this device only: the server never had them, so they are read
  // from the device and never sent anywhere.
  const [deviceOnly, setDeviceOnly] = useState<ArchivedSession[]>([])
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  // Restored on this screen: the load's marking loop must not set them archived again.
  const restored = useRef(new Set<string>())
  const cancel = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  // Delete all is disabled while busy, so focus goes back to it once the request is over.
  const focusDelete = useRef(false)

  useEffect(() => heading.current?.focus(), [])
  useEffect(() => {
    if (confirming) cancel.current?.focus()
  }, [confirming])
  useEffect(() => {
    if (!busy && focusDelete.current) {
      focusDelete.current = false
      deleteButton.current?.focus()
    }
  }, [busy])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoad({ kind: 'loading' })
      const loadStartedAt = Date.now()
      const result = await api.list()
      if (cancelled) return
      if (result.kind === 'ok') {
        setLoad({ kind: 'ready', sessions: result.value })
        // Archived on another device: the device copy follows.
        if (owner !== null && store) {
          const isSkipped = (id: string) => restored.current.has(id)
          void markArchivedOnDevice(store, owner, result.value, isSkipped)
            // Archived here but no longer listed (deleted elsewhere): mark, then delete on a
            // later load (#263).
            .then(() => reconcileArchivedGone(store, owner, result.value, isSkipped, loadStartedAt))
            .catch(() => undefined)
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

  useEffect(() => {
    if (owner === null || !store) return
    let cancelled = false
    void store
      .list(owner)
      .then((all) => {
        if (cancelled) return
        setDeviceOnly(
          all
            .filter((d) => d.syncState === 'rejected' && d.archivedAt !== null)
            .map((d) => ({
              id: d.record.id,
              mode: d.record.mode,
              tag: d.record.tag,
              goal: d.record.goal,
              startedAt: d.record.startedAt,
              focusSeconds: d.record.focusSeconds,
              status: d.record.status,
              archivedAt: d.archivedAt ?? '',
            }))
            .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [store, owner, reload])

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
      restored.current.add(session.id)
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

  /** Puts a device-only archived session back in History, still "Couldn't sync". No request. */
  async function restoreOnDevice(session: ArchivedSession) {
    if (owner === null || !store) return
    setProblem('')
    setNotice('')
    setBusy(true)
    try {
      await store.restoreOnDevice(owner, session.id)
      setDeviceOnly((current) => current.filter((s) => s.id !== session.id))
      setNotice('Session restored to History.')
      heading.current?.focus()
    } catch {
      setProblem('Couldn’t restore the session on this device. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function deleteAll() {
    setProblem('')
    setNotice('')
    setBusy(true)
    try {
      const result = await api.deleteAll()
      setConfirming(false)
      if (result.kind !== 'ok') {
        fail(result.kind, 'delete the archived sessions')
        focusDelete.current = true
        return
      }
      // Also sessions archived on another device that this device hasn't been told about.
      let deviceFailed = false
      if (owner !== null) {
        const ids = sessions.map((s) => s.id)
        await store?.removeArchived(owner, ids).catch(() => {
          deviceFailed = true
        })
      }
      setLoad({ kind: 'ready', sessions: [] })
      // The device-only ones are deleted from the device with the rest and counted with them.
      // If that failed they exist only here, so they stay listed and are not reported deleted.
      const stuck = deviceFailed ? deviceOnly.length : 0
      if (stuck === 0) setDeviceOnly([])
      const n = result.value + deviceOnly.length - stuck
      // Nothing deleted still gets an answer: the list just emptied.
      if (n > 0 || stuck === 0)
        setNotice(`Deleted ${n} archived ${n === 1 ? 'session' : 'sessions'}.`)
      if (stuck > 0) {
        setProblem(
          `Couldn’t delete ${stuck === 1 ? 'the archived session' : `${stuck} archived sessions`} that ${stuck === 1 ? 'is' : 'are'} only on this device. ${stuck === 1 ? 'It stays' : 'They stay'} in the Archive. Try again.`,
        )
        focusDelete.current = true
      } else heading.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const sessions = load.kind === 'ready' ? load.sessions : []
  const count = sessions.length + deviceOnly.length
  // One list, most recently archived first; a tie keeps the server's row first.
  const rows = [
    ...sessions.map((s) => ({ s, onDeviceOnly: false })),
    ...deviceOnly.map((s) => ({ s, onDeviceOnly: true })),
  ].sort((a, b) => Date.parse(b.s.archivedAt) - Date.parse(a.s.archivedAt))

  function row(s: ArchivedSession, onDeviceOnly: boolean) {
    return (
      <li key={s.id} className="history-row">
        <p className="history-row-when">
          <span>{formatDate(s.startedAt, tz)}</span> <span>{formatTime(s.startedAt, tz)}</span>
        </p>
        <p className="history-row-main">
          <span>{MODE_LABEL[s.mode]}</span>
          <span className="timer-tag">{s.tag}</span>
          <span>{formatDuration(s.focusSeconds)}</span>
          <span>{STATUS_LABEL[s.status]}</span>
        </p>
        {s.goal && <p className="history-row-goal">{s.goal}</p>}
        {onDeviceOnly && <p className="history-badge">Only on this device</p>}
        <p className="field-hint">Archived {formatDate(s.archivedAt, tz)}</p>
        <button
          type="button"
          disabled={busy}
          aria-label={`Restore session from ${formatDate(s.startedAt, tz)} ${formatTime(s.startedAt, tz)}`}
          onClick={() => void (onDeviceOnly ? restoreOnDevice(s) : restore(s))}
        >
          Restore
        </button>
      </li>
    )
  }

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
          {deviceOnly.length > 0 && (
            <ul className="history-list">{deviceOnly.map((s) => row(s, true))}</ul>
          )}
        </div>
      ) : count === 0 ? (
        <p>No archived sessions.</p>
      ) : (
        <>
          <ul className="history-list">
            {rows.map(({ s, onDeviceOnly }) => row(s, onDeviceOnly))}
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
