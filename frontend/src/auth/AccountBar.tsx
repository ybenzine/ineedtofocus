import { useEffect, useRef, useState } from 'react'
import type { TimerController } from '../timer/index.ts'
import { useAccount } from './AccountContext.tsx'
import { countUnsynced, hasActiveTimer, trySyncAll } from './localData.ts'

/**
 * Who is signed in, and Sign out. Shown on the setup screen only, never over a running timer.
 * Sign out is refused while a timer runs; unsaved finished sessions are retried first and, if any
 * remain, deleted only after a confirmation (Cancel is the default).
 */
export default function AccountBar({ controller }: { controller: TimerController }) {
  const account = useAccount()
  const [message, setMessage] = useState('')
  const [unsynced, setUnsynced] = useState(0)
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (unsynced > 0) cancelRef.current?.focus()
  }, [unsynced])

  if (!account) return null
  const { signOut } = account

  async function finish() {
    setMessage('')
    setUnsynced(0)
    const problem = await signOut()
    if (problem) setMessage(problem)
  }

  async function request() {
    setMessage('')
    if (hasActiveTimer()) {
      setMessage('End your session before signing out.')
      return
    }
    setBusy(true)
    try {
      await controller.retryPending()
      await trySyncAll()
      const count = await countUnsynced()
      if (count > 0) setUnsynced(count)
      else await finish()
    } finally {
      setBusy(false)
    }
  }

  return (
    <header className="account-bar">
      <span>{account.user.email}</span>
      <button type="button" onClick={() => void request()} disabled={busy}>
        Sign out
      </button>
      {message && <span role="alert">{message}</span>}
      {unsynced > 0 && (
        <div role="alertdialog" aria-label="Confirm sign out" className="account-confirm">
          <p>
            {unsynced === 1
              ? "1 finished session hasn't been saved and will be deleted from this device."
              : `${unsynced} finished sessions haven't been saved and will be deleted from this device.`}
          </p>
          <button type="button" ref={cancelRef} onClick={() => setUnsynced(0)}>
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
