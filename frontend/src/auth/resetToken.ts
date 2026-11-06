// The password reset link carries its token in the fragment (`/reset-password#token=…`, #350),
// so it never reaches a server log or a Referer header. It is read once, at start-up, before
// anything else runs, and taken out of the address bar at once; after that it lives only in this
// module's memory. It is never written to storage, logged or sent anywhere except the confirm
// request. The app has no route-change tracking or error reporting that could see it.

export const RESET_PASSWORD_PATH = '/reset-password'
export const FORGOT_PASSWORD_PATH = '/forgot-password'

let token: string | null = null

function pathIs(path: string, expected: string): boolean {
  return path.replace(/\/+$/, '') === expected
}

export const isResetPasswordPath = (path: string): boolean => pathIs(path, RESET_PASSWORD_PATH)
export const isForgotPasswordPath = (path: string): boolean => pathIs(path, FORGOT_PASSWORD_PATH)

/**
 * Reads the token from the fragment of the reset page and removes the fragment with
 * `history.replaceState` (the path and query stay). Does nothing on any other page, so a fragment
 * elsewhere is left alone. Safe to call twice: the second call finds no fragment and keeps the
 * token already read.
 */
export function captureResetToken(): void {
  const { pathname, search, hash } = window.location
  if (!isResetPasswordPath(pathname)) return
  const found = new URLSearchParams(hash.replace(/^#/, '')).get('token')
  if (hash !== '') window.history.replaceState(window.history.state, '', pathname + search)
  if (found) token = found
}

/** The token read from the link, or null once used, discarded or if there never was one. */
export function peekResetToken(): string | null {
  return token
}

export function discardResetToken(): void {
  token = null
}
