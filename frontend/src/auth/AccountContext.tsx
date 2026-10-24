import { createContext, useContext } from 'react'
import type { User } from './api.ts'

export interface Account {
  /** While `expired`, the user whose data is on the device; not signed in for sync or settings. */
  user: User
  /** The sign-in expired while a timer ran: still shown, but signed out on this device (#120). */
  expired: boolean
  /** Call once no timer runs and no summary is shown: ends the expired state with sign-in. */
  leaveExpired: () => void
  /**
   * Ends the session on the server and clears this user's data from the device. Resolves to an
   * error message if the user must stay signed in, or `null` once signed out.
   */
  signOut: () => Promise<string | null>
}

export const AccountContext = createContext<Account | null>(null)

export function useAccount(): Account | null {
  return useContext(AccountContext)
}
