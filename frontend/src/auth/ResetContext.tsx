import { useContext } from 'react'
import { RESET_OFFER_TEXT, ResetContext } from './resetOffer.ts'

/**
 * A link to the request form; a plain click opens it in place with `email` prefilled, a modified
 * click follows the URL as any link does.
 */
export function ResetLink({ email, children }: { email: string; children: string }) {
  const offer = useContext(ResetContext)
  return (
    <a
      className="auth-link"
      href="/forgot-password"
      onClick={(event) => {
        if (!offer || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
        event.preventDefault()
        offer.open(email)
      }}
    >
      {children}
    </a>
  )
}

/** AC9: the whole line is the link; absent when reset isn't available. */
export function ResetOfferLink({ email }: { email: string }) {
  const offer = useContext(ResetContext)
  if (!offer?.available) return null
  return (
    <p>
      <ResetLink email={email}>{RESET_OFFER_TEXT}</ResetLink>
    </p>
  )
}
