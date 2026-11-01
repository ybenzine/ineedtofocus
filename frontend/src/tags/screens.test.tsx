// Custom tags on the screens that show or pick a tag (AC7.1, AC7.2, AC7.7, AC7.8, AC10.2, #401).

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../sync/api.ts'
import { HttpArchiveApi } from '../archive/api.ts'
import ArchiveScreen from '../archive/ArchiveScreen.tsx'
import type { HistoryApi, HistoryData, HistoryQuery, HistorySession } from '../history/api.ts'
import HistoryScreen from '../history/HistoryScreen.tsx'
import { emptyData, mergeSessions, periodFor } from '../history/model.ts'
import { DEFAULT_PREFERENCES, MemoryPreferencesStore } from '../setup/preferences.ts'
import SessionSetup, { type SessionRequest } from '../setup/SessionSetup.tsx'
import { HttpSessionsApi } from '../sync/api.ts'
import { IndexedDbSessionStore } from '../sync/sessionStore.ts'
import { FakeSessionsServer, freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import { FakeTagsApi } from '../test/fakeTagsApi.ts'
import { closeSheet, openSheet, pickTag } from '../test/setupUi.ts'
import SessionSummary from '../timerscreen/SessionSummary.tsx'
import TimerScreen from '../timerscreen/TimerScreen.tsx'
import {
  ACTIVE_SESSION_KEY,
  LocalActiveSessionStore,
  MemoryActiveSessionStore,
  TimerController,
} from '../timer/index.ts'
import { TagsContext } from './context.ts'
import { TagsStore } from './store.ts'

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0)

/** A tags store holding the fake API's tags, as after a settings load. */
async function loaded(api: FakeTagsApi) {
  const store = new TagsStore({ api, owner: 'u1' })
  await store.refresh()
  return store
}

function withTags(store: TagsStore, ui: ReactElement) {
  return <TagsContext.Provider value={store}>{ui}</TagsContext.Provider>
}

const dotsIn = (el: HTMLElement) => [...el.querySelectorAll('.tag-dot')]

afterEach(() => vi.restoreAllMocks())

describe('the setup picker (AC7.1, AC7.2, AC7.7)', () => {
  async function setup(api: FakeTagsApi, tag = 'work') {
    const store = await loaded(api)
    const onStart = vi.fn<(request: SessionRequest) => void>()
    render(
      withTags(
        store,
        <SessionSetup
          preferences={new MemoryPreferencesStore({ ...DEFAULT_PREFERENCES, tag })}
          onStart={onStart}
        />,
      ),
    )
    return { onStart, store }
  }

  it('shows the six built-in tags, then the custom tags in use, each with its dot', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work', 'teal')
    api.add('Old', 'red', true)
    api.add('Writing', 'yellow')
    await setup(api)
    openSheet('Tag')
    const group = screen.getByRole('group', { name: 'Tag' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['Work', 'Study', 'Nap', 'Read', 'Meditation', 'Exercise', 'Deep work', 'Writing'])
    expect(dotsIn(group)).toHaveLength(8)
    expect(group.querySelector('.tag-dot-teal')).not.toBeNull()
    expect(within(group).getByRole('radio', { name: 'Work' })).toBeChecked()
  })

  it('starts a session with a custom tag by its id', async () => {
    const api = new FakeTagsApi()
    const deep = api.add('Deep work', 'teal')
    const { onStart } = await setup(api)
    pickTag('Deep work')
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].tag).toBe(deep.id)
  })

  it('starts on the last-used custom tag', async () => {
    const api = new FakeTagsApi()
    const deep = api.add('Deep work', 'teal')
    await setup(api, deep.id)
    expect(screen.getByRole('button', { name: /^Tag\b.*Deep work/ })).toBeInTheDocument()
    openSheet('Tag')
    expect(screen.getByRole('radio', { name: 'Deep work' })).toBeChecked()
  })

  it('starts on Work when the last-used tag was removed (AC7.2, AC7.7)', async () => {
    const api = new FakeTagsApi()
    const gone = api.add('Gone', 'red', true)
    const { onStart } = await setup(api, gone.id)
    openSheet('Tag')
    expect(screen.queryByRole('radio', { name: 'Gone' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Work' })).toBeChecked()
    closeSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].tag).toBe('work')
  })

  it('offers only the six built-in tags without an account', () => {
    render(
      <SessionSetup
        preferences={new MemoryPreferencesStore()}
        onStart={vi.fn<(request: SessionRequest) => void>()}
      />,
    )
    openSheet('Tag')
    expect(within(screen.getByRole('group', { name: 'Tag' })).getAllByRole('radio')).toHaveLength(6)
    expect(screen.queryByRole('link', { name: 'Manage tags' })).not.toBeInTheDocument()
  })
})

