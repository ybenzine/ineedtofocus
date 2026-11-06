import { createContext, useContext, useEffect } from 'react'

/** Provided by `AuthGate` (#350). */
export interface ResetOffer {
  /** Password reset is configured on the server (`GET /api/auth/options`). */
  available: boolean
  /** Asks the server whether reset is available (when a screen that offers it appears). */
  ensure: () => void
  /** Opens the request form, prefilled with `email`. */
  open: (email: string) => void
}

export const ResetContext = createContext<ResetOffer | null>(null)

export const RESET_OFFER_TEXT = 'Forgot your password? Reset it by email.'

/**
 * Whether the offer to reset the password is available: false when it is off, the options call
 * failed, or there is no `AuthGate` around. `wanted` is false while no screen needs the answer.
 */
export function useResetAvailable(wanted: boolean): boolean {
  const offer = useContext(ResetContext)
  const ensure = offer?.ensure
  useEffect(() => {
    if (wanted) ensure?.()
  }, [wanted, ensure])
  return offer?.available === true
}
