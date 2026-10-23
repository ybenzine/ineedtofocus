import { createContext, useContext } from 'react'
import type { User } from './api.ts'

export interface Account {
  user: User
  /** Empty when there is nothing to report. */
  signOutError: string
  signOut: () => Promise<void>
}

export const AccountContext = createContext<Account | null>(null)

export function useAccount(): Account | null {
  return useContext(AccountContext)
}
