import { useEffect, useRef, useState } from 'react'
import type { TimerController } from '../timer/index.ts'
import { useAccount } from './AccountContext.tsx'
import {
  ACTIVE_TIMER_MESSAGE,
  countUnsynced,
  hasActiveTimer,
  trySyncAll,
  unsyncedWarning,
  type UnsyncedCount,
} from './localData.ts'

/**
 * Who is signed in, and Sign out. Shown on the setup screen only, never over a running timer.
 * Sign out is refused while a timer runs; unsynced sessions and edits get one last sync (at most
 * 10 s, skipped offline) and, if any remain, are deleted only after a confirmation (Cancel is
 * the default).
 */
export default function AccountBar({ controller }: { controller: TimerController }) {
  const account = useAccount()
  const [message, setMessage] = useState('')
  const [unsynced, setUnsynced] = useState<UnsyncedCount | null>(null)
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const signOutRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (unsynced) cancelRef.current?.focus()
  }, [unsynced])

  function cancelConfirm() {
    setUnsynced(null)
    signOutRef.current?.focus()
  }

  if (!account) return null
  const { signOut } = account

  async function finish() {
    setMessage('')
    setUnsynced(null)
    // Another tab may have started a timer while the confirmation was open.
    if (hasActiveTimer()) {
      setMessage(ACTIVE_TIMER_MESSAGE)
      return
    }
    const problem = await signOut()
    if (problem) setMessage(problem)
  }

  async function request() {
    setMessage('')
    if (hasActiveTimer()) {
      setMessage(ACTIVE_TIMER_MESSAGE)
      return
    }
    setBusy(true)
    try {
      await controller.retryPending()
      await trySyncAll()
      const count = await countUnsynced()
      if (count.sessions > 0 || count.edits > 0) setUnsynced(count)
      else await finish()
    } finally {
      setBusy(false)
    }
  }

  return (
    <header className="account-bar">
      <span>{account.user.email}</span>
      <button type="button" ref={signOutRef} onClick={() => void request()} disabled={busy}>
        Sign out
      </button>
      {message && <span role="alert">{message}</span>}
      {unsynced && (
        <div
          role="alertdialog"
          aria-label="Confirm sign out"
          className="account-confirm"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              cancelConfirm()
            }
          }}
        >
          <p>{unsyncedWarning(unsynced)}</p>
          <button type="button" ref={cancelRef} onClick={cancelConfirm}>
            Cancel
          </button>
          <button type="button" onClick={() => void finish()}>
            Sign out anyway
          </button>
        </div>
      )}
    </header>
  )
}
