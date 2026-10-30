// YouTube chosen on New session (#325): the link field, the recent links, the Start gate and what
// Start does with the link.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App.tsx'
import { MemoryPreferencesStore } from '../setup/preferences.ts'
import SessionSetup, { type SessionRequest } from '../setup/SessionSetup.tsx'
import { MemoryActiveSessionStore, TimerController } from '../timer/index.ts'
import { MemoryAudioSourceStore, MemoryYoutubeLinkStore } from './audioSource.ts'
import { MemoryBackgroundVolumeStore, RainPlayer } from './rain.ts'
import type { RecentLink } from './youtubeLinksApi.ts'
import { INVALID_LINK_MESSAGE, NO_ID_MESSAGE } from './youtubeRecent.ts'
import type { YtNamespace, YtPlayerOptions } from './ytApi.ts'

const URL1 = 'https://youtu.be/dQw4w9WgXcQ'
const LONG_TITLE = 'Lofi hip hop radio - beats to relax and study to'

function fakeApi(links: RecentLink[] = []) {
  return {
    list: vi.fn(async () => links),
    use: vi.fn(async (url: string, title?: string) => [{ url, title: title ?? null }]),
  }
}

const pickYoutube = () => fireEvent.click(screen.getByRole('radio', { name: 'YouTube' }))
const start = () => screen.getByRole('button', { name: 'Start' })
const typeLink = (value: string) =>
  fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value } })

afterEach(() => vi.restoreAllMocks())

describe('SessionSetup with YouTube', () => {
  function setup(links: RecentLink[] = []) {
    const onStart = vi.fn<(request: SessionRequest) => void>()
    const api = fakeApi(links)
    render(
      <SessionSetup
        preferences={new MemoryPreferencesStore()}
        onStart={onStart}
        youtubeApi={api}
      />,
    )
    return { onStart, api }
  }

  it('shows no link field until YouTube is picked', () => {
    setup()
    expect(screen.queryByLabelText('YouTube link')).not.toBeInTheDocument()
    pickYoutube()
    expect(screen.getByLabelText('YouTube link')).toBeInTheDocument()
  })

  it('keeps Start disabled, with a hint that says why, until the link will play', () => {
    setup()
    pickYoutube()
    expect(start()).toBeDisabled()
    expect(start()).toHaveAccessibleDescription(/Paste a YouTube link/)
    typeLink('https://example.com/watch?v=dQw4w9WgXcQ')
    expect(start()).toBeDisabled()
    typeLink(URL1)
    expect(start()).toBeEnabled()
    expect(start()).not.toHaveAttribute('aria-describedby')
  })

  it('shows the timer screen messages for a bad link once the field is left', () => {
    setup()
    pickYoutube()
    typeLink('https://example.com/x')
    expect(screen.queryByText(INVALID_LINK_MESSAGE)).not.toBeInTheDocument()
    fireEvent.blur(screen.getByLabelText('YouTube link'))
    expect(screen.getByText(INVALID_LINK_MESSAGE)).toBeInTheDocument()
    expect(screen.getByLabelText('YouTube link')).toHaveAttribute('aria-invalid', 'true')
    typeLink('https://www.youtube.com/')
    fireEvent.blur(screen.getByLabelText('YouTube link'))
    expect(screen.getByText(NO_ID_MESSAGE)).toBeInTheDocument()
    expect(start()).toBeDisabled()
  })

  it('does not gate Start on a link when YouTube is not picked', () => {
    setup()
    pickYoutube()
    expect(start()).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Rain' }))
    expect(start()).toBeEnabled()
  })

  it('lists the recent links with their titles and starts with the one tapped', async () => {
    const { onStart } = setup([
      { url: URL1, title: LONG_TITLE },
      { url: 'https://youtu.be/aqz-KE-bpKQ', title: null },
    ])
    pickYoutube()
    const long = await screen.findByRole('button', { name: LONG_TITLE })
    expect(screen.getByRole('button', { name: 'YouTube video' })).toBeInTheDocument()
    expect(long).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(long)
    expect(long).toHaveAttribute('aria-pressed', 'true')
    expect(start()).toBeEnabled()
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0]).toMatchObject({ audio: 'youtube', youtubeLink: URL1 })
  })

  it('starts with a pasted link and passes the normalised url', async () => {
    const { onStart } = setup()
    pickYoutube()
    typeLink('youtu.be/dQw4w9WgXcQ')
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].youtubeLink).toBe('https://youtu.be/dQw4w9WgXcQ')
  })

  it('offline: suggests Rain and still gates Start on a link', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    setup()
    pickYoutube()
    expect(screen.getByRole('button', { name: 'Use Rain instead' })).toBeInTheDocument()
    expect(start()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Use Rain instead' }))
    expect(screen.getByRole('radio', { name: 'Rain' })).toBeChecked()
    expect(start()).toBeEnabled()
  })

  it('marks the form dirty once a link is typed', () => {
    setup()
    pickYoutube()
    expect(document.querySelector('form')).toHaveAttribute('data-holds-update')
  })
})

