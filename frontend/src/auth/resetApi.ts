// Password reset by email (F1, AC1.9, #350): `GET /api/auth/options`, `POST
// /api/auth/password-reset` and `POST /api/auth/password-reset/confirm`.

export type ResetErrorKind =
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_token'
  | 'password'
  | 'email'
  | 'network'
  | 'server'
  | 'other'

export class ResetError extends Error {
  readonly kind: ResetErrorKind
  readonly retryAfterSeconds?: number
  constructor(kind: ResetErrorKind, retryAfterSeconds?: number) {
    super(kind)
    this.kind = kind
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface ResetApi {
  /** Whether password reset is available; false when it is off or the call fails. */
  available(): Promise<boolean>
  /** Resolves on 202 (whether or not an account exists); anything else throws `ResetError`. */
  request(email: string): Promise<void>
  /** Resolves on 204 (the password changed, nobody signed in); anything else throws. */
  confirm(token: string, password: string): Promise<void>
}

export const RESET_TIMEOUT_MS = 10_000

async function send(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(RESET_TIMEOUT_MS),
    })
  } catch {
    throw new ResetError('network')
  }
}

async function failure(response: Response): Promise<ResetError> {
  const { status } = response
  if (status === 429) {
    const parsed = Number(response.headers.get('Retry-After'))
    return new ResetError(
      'rate_limited',
      Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : undefined,
    )
  }
  if (status === 503) return new ResetError('unavailable')
  if (status >= 500) return new ResetError('server')
  if (status === 400) return new ResetError('invalid_token')
  if (status === 422) {
    try {
      const body = (await response.json()) as { error?: { details?: { field?: string }[] | null } }
      if (body.error?.details?.some((d) => d.field === 'password'))
        return new ResetError('password')
      if (body.error?.details?.some((d) => d.field === 'email')) return new ResetError('email')
    } catch {
      // No readable body: treated as any other refusal.
    }
  }
  return new ResetError('other')
}

export const httpResetApi: ResetApi = {
  async available() {
    try {
      const response = await send('/api/auth/options')
      if (!response.ok) return false
      return ((await response.json()) as { password_reset?: unknown }).password_reset === true
    } catch {
      return false
    }
  },
  async request(email) {
    const response = await send('/api/auth/password-reset', {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    if (response.status !== 202) throw await failure(response)
  },
  async confirm(token, password) {
    const response = await send('/api/auth/password-reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    })
    if (response.status !== 204) throw await failure(response)
  },
}
