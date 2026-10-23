import { createContext, useContext } from 'react'
import type { User } from './api.ts'

export interface Account {
  user: User
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
