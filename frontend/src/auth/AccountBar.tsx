import { useEffect, useRef, useState } from 'react'
import type { TimerController } from '../timer/index.ts'
import { useAnonymous } from '../anonymous/AnonymousContext.ts'
import { AuthLink } from '../anonymous/AuthLink.tsx'
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
 * The right-hand end of the header (#406). Without an account (#331): a Log in link. Signed in: a
 * 44 px account button (the email's first letter) that opens a menu with the email and Sign out.
 * Shown on every screen except a running timer or the session summary.
 * Sign out is refused while a timer runs; unsynced sessions and edits get one last sync (at most
 * 10 s, skipped offline) and, if any remain, are deleted only after a confirmation (Cancel is
 * the default).
 */
export default function AccountBar({ controller }: { controller: TimerController }) {
  const account = useAccount()
  const anonymous = useAnonymous()
  const [message, setMessage] = useState('')
  const [unsynced, setUnsynced] = useState<UnsyncedCount | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const signOutRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (unsynced) cancelRef.current?.focus()
  }, [unsynced])

  // The menu closes on a click or focus outside it.
  useEffect(() => {
    if (!open) return
    function outside(event: Event) {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
      setUnsynced(null)
      setMessage('')
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [open])

  function close(refocus: boolean) {
    setOpen(false)
    setUnsynced(null)
    setMessage('')
    if (refocus) buttonRef.current?.focus()
  }

  function cancelConfirm() {
    setUnsynced(null)
    signOutRef.current?.focus()
  }

  if (!account) {
    // Without an account (#331): no email, no Sign out, just the way in. The sign-in screen keeps
    // its switch to creating an account.
    if (!anonymous) return null
    return (
      <div className="account-bar">
        <AuthLink form="signin" origin="screen">
          Log in
        </AuthLink>
      </div>
    )
  }
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
      if (count.sessions > 0 || count.edits > 0 || (count.settings ?? 0) > 0) setUnsynced(count)
      else await finish()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="account-bar"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) close(true)
      }}
    >
      <button
        type="button"
        className="account-button"
        ref={buttonRef}
        aria-label={account.user.email}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span aria-hidden="true">{account.user.email.charAt(0).toUpperCase()}</span>
      </button>
      {open && (
        <div className="account-menu" role="group" aria-label="Account">
          <span className="account-email">{account.user.email}</span>
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
              <button type="button" className="danger" onClick={() => void finish()}>
                Sign out anyway
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
