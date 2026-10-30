import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsContext } from '../settings/SettingsContext.ts'
import { SettingsStore } from '../settings/store.ts'
import AudioControls from './AudioControls.tsx'
import { LocalAudioSourceStore, MemoryYoutubeLinkStore, YOUTUBE_LINK_KEY } from './audioSource.ts'
import { MemoryBackgroundVolumeStore, RainPlayer } from './rain.ts'
import { httpYoutubeLinksApi, type RecentLink } from './youtubeLinksApi.ts'
import {
  API_TIMEOUT_MS,
  PLAYER_ERROR_MESSAGE,
  PLAYER_LOAD_MESSAGE,
  YT_ENDED,
  YT_PLAYING,
  SKIPPED_ITEM_MESSAGE,
  SKIP_NOTE_MS,
  loadYoutubeApi,
  resetYoutubeApiForTests,
  type YtNamespace,
  type YtPlayer,
  type YtPlayerOptions,
} from './ytApi.ts'
import { INVALID_LINK_MESSAGE, NO_ID_MESSAGE } from './youtubeRecent.ts'

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
      nextVideo: vi.fn(),
      getPlaylistIndex: vi.fn(() => undefined as number | undefined),
      getVideoData: vi.fn(() => ({ title: '' })),
      getPlaylist: vi.fn(() => [ID, ID2, 'ccccccccccc'] as string[] | null),
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
    links?: (string | RecentLink)[]
    list?: () => Promise<RecentLink[]>
    linkStore?: MemoryYoutubeLinkStore
    loadApi?: () => Promise<YtNamespace>
    settings?: SettingsStore
  } = {},
) {
  const fake = fakeYoutube()
  const saved = (options.links ?? []).map((l) =>
    typeof l === 'string' ? { url: l, title: null } : l,
  )
  const api = {
    list: vi.fn(options.list ?? (async () => saved)),
    use: vi.fn(async (url: string, title?: string) => [{ url, title: title ?? null }, ...saved]),
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

afterEach(() => {
  vi.restoreAllMocks()
  resetYoutubeApiForTests()
  delete window.YT
  delete window.onYouTubeIframeAPIReady
})

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
    expect(t.api.use).toHaveBeenCalledWith(`https://youtu.be/${ID}?si=tracking`, undefined)
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

  describe('a playlist skips unplayable items (#203)', () => {
    async function playlist() {
      const t = setup()
      await paste(`https://www.youtube.com/playlist?list=${LIST}`)
      await waitFor(() => expect(t.players).toHaveLength(1))
      await t.ready()
      const { events } = t.players[0].options
      return { t, events, p: t.players[0] }
    }

    it.each([100, 101, 150])('skips an item with error %i and says so', async (code) => {
      const { events, p } = await playlist()
      await act(async () => events.onStateChange({ data: YT_PLAYING }))
      await act(async () => events.onError({ data: code }))
      expect(p.nextVideo).toHaveBeenCalledTimes(1)
      expect(p.destroy).not.toHaveBeenCalled()
      expect(screen.getByRole('status')).toHaveTextContent(SKIPPED_ITEM_MESSAGE)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('shows the note for about 5 s, then clears it, and not past a new link', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const { events } = await playlist()
        await act(async () => events.onStateChange({ data: YT_PLAYING }))
        await act(async () => events.onError({ data: 150 }))
        expect(screen.getByRole('status')).toHaveTextContent(SKIPPED_ITEM_MESSAGE)
        await act(async () => vi.advanceTimersByTime(SKIP_NOTE_MS - 100))
        expect(screen.getByRole('status')).toHaveTextContent(SKIPPED_ITEM_MESSAGE)
        await act(async () => vi.advanceTimersByTime(200))
        expect(screen.getByRole('status')).toBeEmptyDOMElement()
        // The same container carries every later note.
        await act(async () => events.onError({ data: 150 }))
        expect(screen.getByRole('status')).toHaveTextContent(SKIPPED_ITEM_MESSAGE)
      } finally {
        vi.useRealTimers()
      }
    })

    it('clears the note timer when the screen goes away', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const { t, events } = await playlist()
        await act(async () => events.onStateChange({ data: YT_PLAYING }))
        await act(async () => events.onError({ data: 150 }))
        expect(vi.getTimerCount()).toBeGreaterThan(0)
        const before = vi.getTimerCount()
        t.unmount()
        expect(vi.getTimerCount()).toBeLessThan(before)
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps going past the last item: the wrap is left to the looping player', async () => {
      const { events, p } = await playlist()
      await act(async () => events.onStateChange({ data: YT_PLAYING }))
      vi.mocked(p.getPlaylistIndex).mockReturnValue(2) // the last of 3
      await act(async () => events.onError({ data: 150 }))
      expect(p.nextVideo).toHaveBeenCalledTimes(1)
      expect(p.destroy).not.toHaveBeenCalled()
      expect(p.setLoop).toHaveBeenCalledWith(true)
    })

    it('does not skip twice for the same item', async () => {
      const { events, p } = await playlist()
      await act(async () => events.onStateChange({ data: YT_PLAYING }))
      vi.mocked(p.getPlaylistIndex).mockReturnValue(1)
      await act(async () => events.onError({ data: 150 }))
      await act(async () => events.onError({ data: 150 }))
      expect(p.nextVideo).toHaveBeenCalledTimes(1)
      expect(p.destroy).not.toHaveBeenCalled()
    })

    it('removes the player after as many errors in a row as items, playing nothing between', async () => {
      const { events, p } = await playlist()
      await act(async () => events.onStateChange({ data: YT_PLAYING }))
      await act(async () => events.onError({ data: 150 }))
      await act(async () => events.onError({ data: 101 }))
      expect(p.destroy).not.toHaveBeenCalled()
      await act(async () => events.onError({ data: 100 }))
      expect(p.nextVideo).toHaveBeenCalledTimes(2)
      expect(p.stopVideo).toHaveBeenCalled()
      expect(p.destroy).toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent(PLAYER_ERROR_MESSAGE)
    })

    it('counts a played item as a break in the run of errors', async () => {
      const { events, p } = await playlist()
      await act(async () => events.onStateChange({ data: YT_PLAYING }))
      for (let i = 0; i < 4; i++) {
        await act(async () => events.onError({ data: 150 }))
        await act(async () => events.onStateChange({ data: YT_PLAYING }))
      }
      expect(p.nextVideo).toHaveBeenCalledTimes(4)
      expect(p.destroy).not.toHaveBeenCalled()
    })

    it('assumes 3 items when the length is unknown', async () => {
      const { events, p } = await playlist()
      vi.mocked(p.getPlaylist).mockReturnValue(null)
      await act(async () => events.onStateChange({ data: YT_PLAYING }))
      await act(async () => events.onError({ data: 150 }))
      await act(async () => events.onError({ data: 150 }))
      expect(p.destroy).not.toHaveBeenCalled()
      await act(async () => events.onError({ data: 150 }))
      expect(p.destroy).toHaveBeenCalled()
    })

    it('removes the player on an error before anything played', async () => {
      const a = await playlist()
      await act(async () => a.events.onError({ data: 150 }))
      expect(a.p.nextVideo).not.toHaveBeenCalled()
      expect(a.p.destroy).toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent(PLAYER_ERROR_MESSAGE)
    })

    it('removes the player on error 2 even after playing', async () => {
      const { events, p } = await playlist()
      await act(async () => events.onStateChange({ data: YT_PLAYING }))
      await act(async () => events.onError({ data: 2 }))
      expect(p.nextVideo).not.toHaveBeenCalled()
      expect(p.destroy).toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent(PLAYER_ERROR_MESSAGE)
    })

    it('leaves a single video as it was: any error removes the player', async () => {
      const t = setup()
      await paste(`https://youtu.be/${ID}`)
      await waitFor(() => expect(t.players).toHaveLength(1))
      await t.ready()
      await act(async () => t.players[0].options.events.onStateChange({ data: YT_PLAYING }))
      await act(async () => t.players[0].options.events.onError({ data: 150 }))
      expect(t.players[0].nextVideo).not.toHaveBeenCalled()
      expect(t.players[0].destroy).toHaveBeenCalled()
    })
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

function videoData(player: YtPlayer) {
  return vi.mocked(player.getVideoData as NonNullable<YtPlayer['getVideoData']>)
}

function nowPlaying(): HTMLElement {
  return document.querySelector('.youtube-now-playing') as HTMLElement
}

describe('titles (#326)', () => {
  const URL = `https://youtu.be/${ID}`

  it('shows the player title next to the icon, and sends it once', async () => {
    const t = setup()
    await paste(URL)
    await waitFor(() => expect(t.players).toHaveLength(1))
    expect(within(nowPlaying()).getByText('YouTube video')).toBeInTheDocument() // until it is known
    videoData(t.players[0]).mockReturnValue({ title: 'Quiet piano for focus' })
    await t.ready()
    expect(within(nowPlaying()).getByTitle('Quiet piano for focus')).toBeInTheDocument()
    expect(t.api.use).toHaveBeenLastCalledWith(URL, 'Quiet piano for focus')
    // The same title again is not sent again.
    await act(async () => t.players[0].options.events.onStateChange({ data: 1 }))
    expect(t.api.use).toHaveBeenCalledTimes(2)
  })

  it('reads the title when the video starts, and follows a playlist', async () => {
    const t = setup()
    await paste(`https://www.youtube.com/playlist?list=${LIST}`)
    await waitFor(() => expect(t.players).toHaveLength(1))
    await t.ready()
    expect(within(nowPlaying()).getByText('YouTube playlist')).toBeInTheDocument()
    expect(t.api.use).toHaveBeenCalledTimes(1)
    const data = videoData(t.players[0])
    data.mockReturnValue({ title: 'First song' })
    await act(async () => t.players[0].options.events.onStateChange({ data: 1 }))
    expect(within(nowPlaying()).getByTitle('First song')).toBeInTheDocument()
    data.mockReturnValue({ title: 'Second song' })
    await act(async () => t.players[0].options.events.onStateChange({ data: 1 }))
    expect(within(nowPlaying()).getByTitle('Second song')).toBeInTheDocument()
    expect(t.api.use).toHaveBeenLastCalledWith(
      `https://www.youtube.com/playlist?list=${LIST}`,
      'Second song',
    )
  })

  it('shows the saved title for the link before it plays again', async () => {
    const linkStore = new MemoryYoutubeLinkStore()
    linkStore.save(URL)
    setup({ linkStore, links: [{ url: URL, title: 'Saved title' }] })
    await waitFor(() => expect(screen.getAllByTitle('Saved title')).toHaveLength(1)) // now playing only: not again in the recent list (#359)
  })

  it('keeps the fallback when the player cannot say or throws', async () => {
    const t = setup()
    await paste(URL)
    await waitFor(() => expect(t.players).toHaveLength(1))
    videoData(t.players[0]).mockImplementation(() => {
      throw new Error('not ready')
    })
    await t.ready()
    expect(within(nowPlaying()).getByText('YouTube video')).toBeInTheDocument()
    expect(t.api.use).toHaveBeenCalledTimes(1)
  })
})

describe('recent links (AC8.6)', () => {
  it('lists the saved links and plays one with a single tap', async () => {
    const t = setup({
      links: [
        { url: `https://youtu.be/${ID}`, title: 'First one' },
        { url: `https://www.youtube.com/watch?v=${ID2}`, title: 'Second one' },
      ],
    })
    const list = await screen.findByRole('list', { name: 'Recent YouTube links' })
    expect(list.querySelectorAll('li')).toHaveLength(2)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Second one' }))
    })
    await waitFor(() => expect(t.players).toHaveLength(1))
    expect(t.players[0].options.videoId).toBe(ID2)
    expect(t.api.use).toHaveBeenCalledWith(`https://www.youtube.com/watch?v=${ID2}`, undefined)
  })

  it('shows each video or playlist once, keeping the newest entry (#249)', async () => {
    setup({
      links: [
        { url: `https://youtu.be/${ID}?t=5`, title: 'Newest' },
        `https://www.youtube.com/watch?v=${ID2}`,
        `https://www.youtube.com/watch?v=${ID}&list=${LIST}`,
        `https://www.youtube.com/playlist?list=${LIST}`,
        `https://youtu.be/${ID2}`,
      ],
    })
    await screen.findByRole('button', { name: 'Newest' })
    const names = screen.getAllByRole('button').filter((b) => /^YouTube /.test(b.textContent ?? ''))
    expect(names.map((b) => b.textContent)).toEqual(['YouTube video', 'YouTube playlist'])
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('shows an icon and the title, or a generic name, never the id (#326)', async () => {
    setup({
      links: [
        { url: `https://youtu.be/${ID}`, title: 'Rain on a tin roof' },
        `https://youtu.be/${ID2}`,
      ],
    })
    const titled = await screen.findByRole('button', { name: 'Rain on a tin roof' })
    // The audio card shows the YouTube mark once, in its header, not on each link (#359).
    expect(titled.querySelector('svg')).toBeNull()
    screen.getByRole('button', { name: 'YouTube video' })
    expect(document.body.textContent).not.toContain(ID)
    expect(document.body.textContent).not.toContain(ID2)
  })

  it('trims a long title but keeps the full one as its name and tooltip (#326)', async () => {
    const title = 'Relaxing rain sounds for deep sleep and study'
    setup({ links: [{ url: `https://youtu.be/${ID}`, title }] })
    const button = await screen.findByRole('button', { name: title })
    expect(button).toHaveTextContent('Relaxing rain…')
    expect(button.querySelector('[title]')).toHaveAttribute('title', title)
  })

  it('never uses a stored string as a link target, and skips ones it cannot read', async () => {
    setup({ links: ['javascript:alert(1)', `https://youtu.be/${ID}`] })
    await screen.findByRole('button', { name: 'YouTube video' })
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
    let finish: (links: RecentLink[]) => void = () => undefined
    const t = setup({ list: () => new Promise<RecentLink[]>((resolve) => (finish = resolve)) })
    await paste(`https://youtu.be/${ID}`)
    await waitFor(() => expect(t.api.use).toHaveBeenCalled())
    await act(async () => finish([{ url: `https://youtu.be/${ID2}`, title: 'Late list' }]))
    expect(screen.queryByRole('button', { name: 'Late list' })).not.toBeInTheDocument()
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
    expect(document.head.querySelector('script')).toBeNull()
    expect(window.onYouTubeIframeAPIReady).toBeUndefined()
  })

  it('on a blocked script removes the script and restores an earlier ready handler', async () => {
    delete window.YT
    const earlier = vi.fn()
    window.onYouTubeIframeAPIReady = earlier
    const pending = loadYoutubeApi()
    const failure = expect(pending).rejects.toThrow('blocked')
    document.head.querySelector('script')?.dispatchEvent(new Event('error'))
    await failure
    expect(document.head.querySelector('script')).toBeNull()
    expect(window.onYouTubeIframeAPIReady).toBe(earlier)
    delete window.onYouTubeIframeAPIReady
  })

  it('adds one script, not two, when it is retried after a timeout', async () => {
    vi.useFakeTimers()
    delete window.YT
    const first = expect(loadYoutubeApi()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS)
    await first
    const retry = loadYoutubeApi()
    expect(document.head.querySelectorAll('script[src*="iframe_api"]')).toHaveLength(1)
    const ready = window.onYouTubeIframeAPIReady
    window.YT = { Player: vi.fn() as never }
    ready?.()
    await expect(retry).resolves.toBe(window.YT)
    delete window.YT
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
    expect(await httpYoutubeLinksApi.list()).toEqual([{ url: 'https://youtu.be/x', title: null }])
    await httpYoutubeLinksApi.use('https://youtu.be/y')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/youtube-links',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url: 'https://youtu.be/y' }),
      }),
    )
    await httpYoutubeLinksApi.use('https://youtu.be/y', 'A title')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/youtube-links',
      expect.objectContaining({
        body: JSON.stringify({ url: 'https://youtu.be/y', title: 'A title' }),
      }),
    )
    await httpYoutubeLinksApi.use('https://youtu.be/y', 'é'.repeat(250))
    const sent = JSON.parse(
      (fetchMock.mock.lastCall as unknown as [string, { body: string }])[1].body,
    )
    expect(Array.from(sent.title)).toHaveLength(200)
    fetchMock.mockImplementation(async () => new Response('no', { status: 401 }))
    await expect(httpYoutubeLinksApi.list()).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})
