import { afterEach, describe, expect, it, vi } from 'vitest'
import { newTraceparent, tracedFetch } from './tracedFetch.ts'

afterEach(() => vi.unstubAllGlobals())

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/

describe('newTraceparent', () => {
  it('is a valid W3C traceparent with fresh ids each time', () => {
    const a = newTraceparent()
    expect(a).toMatch(TRACEPARENT)
    expect(newTraceparent()).not.toBe(a)
  })
})

describe('tracedFetch', () => {
  it('adds traceparent and keeps the caller headers and options', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await tracedFetch('/api/sessions/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/sessions/sync')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    const headers = new Headers(init.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('traceparent')).toMatch(TRACEPARENT)
  })

  it('does not override a traceparent the caller set', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const own = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
    await tracedFetch('/api/history', { headers: { traceparent: own } })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('traceparent')).toBe(own)
  })

  it('keeps the headers of a Request input', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await tracedFetch(new Request('http://localhost/api/history', { headers: { 'X-Test': '1' } }))
    const [, init] = fetchMock.mock.calls[0] as unknown as [Request, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('x-test')).toBe('1')
    expect(headers.get('traceparent')).toMatch(TRACEPARENT)
  })
})
