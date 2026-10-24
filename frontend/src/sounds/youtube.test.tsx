import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsContext } from '../settings/SettingsContext.ts'
import { SettingsStore } from '../settings/store.ts'
import AudioControls from './AudioControls.tsx'
import { LocalAudioSourceStore, MemoryYoutubeLinkStore, YOUTUBE_LINK_KEY } from './audioSource.ts'
import { MemoryBackgroundVolumeStore, RainPlayer } from './rain.ts'
import { httpYoutubeLinksApi } from './youtubeLinksApi.ts'
import {
  API_TIMEOUT_MS,
  PLAYER_ERROR_MESSAGE,
  PLAYER_LOAD_MESSAGE,
  YT_ENDED,
  loadYoutubeApi,
  type YtNamespace,
  type YtPlayer,
  type YtPlayerOptions,
} from './ytApi.ts'
import { INVALID_LINK_MESSAGE, NO_ID_MESSAGE } from './YoutubeControls.tsx'

const LINK_LABEL = /^(Another )?YouTube link$/
const ID = 'dQw4w9WgXcQ'
const ID2 = 'aqz-KE-bpKQ'
const LIST = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'

function fakeYoutube() {
  const players: (YtPlayer & { options: YtPlayerOptions; mount: HTMLElement })[] = []
  function Player(mount: HTMLElement, options: YtPlayerOptions) {
    const player = {
      options,
      mount,
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      stopVideo: vi.fn(),
      seekTo: vi.fn(),
      setVolume: vi.fn(),
      setLoop: vi.fn(),
      destroy: vi.fn(),
    }
    players.push(player)
    return player
  }
  const yt = { Player } as unknown as YtNamespace
  const loadApi = vi.fn(async () => yt)
  const ready = async (index = players.length - 1) => {
    await act(async () => players[index].options.events.onReady())
  }
  return { players, loadApi, ready }
}

function setup(
  options: {
    paused?: boolean
    links?: string[]
    list?: () => Promise<string[]>
    linkStore?: MemoryYoutubeLinkStore
    loadApi?: () => Promise<YtNamespace>
    settings?: SettingsStore
  } = {},
) {
  const fake = fakeYoutube()
  const api = {
    list: vi.fn(options.list ?? (async () => options.links ?? [])),
    use: vi.fn(async (url: string) => [url, ...(options.links ?? [])]),
  }
  const settings = options.settings ?? new SettingsStore()
  const rain = new RainPlayer({
    alerts: { audioContext: () => null },
    volume: new MemoryBackgroundVolumeStore(),
  })
  const linkStore = options.linkStore ?? new MemoryYoutubeLinkStore()
  const youtube = { api, linkStore, loadApi: options.loadApi ?? fake.loadApi }
  const view = (paused: boolean) => (
    <SettingsContext.Provider value={settings}>
      <AudioControls
        source="youtube"
        paused={paused}
        rain={rain}
        onSourceChange={vi.fn()}
        youtube={youtube}
      />
    </SettingsContext.Provider>
  )
  const result = render(view(options.paused ?? false))
  return {
    ...fake,
    api,
    linkStore,
    settings,
    setPaused: (paused: boolean) => result.rerender(view(paused)),
    unmount: result.unmount,
  }
}

async function paste(text: string) {
  fireEvent.change(screen.getByLabelText(LINK_LABEL), { target: { value: text } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  })
}

afterEach(() => vi.restoreAllMocks())