describe('App starting a session with a YouTube link', () => {
  function fakeYoutube() {
    const options: YtPlayerOptions[] = []
    function Player(_mount: HTMLElement, o: YtPlayerOptions) {
      options.push(o)
      return {
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        stopVideo: vi.fn(),
        seekTo: vi.fn(),
        setVolume: vi.fn(),
        setLoop: vi.fn(),
        nextVideo: vi.fn(),
        getPlaylistIndex: vi.fn(),
        getVideoData: vi.fn(() => ({ title: 'A title the player knows' })),
        getPlaylist: vi.fn(() => null),
        destroy: vi.fn(),
      }
    }
    return { options, loadApi: vi.fn(async () => ({ Player }) as unknown as YtNamespace) }
  }

  function app(
    store: MemoryActiveSessionStore,
    audioStore: MemoryAudioSourceStore,
    linkStore: MemoryYoutubeLinkStore,
    api = fakeApi(),
  ) {
    const fake = fakeYoutube()
    const controller = new TimerController({ store, saveRecord: () => undefined })
    const rain = new RainPlayer({
      alerts: { audioContext: () => null },
      volume: new MemoryBackgroundVolumeStore(),
    })
    const view = render(
      <App
        controller={controller}
        preferences={new MemoryPreferencesStore()}
        rain={rain}
        audioStore={audioStore}
        youtube={{ linkStore, api, loadApi: fake.loadApi }}
      />,
    )
    return { ...fake, api, view }
  }

  it('plays the chosen link, marks it used and keeps it across a reload', async () => {
    const store = new MemoryActiveSessionStore()
    const audioStore = new MemoryAudioSourceStore()
    const linkStore = new MemoryYoutubeLinkStore()
    const first = app(store, audioStore, linkStore)
    await screen.findByRole('radio', { name: 'YouTube' })
    pickYoutube()
    await screen.findByLabelText('YouTube link')
    typeLink(URL1)
    fireEvent.click(start())
    await screen.findByRole('timer')

    expect(linkStore.load()).toBe(URL1)
    expect(first.api.use).toHaveBeenCalledWith(URL1)
    await waitFor(() => expect(first.options).toHaveLength(1))
    expect(screen.getByRole('region', { name: 'Background audio' })).toBeInTheDocument()
    // The title learned by the player is still sent with the link (#326).
    await act(async () => first.options[0].events.onReady())
    await waitFor(() =>
      expect(first.api.use).toHaveBeenCalledWith(URL1, 'A title the player knows'),
    )

    first.view.unmount()
    const second = app(store, audioStore, linkStore)
    await screen.findByRole('timer')
    await waitFor(() => expect(second.options).toHaveLength(1))
    expect(linkStore.load()).toBe(URL1)
  })

  it('does not touch the link store when starting without YouTube', async () => {
    const linkStore = new MemoryYoutubeLinkStore()
    const { api } = app(new MemoryActiveSessionStore(), new MemoryAudioSourceStore(), linkStore)
    fireEvent.click(await screen.findByRole('radio', { name: 'Rain' }))
    fireEvent.click(start())
    await screen.findByRole('timer')
    expect(linkStore.load()).toBeNull()
    expect(api.use).not.toHaveBeenCalled()
  })
})
