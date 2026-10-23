import { useAccount } from './AccountContext.tsx'

/** Who is signed in, and Sign out. Shown on the setup screen only, never over a running timer. */
export default function AccountBar() {
  const account = useAccount()
  if (!account) return null
  return (
    <header className="account-bar">
      <span>{account.user.email}</span>
      <button type="button" onClick={() => void account.signOut()}>
        Sign out
      </button>
      {account.signOutError && <span role="alert">{account.signOutError}</span>}
    </header>
  )
}