describe('YouTube background audio (AC8.4)', () => {
  it('plays a pasted link in a visible player that loops, built from the parsed id', async () => {
    const t = setup()
    await paste(`youtu.be/${ID}?si=tracking`)
    await waitFor(() => expect(t.players).toHaveLength(1))
    const { options } = t.players[0]
    expect(options.videoId).toBe(ID)
    expect(options.playerVars).toMatchObject({ loop: 1, playlist: ID })
    expect(options.host).toBe('https://www.youtube-nocookie.com')
    expect(JSON.stringify(options)).not.toContain('tracking')
    expect(t.api.use).toHaveBeenCalledWith(`https://youtu.be/${ID}?si=tracking`)
    expect(t.linkStore.load()).toBe(`https://youtu.be/${ID}?si=tracking`)
    // The player's container is shown, never hidden.
    expect(t.players[0].mount.parentElement).not.toHaveAttribute('hidden')
    await t.ready()
    expect(t.players[0].playVideo).toHaveBeenCalled()
  })

  it('plays a playlist and loops it', async () => {
    const t = setup()
    await paste(`https://www.youtube.com/playlist?list=${LIST}`)
    await waitFor(() => expect(t.players).toHaveLength(1))
    expect(t.players[0].options.playerVars).toMatchObject({ listType: 'playlist', list: LIST })
    expect(t.players[0].options.videoId).toBeUndefined()
    await t.ready()
    expect(t.players[0].setLoop).toHaveBeenCalledWith(true)
  })

  it('lets a playlist move on by itself when an item ends', async () => {
    const t = setup()
    await paste(`https://www.youtube.com/playlist?list=${LIST}`)
    await waitFor(() => expect(t.players).toHaveLength(1))
    await t.ready()
    t.players[0].options.events.onStateChange({ data: YT_ENDED })
    expect(t.players[0].seekTo).not.toHaveBeenCalled()
    expect(t.players[0].playVideo).toHaveBeenCalledTimes(1)
  })

  it('starts the video over when it ends while the timer runs', async () => {
    const t = setup()
    await paste(`https://youtu.be/${ID}`)
    await waitFor(() => expect(t.players).toHaveLength(1))
    await t.ready()
    t.players[0].options.events.onStateChange({ data: YT_ENDED })
    expect(t.players[0].seekTo).toHaveBeenCalledWith(0, true)
    expect(t.players[0].playVideo).toHaveBeenCalledTimes(2)
  })

  it('applies the background volume from settings and follows changes', async () => {
    const settings = new SettingsStore()
    settings.update({ background_volume: 30 })
    const t = setup({ settings })
    await paste(`https://youtu.be/${ID}`)
    await waitFor(() => expect(t.players).toHaveLength(1))
    await t.ready()
    expect(t.players[0].setVolume).toHaveBeenLastCalledWith(30)
    fireEvent.change(screen.getByLabelText('YouTube volume'), { target: { value: '70' } })
    expect(settings.values.background_volume).toBe(70)
    expect(t.players[0].setVolume).toHaveBeenLastCalledWith(70)
  })

  it('restores the link of the session after a reload', async () => {
    const linkStore = new MemoryYoutubeLinkStore()
    linkStore.save(`https://youtu.be/${ID}`)
    const t = setup({ linkStore })
    await waitFor(() => expect(t.players).toHaveLength(1))
    expect(t.players[0].options.videoId).toBe(ID)
  })
})

describe('YouTube follows the timer like rain (AC8.2)', () => {
  it('pauses with the timer, resumes, and is destroyed when the screen goes away', async () => {
    const t = setup()
    await paste(`https://youtu.be/${ID}`)
    await waitFor(() => expect(t.players).toHaveLength(1))
    await t.ready()
    t.setPaused(true)
    expect(t.players[0].pauseVideo).toHaveBeenCalled()
    t.setPaused(false)
    expect(t.players[0].playVideo).toHaveBeenCalledTimes(2)
    t.unmount()
    expect(t.players[0].destroy).toHaveBeenCalled()
  })

  it('does not start while the timer is paused', async () => {
    const t = setup({ paused: true })
    await paste(`https://youtu.be/${ID}`)
    await waitFor(() => expect(t.players).toHaveLength(1))
    await t.ready()
    expect(t.players[0].playVideo).not.toHaveBeenCalled()
  })

  it('replaces the player when another link is chosen', async () => {
    const t = setup()
    await paste(`https://youtu.be/${ID}`)
    await waitFor(() => expect(t.players).toHaveLength(1))
    await paste(`https://youtu.be/${ID2}`)
    await waitFor(() => expect(t.players).toHaveLength(2))
    expect(t.players[0].destroy).toHaveBeenCalled()
    expect(t.players[1].options.videoId).toBe(ID2)
  })
})

describe('problems leave the session alone (AC8.5)', () => {
  it('shows a message for a link that is not a YouTube link, without calling the API', async () => {
    const t = setup()
    await paste('https://vimeo.com/123')
    expect(screen.getByRole('alert')).toHaveTextContent(INVALID_LINK_MESSAGE)
    expect(t.players).toHaveLength(0)
    expect(t.api.use).not.toHaveBeenCalled()
    expect(t.linkStore.load()).toBeNull()
  })

  it('does not call a scheme-less YouTube link invalid', async () => {
    setup()
    await paste(`www.youtube.com/watch?v=${ID}`)
    expect(screen.queryByText(INVALID_LINK_MESSAGE)).not.toBeInTheDocument()
  })

  it.each([2, 5, 100, 101, 150])(
    'explains an unavailable or non-embeddable video (error %i)',
    async (code) => {
      const t = setup()
      await paste(`https://youtu.be/${ID}`)
      await waitFor(() => expect(t.players).toHaveLength(1))
      await act(async () => t.players[0].options.events.onError({ data: code }))
      expect(screen.getByRole('alert')).toHaveTextContent(PLAYER_ERROR_MESSAGE)
      // The user can try another link straight away.
      expect(screen.getByLabelText(LINK_LABEL)).toBeEnabled()
    },
  )

  it('stops and removes a player that failed, so nothing plays unseen', async () => {
    const t = setup()
    await paste(`https://youtu.be/${ID}`)
    await waitFor(() => expect(t.players).toHaveLength(1))
    await t.ready()
    await act(async () => t.players[0].options.events.onError({ data: 150 }))
    expect(t.players[0].stopVideo).toHaveBeenCalled()
    expect(t.players[0].destroy).toHaveBeenCalled()
    t.setPaused(true)
    t.setPaused(false)
    expect(t.players[0].playVideo).toHaveBeenCalledTimes(1)
  })

  it('says so when a YouTube link has no video or playlist', async () => {
    const t = setup()
    await paste('https://www.youtube.com/@channel')
    expect(screen.getByRole('alert')).toHaveTextContent(NO_ID_MESSAGE)
    expect(t.api.use).not.toHaveBeenCalled()
  })

  it('explains a player that cannot load', async () => {
    setup({ loadApi: () => Promise.reject(new Error('blocked')) })
    await paste(`https://youtu.be/${ID}`)
    expect(await screen.findByRole('alert')).toHaveTextContent(PLAYER_LOAD_MESSAGE)
  })

  it('still plays when remembering the link fails', async () => {
    const t = setup()
    t.api.use.mockRejectedValue(new Error('offline'))
    await paste(`https://youtu.be/${ID}`)
    await waitFor(() => expect(t.players).toHaveLength(1))
  })
})