describe('History (AC7.7, AC7.8, AC10.2)', () => {
  const session = (overrides: Partial<HistorySession>): HistorySession => ({
    id: crypto.randomUUID(),
    mode: 'countdown',
    tag: 'work',
    goal: null,
    startedAt: '2026-11-01T08:00:00Z',
    focusSeconds: 1500,
    status: 'completed',
    indicator: 'synced',
    ...overrides,
  })

  class FakeHistory implements HistoryApi {
    queries: HistoryQuery[] = []
    sessions: HistorySession[] = []
    async get(query: HistoryQuery): Promise<ApiResult<HistoryData>> {
      this.queries.push(query)
      const base = emptyData(query.view, 'UTC', 1, periodFor('day', query.date ?? '', 1))
      const wanted = this.sessions.filter(
        (s) => query.tags.length === 0 || query.tags.includes(s.tag),
      )
      return { kind: 'ok', value: mergeSessions(base, wanted, []) }
    }
  }

  async function show(api: FakeTagsApi, history: FakeHistory) {
    const store = await loaded(api)
    render(
      withTags(
        store,
        <HistoryScreen api={history} timeZone="UTC" now={() => NOW} ownerId="me" sessions={null} />,
      ),
    )
    await screen.findByRole('heading', { name: 'By tag' })
  }

  it('lists built-in tags, then tags in use, then removed ones marked "(removed)", with dots', async () => {
    const api = new FakeTagsApi()
    const deep = api.add('Deep work', 'teal')
    const old = api.add('Old', 'red', true)
    const history = new FakeHistory()
    history.sessions = [session({ tag: deep.id }), session({ tag: old.id })]
    await show(api, history)
    const filter = screen.getByRole('group', { name: 'Tags' })
    expect(
      within(filter)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'All tags',
      'Work',
      'Study',
      'Nap',
      'Read',
      'Meditation',
      'Exercise',
      'Deep work',
      'Old (removed)',
    ])
    expect(dotsIn(filter)).toHaveLength(8)
    expect(filter.querySelector('.tag-dot-red')).not.toBeNull()
  })

  it('sends selected custom tags as their ids, and "All tags" clears them', async () => {
    const api = new FakeTagsApi()
    const deep = api.add('Deep work', 'teal')
    const old = api.add('Old', 'red', true)
    const history = new FakeHistory()
    history.sessions = [session({ tag: deep.id }), session({ tag: old.id })]
    await show(api, history)
    fireEvent.click(screen.getByRole('button', { name: 'Deep work' }))
    fireEvent.click(screen.getByRole('button', { name: 'Old (removed)' }))
    await waitFor(() => expect(history.queries.at(-1)?.tags).toEqual([deep.id, old.id]))
    fireEvent.click(screen.getByRole('button', { name: 'All tags' }))
    await waitFor(() => expect(history.queries.at(-1)?.tags).toEqual([]))
  })

  it('shows a session with a removed tag by its name and colour (AC7.7)', async () => {
    const api = new FakeTagsApi()
    const old = api.add('Old', 'red', true)
    const history = new FakeHistory()
    history.sessions = [session({ tag: old.id })]
    await show(api, history)
    const row = document.querySelector('.history-row') as HTMLElement
    expect(within(row).getByText('Old')).toBeInTheDocument()
    expect(row.querySelector('.tag-dot-red')).not.toBeNull()
  })

  it('shows a tag this device does not know as "Tag" with no dot, and still renders', async () => {
    const history = new FakeHistory()
    history.sessions = [session({ tag: '9d3c7e0a-0000-4000-8000-000000000999' })]
    await show(new FakeTagsApi(), history)
    const row = document.querySelector('.history-row') as HTMLElement
    expect(within(row).getByText('Tag')).toBeInTheDocument()
    expect(dotsIn(row)).toHaveLength(0)
    const list = document.querySelector('.history-tag-list') as HTMLElement
    expect(within(list).getByText('Tag')).toBeInTheDocument()
  })

  it('keeps the breakdown most focus first, with ties in the AC7.8 order', async () => {
    const api = new FakeTagsApi()
    const a = api.add('Alpha', 'teal')
    const b = api.add('Beta', 'red')
    const history = new FakeHistory()
    history.sessions = [
      session({ tag: b.id, focusSeconds: 600 }),
      session({ tag: a.id, focusSeconds: 600 }),
      session({ tag: 'nap', focusSeconds: 600 }),
      session({ tag: 'read', focusSeconds: 3600 }),
    ]
    await show(api, history)
    const items = [...document.querySelectorAll('.history-tag-list li')]
    expect(items.map((li) => li.querySelector('.tag-name-text')?.textContent)).toEqual([
      'Read',
      'Nap',
      'Alpha',
      'Beta',
    ])
    expect(dotsIn(document.querySelector('.history-tag-list') as HTMLElement)).toHaveLength(4)
  })

  it('names the tags in the edit form with no dots, and lists a removed tag only while it is the session’s', async () => {
    const api = new FakeTagsApi()
    const deep = api.add('Deep work', 'teal')
    const old = api.add('Old', 'red', true)
    const history = new FakeHistory()
    history.sessions = [session({ tag: old.id })]
    await show(api, history)
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }))
    const select = screen.getByLabelText('Tag')
    expect(select).toHaveValue(old.id)
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Work', 'Study', 'Nap', 'Read', 'Meditation', 'Exercise', 'Deep work', 'Old'])
    expect(select.querySelector('.tag-dot')).toBeNull()
    fireEvent.change(select, { target: { value: deep.id } })
    expect(within(select).queryByRole('option', { name: 'Old' })).not.toBeInTheDocument()
    expect(select).toHaveValue(deep.id)
  })

  it('shows unsynced device sessions with their custom tag and in the same order', async () => {
    const api = new FakeTagsApi()
    const deep = api.add('Deep work', 'teal')
    const store = await loaded(api)
    const sessions = new IndexedDbSessionStore({ name: freshDbName() })
    await sessions.save(
      makeRecord({
        tag: deep.id,
        startedAt: '2026-11-01T09:00:00Z',
        endedAt: '2026-11-01T09:25:00Z',
      }),
      'me',
    )
    render(
      withTags(
        store,
        <HistoryScreen
          api={new FakeHistory()}
          timeZone="UTC"
          now={() => NOW}
          ownerId="me"
          sessions={sessions}
        />,
      ),
    )
    const row = await waitFor(() => {
      const r = document.querySelector('.history-row')
      expect(r).not.toBeNull()
      return r as HTMLElement
    })
    expect(within(row).getByText('Deep work')).toBeInTheDocument()
    expect(row.querySelector('.tag-dot-teal')).not.toBeNull()
    sessions.close()
  })
})

