// What History and Archive show without an account (#331): their heading and one paragraph
// instead of data, with no request.

import { useEffect, useRef } from 'react'
import { AuthLink } from './AuthLink.tsx'

function AccountRequired({
  id,
  title,
  className,
  what,
}: {
  id: string
  title: string
  className: string
  what: string
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  return (
    <section className={className} aria-labelledby={id}>
      <h1 id={id} ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p>
        <AuthLink form="signup" origin="screen">
          Create an account
        </AuthLink>{' '}
        or{' '}
        <AuthLink form="signin" origin="screen">
          log in
        </AuthLink>{' '}
        to see {what}.
      </p>
    </section>
  )
}

export function AnonymousHistory() {
  return (
    <AccountRequired
      id="history-title"
      title="History"
      className="history"
      what="your focus history"
    />
  )
}

export function AnonymousArchive() {
  return (
    <AccountRequired
      id="archive-title"
      title="Archive"
      className="history archive"
      what="your archived sessions"
    />
  )
}

/** The note at the top of Settings without an account. */
export const ANONYMOUS_SETTINGS_NOTE =
  "Without an account, your settings are saved on this device only. When you log in, your account's settings are used instead."
