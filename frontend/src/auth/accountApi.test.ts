import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountError, filenameFrom, httpAccountApi } from './accountApi.ts'

afterEach(() => vi.unstubAllGlobals())

function stub(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response
    return response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function kindOf(promise: Promise<unknown>): Promise<AccountError> {
  try {
    await promise
  } catch (error) {
    return error as AccountError
  }
  throw new Error('did not throw')
}

describe('httpAccountApi.deleteAccount', () => {
  it('posts the password and resolves on 204', async () => {
    const fetchMock = stub(new Response(null, { status: 204 }))
    await httpAccountApi.deleteAccount('pw')
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/account/delete')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ password: 'pw' }))
  })

  it.each([
    [403, 'forbidden'],
    [401, 'unauthorized'],
    [422, 'other'],
    [500, 'server'],
    [503, 'server'],
  ])('maps %i to %s', async (status, kind) => {
    stub(new Response('{}', { status }))
    expect((await kindOf(httpAccountApi.deleteAccount('pw'))).kind).toBe(kind)
  })

  it('reads Retry-After on 429', async () => {
    stub(new Response('{}', { status: 429, headers: { 'Retry-After': '61' } }))
    const error = await kindOf(httpAccountApi.deleteAccount('pw'))
    expect(error.kind).toBe('rate_limited')
    expect(error.retryAfterSeconds).toBe(61)
  })

  it('maps a network failure to network', async () => {
    stub(new TypeError('offline'))
    expect((await kindOf(httpAccountApi.deleteAccount('pw'))).kind).toBe('network')
  })
})

describe('httpAccountApi.exportData', () => {
  it('returns the body and the server filename', async () => {
    stub(
      new Response('{"format_version":1}', {
        headers: {
          'Content-Disposition': 'attachment; filename="ineedtofocus-export-2026-10-30.json"',
        },
      }),
    )
    const file = await httpAccountApi.exportData()
    expect(file.filename).toBe('ineedtofocus-export-2026-10-30.json')
    expect(await file.blob.text()).toBe('{"format_version":1}')
  })

  it('throws on 401 and on a network failure', async () => {
    stub(new Response('{}', { status: 401 }))
    expect((await kindOf(httpAccountApi.exportData())).kind).toBe('unauthorized')
    stub(new TypeError('offline'))
    expect((await kindOf(httpAccountApi.exportData())).kind).toBe('network')
  })
})

describe('filenameFrom', () => {
  it('falls back to a dated name when the header is missing or odd', () => {
    expect(filenameFrom(null)).toMatch(/^ineedtofocus-export-\d{4}-\d{2}-\d{2}\.json$/)
    expect(filenameFrom('attachment; filename="../x/y.json"')).toMatch(/^ineedtofocus-export-/)
  })
})
