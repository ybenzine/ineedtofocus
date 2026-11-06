import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { httpResetApi, ResetError } from './resetApi.ts'

let fetchMock: ReturnType<typeof vi.fn>

function respond(status: number, body?: unknown, headers: Record<string, string> = {}) {
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
  )
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

async function kindOf(promise: Promise<unknown>): Promise<ResetError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ResetError) return error
  }
  throw new Error('expected a ResetError')
}

describe('available', () => {
  it('is true only for password_reset: true', async () => {
    respond(200, { password_reset: true })
    expect(await httpResetApi.available()).toBe(true)
    respond(200, { password_reset: false })
    expect(await httpResetApi.available()).toBe(false)
  })

  it('is false when the call fails or answers an error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    expect(await httpResetApi.available()).toBe(false)
    respond(500, {})
    expect(await httpResetApi.available()).toBe(false)
  })
})

describe('request', () => {
  it('posts the email and resolves on 202', async () => {
    respond(202, { status: 'accepted' })
    await httpResetApi.request('a@b.co')
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/auth/password-reset')
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@b.co' })
  })

  it('maps 429 with its wait, 503, 422, 5xx and a network failure', async () => {
    respond(429, {}, { 'Retry-After': '90' })
    const limited = await kindOf(httpResetApi.request('a@b.co'))
    expect([limited.kind, limited.retryAfterSeconds]).toEqual(['rate_limited', 90])
    respond(503, {})
    expect((await kindOf(httpResetApi.request('a@b.co'))).kind).toBe('unavailable')
    respond(422, { error: { details: [{ field: 'email' }] } })
    expect((await kindOf(httpResetApi.request('x'))).kind).toBe('email')
    respond(500, {})
    expect((await kindOf(httpResetApi.request('a@b.co'))).kind).toBe('server')
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    expect((await kindOf(httpResetApi.request('a@b.co'))).kind).toBe('network')
  })
})

describe('confirm', () => {
  it('posts the token and password and resolves on 204', async () => {
    respond(204)
    await httpResetApi.confirm('tok', 'new password')
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/auth/password-reset/confirm')
    expect(JSON.parse(String(init.body))).toEqual({ token: 'tok', password: 'new password' })
  })

  it('maps 400 to an invalid token and a password 422 to a password problem', async () => {
    respond(400, { error: { code: 'invalid_token' } })
    expect((await kindOf(httpResetApi.confirm('t', 'new password'))).kind).toBe('invalid_token')
    respond(422, { error: { details: [{ field: 'password' }] } })
    expect((await kindOf(httpResetApi.confirm('t', 'x'))).kind).toBe('password')
  })
})
