import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useAccount } from './AccountContext.tsx'
import { AccountError, httpAccountApi, PASSWORD_MAX_LENGTH, type AccountApi } from './accountApi.ts'
import { describeWait } from './api.ts'
import { countUnsynced, hasActiveTimer, trySyncAll } from './localData.ts'

const EXPORT_OFFLINE_MESSAGE = 'Export needs a connection.'
const DELETE_ACTIVE_TIMER_MESSAGE = 'End your session before deleting your account.'

/** The export's note about what is missing from it (AC1.6). */
function exportUnsyncedNote(sessions: number, edits: number): string {
  if (sessions > 0) {
    return sessions === 1
      ? "1 session on this device hasn't synced yet and isn't in the export."
      : `${sessions} sessions on this device haven't synced yet and aren't in the export.`
  }
  if (edits > 0)
    return "Some changes to sessions on this device haven't synced yet and aren't in the export."
  return ''
}

function exportErrorMessage(error: unknown): string {
  if (error instanceof AccountError) {
    if (error.kind === 'network') return EXPORT_OFFLINE_MESSAGE
    if (error.kind === 'unauthorized')
      return 'Your sign-in expired. Sign in again to export your data.'
  }
  return "Couldn't export your data. Try again in a moment."
}

function deleteErrorMessage(error: unknown): string {
  if (error instanceof AccountError) {
    switch (error.kind) {
      case 'forbidden':
        return 'Incorrect password'
      case 'rate_limited':
        return `Too many attempts. ${describeWait(error.retryAfterSeconds)}`
      case 'unauthorized':
        return 'Your sign-in expired. Sign in again to delete your account.'
      case 'network':
        return "Can't reach the server. Check your connection and try again. Nothing was deleted."
      case 'server':
        return 'The server is having trouble. Try again in a moment. Nothing was deleted.'
    }
  }
  return 'Something went wrong. Nothing was deleted. Try again in a moment.'
}

function download({ blob, filename }: { blob: Blob; filename: string }) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/**
 * Settings, Account (F1, AC1.6, AC1.7): Export my data and Delete account. Deleting asks for
 * the password in an inline, non-modal confirmation; nothing on the device is cleared unless
 * the server answers 204.
 */
export default function AccountSection({ api = httpAccountApi }: { api?: AccountApi }) {
  const account = useAccount()
  const id = useId()
  const [exportMessage, setExportMessage] = useState('')
  const [exportNote, setExportNote] = useState('')
  const [exporting, setExporting] = useState(false)
  const [open, setOpen] = useState(false)
  const [blocked, setBlocked] = useState('')
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [count, setCount] = useState<number | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const openerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    let current = true
    api
      .sessionCount()
      .then((value) => current && setCount(value))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [open, api])

  if (!account || account.expired) return null
  const { accountDeleted } = account

  async function runExport() {
    setExportMessage('')
    setExportNote('')
    if (!navigator.onLine) {
      setExportMessage(EXPORT_OFFLINE_MESSAGE)
      return
    }
    setExporting(true)
    try {
      await trySyncAll()
      const left = await countUnsynced()
      const file = await api.exportData()
      download(file)
      setExportNote(exportUnsyncedNote(left.sessions, left.edits))
    } catch (error) {
      setExportMessage(exportErrorMessage(error))
    } finally {
      setExporting(false)
    }
  }

  function openConfirm() {
    setBlocked('')
    if (hasActiveTimer()) {
      setBlocked(DELETE_ACTIVE_TIMER_MESSAGE)
      return
    }
    setPassword('')
    setProblem('')
    setCount(null)
    setOpen(true)
  }

  function cancel() {
    setOpen(false)
    setPassword('')
    setProblem('')
    openerRef.current?.focus()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (password === '' || deleting) return
    setProblem('')
    // Another tab may have started a timer while the confirmation was open.
    if (hasActiveTimer()) {
      setProblem(DELETE_ACTIVE_TIMER_MESSAGE)
      return
    }
    setDeleting(true)
    try {
      await api.deleteAccount(password)
    } catch (error) {
      // Nothing is cleared on the device: the account (and its sessions) still exist.
      setProblem(deleteErrorMessage(error))
      setDeleting(false)
      if (error instanceof AccountError && error.kind === 'forbidden') passwordRef.current?.focus()
      return
    }
    // The server confirmed (204): now, and only now, this device is cleared.
    await accountDeleted()
  }

  const sessions =
    count === null ? 'your sessions' : `your ${count} session${count === 1 ? '' : 's'}`
  const fieldProblem = problem === 'Incorrect password'

  return (
    <div className="field account-section" role="group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Account</h2>
      <div className="field-row">
        <button type="button" onClick={() => void runExport()} disabled={exporting}>
          Export my data
        </button>
        <button type="button" ref={openerRef} className="danger" onClick={openConfirm}>
          Delete account
        </button>
      </div>
      <p role="status" className="field-hint">
        {exporting ? 'Preparing your export…' : exportMessage || exportNote}
      </p>
      {blocked && <p role="alert">{blocked}</p>}
      {open && (
        <form
          role="alertdialog"
          aria-label="Confirm delete account"
          className="account-confirm"
          onSubmit={(event) => void submit(event)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              cancel()
            }
          }}
        >
          <p>
            This permanently deletes your account, {sessions} (archived ones included), your
            settings and recent YouTube links, on every device. This can&apos;t be undone.
          </p>
          <button type="button" className="link-button" onClick={() => void runExport()}>
            Export my data
          </button>
          <label htmlFor={`${id}-password`}>Password</label>
          <input
            id={`${id}-password`}
            ref={passwordRef}
            type="password"
            autoComplete="current-password"
            maxLength={PASSWORD_MAX_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={fieldProblem ? true : undefined}
            aria-describedby={problem ? `${id}-problem` : undefined}
          />
          {problem && (
            <p id={`${id}-problem`} role="alert" className="field-error">
              {problem}
            </p>
          )}
          <button type="button" ref={cancelRef} onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="danger" disabled={password === '' || deleting}>
            Delete account
          </button>
        </form>
      )}
    </div>
  )
}
