import type { ReactNode } from 'react'
import { pathForForm, useAnonymous, type AuthForm, type FormOrigin } from './AnonymousContext.ts'

/**
 * A link to `/signup` or `/login`. A plain click opens the form in place (keeping what the page
 * holds); a modified click or middle click follows the URL as any link does.
 */
export function AuthLink({
  form,
  origin,
  children,
}: {
  form: AuthForm
  origin: FormOrigin
  children: ReactNode
}) {
  const anonymous = useAnonymous()
  return (
    <a
      className="auth-link"
      href={pathForForm(form)}
      onClick={(event) => {
        if (
          !anonymous ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        event.preventDefault()
        anonymous.openForm(form, origin)
      }}
    >
      {children}
    </a>
  )
}
