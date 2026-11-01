import { afterEach, describe, expect, it, vi } from 'vitest'
import { TagsError, httpTagsApi } from './api.ts'

const tagJson = {
  id: '6f1c2d0e-0000-4000-8000-000000000001',
  name: 'Deep work',
  color: 'teal',
  created_at: '2026-11-01T10:00:00Z',
  removed_at: null,
}

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('httpTagsApi', () => {
  it('lists tags, removed ones included', async () => {
    respond(200, { tags: [tagJson, { ...tagJson, id: 'x', removed_at: '2026-11-02T00:00:00Z' }] })
    const tags = await httpTagsApi.list()
    expect(tags).toHaveLength(2)
    expect(tags[0]).toEqual({
      id: tagJson.id,
      name: 'Deep work',
      color: 'teal',
      createdAt: '2026-11-01T10:00:00Z',
      removedAt: null,
    })
    expect(tags[1]?.removedAt).toBe('2026-11-02T00:00:00Z')
  })

  it('skips malformed items instead of failing', async () => {
    respond(200, { tags: [tagJson, { id: 'y', name: 'No colour' }, 'nope'] })
    expect(await httpTagsApi.list()).toHaveLength(1)
  })

  it('tells a new tag (201) from one brought back (200)', async () => {
    respond(201, tagJson)
    expect((await httpTagsApi.create({ name: 'Deep work', color: 'teal' })).restored).toBe(false)
    const fetchMock = respond(200, tagJson)
    expect((await httpTagsApi.create({ name: 'deep work', color: 'teal' })).restored).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tags',
      expect.objectContaining({ method: 'POST', body: '{"name":"deep work","color":"teal"}' }),
    )
  })

  it.each(['name_taken', 'removed_name_taken', 'limit_in_use', 'limit_total', 'removed'])(
    'reads the 409 kind %s from details[0].type, not from the message',
    async (type) => {
      respond(409, {
        error: {
          code: 'conflict',
          message: 'Something unrelated',
          details: [{ field: 'name', message: 'misleading text', type }],
        },
      })
      const error = await httpTagsApi.update('abc', { name: 'x' }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(TagsError)
      expect(error).toMatchObject({ kind: 'conflict', conflict: type })
    },
  )

  it('keeps an unknown 409 type as a conflict with no kind', async () => {
    respond(409, { error: { code: 'conflict', message: 'x', details: [{ type: 'other' }] } })
    expect(await httpTagsApi.remove('abc').catch((e: unknown) => e)).toMatchObject({
      kind: 'conflict',
      conflict: undefined,
    })
  })

  it.each([
    [401, 'unauthorized'],
    [404, 'missing'],
    [422, 'invalid'],
    [500, 'server'],
  ])('maps %i to %s', async (status, kind) => {
    respond(status, { error: { code: 'x', message: 'x', details: null } })
    expect(await httpTagsApi.list().catch((e: unknown) => e)).toMatchObject({ kind })
  })

  it('maps a failed fetch to network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    expect(await httpTagsApi.list().catch((e: unknown) => e)).toMatchObject({ kind: 'network' })
  })

  it('PATCHes /api/tags/{id} and POSTs /api/tags/{id}/remove', async () => {
    const fetchMock = respond(200, tagJson)
    await httpTagsApi.update(tagJson.id, { color: 'red' })
    await httpTagsApi.remove(tagJson.id)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/tags/${tagJson.id}`,
      expect.objectContaining({ method: 'PATCH', body: '{"color":"red"}' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/tags/${tagJson.id}/remove`,
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