describe('recent links (AC8.6)', () => {
  it('lists the saved links and plays one with a single tap', async () => {
    const t = setup({ links: [`https://youtu.be/${ID}`, `https://www.youtube.com/watch?v=${ID2}`] })
    const list = await screen.findByRole('list', { name: 'Recent YouTube links' })
    expect(list.querySelectorAll('li')).toHaveLength(2)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Video ${ID2}` }))
    })
    await waitFor(() => expect(t.players).toHaveLength(1))
    expect(t.players[0].options.videoId).toBe(ID2)
    expect(t.api.use).toHaveBeenCalledWith(`https://www.youtube.com/watch?v=${ID2}`)
  })

  it('never uses a stored string as a link target, and skips ones it cannot read', async () => {
    setup({ links: ['javascript:alert(1)', `https://youtu.be/${ID}`] })
    await screen.findByRole('button', { name: `Video ${ID}` })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(document.querySelector('a[href]')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull() // only the API builds it, from the id
  })

  it('works with no list when the API is unreachable', async () => {
    const t = setup({ list: () => Promise.reject(new Error('offline')) })
    await waitFor(() => expect(t.api.list).toHaveBeenCalled())
    await act(async () => undefined)
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getByLabelText(LINK_LABEL)).toBeInTheDocument()
  })
})

describe('a slow first fetch', () => {
  it('keeps a newer list when the first fetch finishes late', async () => {
    let finish: (urls: string[]) => void = () => undefined
    const t = setup({ list: () => new Promise<string[]>((resolve) => (finish = resolve)) })
    await paste(`https://youtu.be/${ID}`)
    await screen.findByRole('button', { name: `Video ${ID}` })
    await act(async () => finish([`https://youtu.be/${ID2}`]))
    expect(screen.queryByRole('button', { name: `Video ${ID2}` })).not.toBeInTheDocument()
    expect(t.api.use).toHaveBeenCalled()
  })
})

describe('loading the API', () => {
  it('gives up when the ready callback never fires', async () => {
    vi.useFakeTimers()
    delete window.YT
    const pending = loadYoutubeApi()
    const failure = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS)
    await failure
    vi.useRealTimers()
    document.head.querySelector('script')?.remove()
  })
})

describe('offline (AC8.7)', () => {
  it('suggests Rain instead of the player', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    setup()
    expect(screen.getByRole('button', { name: 'Use Rain instead' })).toBeInTheDocument()
    expect(screen.queryByLabelText(LINK_LABEL)).not.toBeInTheDocument()
  })
})

describe('privacy', () => {
  it('never writes a link to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    )
    const t = setup()
    t.api.use.mockRejectedValue(new Error('offline'))
    await paste('https://vimeo.com/secret-link')
    await paste(`https://youtu.be/${ID}`)
    await t.ready().catch(() => undefined)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('clears the link with the audio source when the session ends', () => {
    localStorage.setItem(YOUTUBE_LINK_KEY, `https://youtu.be/${ID}`)
    new LocalAudioSourceStore().clear()
    expect(localStorage.getItem(YOUTUBE_LINK_KEY)).toBeNull()
  })
})

describe('httpYoutubeLinksApi', () => {
  it('reads the list and posts a link as JSON', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ links: [{ url: 'https://youtu.be/x', last_used_at: 't' }] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await httpYoutubeLinksApi.list()).toEqual(['https://youtu.be/x'])
    await httpYoutubeLinksApi.use('https://youtu.be/y')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/youtube-links',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url: 'https://youtu.be/y' }),
      }),
    )
    fetchMock.mockImplementation(async () => new Response('no', { status: 401 }))
    await expect(httpYoutubeLinksApi.list()).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})
