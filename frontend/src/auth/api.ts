export interface User {
  id: string
  email: string
  created_at: string
}

export type AuthErrorKind =
  'invalid' | 'duplicate' | 'password' | 'rate_limited' | 'network' | 'server' | 'other'

/** A stalled connection counts as offline, so a remembered user can still reach the timers. */
export const ME_TIMEOUT_MS = 5000

/** A failed auth call, already mapped to something the screen can show. */
export class AuthError extends Error {
  readonly kind: AuthErrorKind
  readonly retryAfterSeconds?: number
  constructor(kind: AuthErrorKind, message: string, retryAfterSeconds?: number) {
    super(message)
    this.kind = kind
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface AuthApi {
  me(): Promise<User | null>
  signUp(email: string, password: string): Promise<User>
  signIn(email: string, password: string): Promise<User>
  signOut(): Promise<void>
}

interface ErrorBody {
  error?: { message?: string; details?: { field?: string; message?: string }[] | null }
}

async function readError(response: Response): Promise<ErrorBody['error']> {
  try {
    return ((await response.json()) as ErrorBody).error
  } catch {
    return undefined
  }
}

async function call(path: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      credentials: 'same-origin',
    })
  } catch {
    throw new AuthError('network', "Can't reach the server. Check your connection and try again.")
  }
}

async function toError(response: Response): Promise<AuthError> {
  const error = await readError(response)
  if (response.status === 401) {
    return new AuthError('invalid', 'Incorrect email or password.')
  }
  if (response.status === 409) {
    return new AuthError('duplicate', 'An account with this email already exists.')
  }
  if (response.status === 422) {
    const passwordIssue = error?.details?.some((d) => d.field === 'password')
    if (passwordIssue) {
      return new AuthError('password', 'Use a password of 8 to 128 characters.')
    }
    return new AuthError('other', error?.message ?? 'Check your details and try again.')
  }
  if (response.status === 429) {
    const parsed = Number(response.headers.get('Retry-After'))
    const seconds = Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : undefined
    return new AuthError('rate_limited', 'Too many attempts.', seconds)
  }
  if (response.status >= 500) {
    return new AuthError('server', 'The server is having trouble. Try again in a moment.')
  }
  return new AuthError('other', 'Something went wrong. Try again in a moment.')
}

async function credentials(path: string, email: string, password: string): Promise<User> {
  const response = await call(path, { method: 'POST', body: JSON.stringify({ email, password }) })
  if (!response.ok) throw await toError(response)
  return (await response.json()) as User
}

export const SIGNOUT_TIMEOUT_MS = 10000

export const httpAuthApi: AuthApi = {
  async me() {
    const response = await call('/api/auth/me', undefined, ME_TIMEOUT_MS)
    if (response.status === 401) return null
    if (!response.ok) throw await toError(response)
    return (await response.json()) as User
  },
  signUp: (email, password) => credentials('/api/auth/signup', email, password),
  signIn: (email, password) => credentials('/api/auth/signin', email, password),
  async signOut() {
    const response = await call('/api/auth/signout', { method: 'POST' }, SIGNOUT_TIMEOUT_MS)
    if (!response.ok && response.status !== 401) throw await toError(response)
  },
}

/** Human wording for a lockout wait. */
export function describeWait(seconds?: number): string {
  if (!seconds) return 'Try again in a few minutes.'
  if (seconds < 60) return `Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
  const minutes = Math.ceil(seconds / 60)
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
}
