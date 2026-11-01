// The tag list loads with the settings (AC7.6, #401).

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { DEFAULT_SETTINGS } from './settings/api.ts'
import { SettingsStore } from './settings/store.ts'
import { FakeTagsApi } from './test/fakeTagsApi.ts'
import { TagsStore } from './tags/store.ts'
import { MemoryActiveSessionStore, TimerController } from './timer/index.ts'

function controller() {
  return new TimerController({ store: new MemoryActiveSessionStore(), saveRecord: () => undefined })
}

afterEach(() => vi.restoreAllMocks())

describe('App and the tag list', () => {
  it('loads the tags whenever settings load, so the picker offers a tag made on another device', async () => {
    const tagsApi = new FakeTagsApi()
    tagsApi.add('Deep work', 'teal')
    const settings = new SettingsStore({
      api: { get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS), patch: vi.fn() },
    })
    render(
      <App
        controller={controller()}
        settings={settings}
        tags={new TagsStore({ api: tagsApi, owner: null })}
      />,
    )
    expect(await screen.findByRole('radio', { name: 'Deep work' })).toBeInTheDocument()
    expect(tagsApi.calls).toContain('list')
  })

  it('still loads the tags when settings have edits waiting to be sent', async () => {
    const tagsApi = new FakeTagsApi()
    tagsApi.add('Deep work', 'teal')
    const settings = new SettingsStore({
      api: {
        get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
        patch: vi.fn().mockRejectedValue(new Error('down')),
      },
    })
    settings.update({ alert_volume: 10 })
    render(
      <App
        controller={controller()}
        settings={settings}
        tags={new TagsStore({ api: tagsApi, owner: null })}
      />,
    )
    expect(await screen.findByRole('radio', { name: 'Deep work' })).toBeInTheDocument()
  })

  it('makes no tags request when the app is given settings and no tags store', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<App controller={controller()} settings={new SettingsStore()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument())
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
