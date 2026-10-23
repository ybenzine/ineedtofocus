import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthError, describeWait, httpAuthApi } from './api.ts'

const user = { id: 'u1', email: 'a@b.co', created_at: '2026-10-23T00:00:00Z' }

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers })),
  )
}

async function failure(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise
  } catch (error) {
    return error as AuthError
  }
  throw new Error('expected a failure')
}

afterEach(() => vi.unstubAllGlobals())

describe('httpAuthApi', () => {
  it('signs in and returns the user', async () => {
    reply(200, user)
    expect(await httpAuthApi.signIn('a@b.co', 'password1')).toEqual(user)
    const [path, init] = vi.mocked(fetch).mock.calls[0]
    expect(path).toBe('/api/auth/signin')
    expect(init?.body).toBe(JSON.stringify({ email: 'a@b.co', password: 'password1' }))
  })

  it('treats 401 from /me as signed out', async () => {
    reply(401, { error: { code: 'unauthorized', message: 'x' } })
    expect(await httpAuthApi.me()).toBeNull()
  })

  it('maps 401 to one generic message', async () => {
    reply(401, { error: { code: 'invalid_credentials', message: 'x' } })
    const error = await failure(httpAuthApi.signIn('a@b.co', 'password1'))
    expect(error.kind).toBe('invalid')
    expect(error.message).toBe('Incorrect email or password.')
  })

  it('maps 409 to a duplicate-email error', async () => {
    reply(409, { error: { code: 'conflict', message: 'x' } })
    expect((await failure(httpAuthApi.signUp('a@b.co', 'password1'))).kind).toBe('duplicate')
  })

  it('maps a 422 on the password field', async () => {
    reply(422, {
      error: {
        code: 'validation_error',
        message: 'x',
        details: [{ field: 'password', message: 'm' }],
      },
    })
    expect((await failure(httpAuthApi.signIn('a@b.co', 'short'))).kind).toBe('password')
  })

  it('reads the wait from Retry-After on 429', async () => {
    reply(429, { error: { code: 'rate_limited', message: 'x' } }, { 'Retry-After': '421' })
    const error = await failure(httpAuthApi.signIn('a@b.co', 'password1'))
    expect(error.kind).toBe('rate_limited')
    expect(error.retryAfterSeconds).toBe(421)
  })

  it('reports an unreachable server as a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    expect((await failure(httpAuthApi.me())).kind).toBe('network')
  })
})

describe('httpAuthApi sign-out', () => {
  it('treats 401 as already signed out and 5xx as a failure', async () => {
    reply(401, {})
    await expect(httpAuthApi.signOut()).resolves.toBeUndefined()
    reply(500, {})
    expect((await failure(httpAuthApi.signOut())).kind).toBe('server')
  })
})

describe('httpAuthApi availability', () => {
  it('maps a 5xx to a server error', async () => {
    reply(503, {})
    expect((await failure(httpAuthApi.me())).kind).toBe('server')
  })

  it('gives /me a timeout signal', async () => {
    reply(200, user)
    await httpAuthApi.me()
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('describeWait', () => {
  it('words seconds and minutes', () => {
    expect(describeWait(1)).toBe('Try again in 1 second.')
    expect(describeWait(45)).toBe('Try again in 45 seconds.')
    expect(describeWait(421)).toBe('Try again in 8 minutes.')
    expect(describeWait(undefined)).toBe('Try again in a few minutes.')
  })
})
