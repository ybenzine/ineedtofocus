// Export my data and Delete account (F1, AC1.6, AC1.7): `GET /api/account/export` and
// `POST /api/account/delete`. A wrong password is 403, not 401: 401 means the sign-in expired.

import { deviceTimeZone, HttpHistoryApi } from '../history/api.ts'
import { HttpArchiveApi } from '../archive/api.ts'

export type AccountErrorKind =
  'forbidden' | 'rate_limited' | 'unauthorized' | 'network' | 'server' | 'other'

export class AccountError extends Error {
  readonly kind: AccountErrorKind
  readonly retryAfterSeconds?: number
  constructor(kind: AccountErrorKind, retryAfterSeconds?: number) {
    super(kind)
    this.kind = kind
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface ExportFile {
  blob: Blob
  filename: string
}

export interface AccountApi {
  /** The whole account as one JSON file. */
  exportData(): Promise<ExportFile>
  /** Resolves only on 204 (the account is gone); every other answer throws `AccountError`. */
  deleteAccount(password: string): Promise<void>
  /** Every session of the account, archived included; `null` when it can't be told. */
  sessionCount(): Promise<number | null>
}

export const ACCOUNT_TIMEOUT_MS = 30_000
/** The server limits the password to 128 characters (longer is 422). */
export const PASSWORD_MAX_LENGTH = 128

function fallbackFilename(): string {
  return `ineedtofocus-export-${new Date().toISOString().slice(0, 10)}.json`
}

export function filenameFrom(disposition: string | null): string {
  const match = disposition?.match(/filename="?([^";]+)"?/i)
  const name = match?.[1]?.trim()
  return name && /^[\w.-]+$/.test(name) ? name : fallbackFilename()
}

function failure(response: Response): AccountError {
  if (response.status === 401) return new AccountError('unauthorized')
  if (response.status === 403) return new AccountError('forbidden')
  if (response.status === 429) {
    const parsed = Number(response.headers.get('Retry-After'))
    return new AccountError(
      'rate_limited',
      Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : undefined,
    )
  }
  return new AccountError(response.status >= 500 ? 'server' : 'other')
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
    })
  } catch {
    throw new AccountError('network')
  }
}

export const httpAccountApi: AccountApi = {
  async exportData() {
    const response = await send('/api/account/export', { headers: { Accept: 'application/json' } })
    if (!response.ok) throw failure(response)
    try {
      const blob = await response.blob()
      return { blob, filename: filenameFrom(response.headers.get('Content-Disposition')) }
    } catch {
      throw new AccountError('network')
    }
  },
  async deleteAccount(password) {
    const response = await send('/api/account/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (response.status !== 204) throw failure(response)
  },
  async sessionCount() {
    const [history, archived] = await Promise.all([
      new HttpHistoryApi().get({ view: 'all', tz: deviceTimeZone(), tags: [] }),
      new HttpArchiveApi().list(),
    ])
    if (history.kind !== 'ok' || archived.kind !== 'ok') return null
    return history.value.sessionCount + archived.value.length
  },
}
