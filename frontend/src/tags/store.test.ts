import { describe, expect, it, vi } from 'vitest'
import { FakeTagsApi } from '../test/fakeTagsApi.ts'
import { TagsError } from './api.ts'
import { TAGS_KEY, TagsStore } from './store.ts'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

function store(api: FakeTagsApi, storage = memoryStorage(), owner: string | null = 'u1') {
  return { store: new TagsStore({ api, storage, owner }), storage }
}

describe('TagsStore (AC7.6, #401)', () => {
  it('loads the list on refresh and caches it under the account', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work', 'teal')
    api.add('Old', 'red', true)
    const { store: s, storage } = store(api)
    await s.refresh()
    expect(s.getState().tags.map((t) => t.name)).toEqual(['Deep work', 'Old'])
    const cached = JSON.parse(storage.getItem(TAGS_KEY) ?? '{}') as { owner: string }
    expect(cached.owner).toBe('u1')
  })

  it('opens from the cache of the same account', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    const first = store(api)
    await first.store.refresh()
    const again = new TagsStore({ storage: first.storage, owner: 'u1' })
    expect(again.getState().tags.map((t) => t.name)).toEqual(['Deep work'])
  })

  it("never uses another account's cache", async () => {
    const api = new FakeTagsApi()
    api.add('Private')
    const first = store(api)
    await first.store.refresh()
    const other = new TagsStore({ storage: first.storage, owner: 'u2' })
    expect(other.getState().tags).toEqual([])
    expect(new TagsStore({ storage: first.storage, owner: null }).getState().tags).toEqual([])
  })

  it('keeps the device copy when the server cannot be reached', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    const { store: s } = store(api)
    await s.refresh()
    api.failWith = new TagsError('network', 'offline')
    await s.refresh()
    expect(s.getState().tags.map((t) => t.name)).toEqual(['Deep work'])
  })

  it('changes the list only with the server answer', async () => {
    const api = new FakeTagsApi()
    const { store: s } = store(api)
    const { tag } = await s.create('Deep work', 'teal')
    expect(s.getState().tags).toHaveLength(1)
    await s.update(tag.id, { name: 'Writing' })
    expect(s.getState().tags[0]?.name).toBe('Writing')
    await s.remove(tag.id)
    expect(s.getState().tags[0]?.removedAt).not.toBeNull()
    api.failWith = new TagsError('server', 'down')
    await expect(s.update(tag.id, { name: 'Other' })).rejects.toMatchObject({ kind: 'server' })
    expect(s.getState().tags[0]?.name).toBe('Writing')
  })

  it('brings a removed tag back with its id', async () => {
    const api = new FakeTagsApi()
    const { store: s } = store(api)
    const { tag } = await s.create('Deep work', 'teal')
    await s.remove(tag.id)
    const back = await s.create('deep work', 'red')
    expect(back.restored).toBe(true)
    expect(s.getState().tags).toHaveLength(1)
    expect(s.getState().tags[0]).toMatchObject({ id: tag.id, name: 'Deep work', color: 'red' })
  })

  it('reports an expired sign-in through onUnauthorized', async () => {
    const api = new FakeTagsApi()
    api.failWith = new TagsError('unauthorized', 'no')
    const onUnauthorized = vi.fn()
    const s = new TagsStore({ api, owner: 'u1', onUnauthorized })
    await s.refresh()
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('stops for good once another user is signed in or it is disposed', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    let current: string | null = 'u1'
    const s = new TagsStore({ api, owner: 'u1', currentOwner: () => current })
    current = 'u2'
    await s.refresh()
    expect(api.calls).toEqual([])
    const t = new TagsStore({ api, owner: 'u1' })
    t.dispose()
    await t.refresh()
    expect(api.calls).toEqual([])
  })

  it("follows another tab's change to the cache", async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    const tab1 = store(api)
    await tab1.store.refresh()
    const stop = tab1.store.start()
    const tab2 = new TagsStore({ api, storage: tab1.storage, owner: 'u1' })
    await tab2.create('Writing', 'red')
    window.dispatchEvent(new StorageEvent('storage', { key: TAGS_KEY }))
    expect(tab1.store.getState().tags.map((t) => t.name)).toEqual(['Deep work', 'Writing'])
    stop()
  })

  it('makes no request without an API (no account)', async () => {
    const s = new TagsStore()
    await s.refresh()
    expect(s.canChange).toBe(false)
    await expect(s.create('x', 'red')).rejects.toBeInstanceOf(TagsError)
  })
})