describe('Archive, timer and summary (AC7.8)', () => {
  it('shows a custom tag with its dot on an archived session', async () => {
    const api = new FakeTagsApi()
    const deep = api.add('Deep work', 'teal')
    const store = await loaded(api)
    const server = new FakeSessionsServer()
    const sessions = new IndexedDbSessionStore({ name: freshDbName() })
    const record = makeRecord({ tag: deep.id, goal: 'Chapter' })
    await new HttpSessionsApi({ fetch: server.fetch }).sync([record])
    server.archive(record.id)
    render(
      withTags(
        store,
        <ArchiveScreen
          api={new HttpArchiveApi({ fetch: server.fetch })}
          sessions={sessions}
          ownerId="me"
          timeZone="UTC"
        />,
      ),
    )
    expect(await screen.findByText('Deep work')).toBeInTheDocument()
    expect(document.querySelector('.tag-dot-teal')).not.toBeNull()
    sessions.close()
  })

  it('shows the tag and its dot on the summary', async () => {
    const api = new FakeTagsApi()
    const deep = api.add('Deep work', 'teal')
    const store = await loaded(api)
    render(
      withTags(
        store,
        <SessionSummary
          outcome={{ kind: 'saved', record: makeRecord({ tag: deep.id }) }}
          onNewSession={vi.fn()}
        />,
      ),
    )
    expect(screen.getByText('Deep work')).toBeInTheDocument()
    expect(document.querySelector('.tag-dot-teal')).not.toBeNull()
  })

  it('shows the tag and its dot on the timer screen', async () => {
    const api = new FakeTagsApi()
    const deep = api.add('Deep work', 'teal')
    const store = await loaded(api)
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: vi.fn(),
    })
    await controller.start({
      config: { mode: 'unlimited', reminderMinutes: null },
      tag: deep.id,
      goal: null,
    })
    await act(async () => {
      render(
        withTags(
          store,
          <TimerScreen controller={controller} audio="none" onEnded={vi.fn()} onEvents={vi.fn()} />,
        ),
      )
    })
    expect(screen.getByText('Deep work')).toBeInTheDocument()
    expect(document.querySelector('.tag-dot-teal')).not.toBeNull()
  })

  it('a running session with a custom tag survives a reload (AC6.4)', async () => {
    localStorage.clear()
    const id = '6f1c2d0e-0000-4000-8000-000000000001'
    const first = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: vi.fn(),
    })
    await first.start({ config: { mode: 'unlimited', reminderMinutes: null }, tag: id, goal: 'x' })
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toContain(id)
    const second = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: vi.fn(),
    })
    const restored = await second.restore()
    expect(restored.snapshot?.tag).toBe(id)
    localStorage.clear()
  })

  it('the device session store keeps a custom tag id', async () => {
    const sessions = new IndexedDbSessionStore({ name: freshDbName() })
    const id = '6f1c2d0e-0000-4000-8000-000000000001'
    const record = makeRecord({ tag: id })
    await sessions.save(record, 'me')
    expect((await sessions.list('me'))[0]?.record.tag).toBe(id)
    sessions.close()
  })
})
