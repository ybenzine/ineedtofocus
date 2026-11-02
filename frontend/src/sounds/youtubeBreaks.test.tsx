// AC8.2, AC12.6, AC8.2 fallback: YouTube pauses for Pomodoro breaks and resumes at the next focus,
// with a "Resume video" button where the browser blocks playVideo() (iOS Safari).
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsContext } from '../settings/SettingsContext.ts'
import { SettingsStore } from '../settings/store.ts'
import AudioControls from './AudioControls.tsx'
import { MemoryYoutubeLinkStore } from './audioSource.ts'
import { MemoryBackgroundVolumeStore, RainPlayer } from './rain.ts'
import {
  PLAY_BLOCKED_MS,
  YT_PLAYING,
  type YtNamespace,
  type YtPlayer,
  type YtPlayerOptions,
} from './ytApi.ts'

const ID = 'dQw4w9WgXcQ'
const CUE = 'Paused for the break'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

type Fake = YtPlayer & { options: YtPlayerOptions }
type State = { paused?: boolean; inBreak?: boolean }

async function setup(options: { pause?: boolean; ready?: boolean; initial?: State } = {}) {
  const players: Fake[] = []
  function Player(_mount: HTMLElement, playerOptions: YtPlayerOptions) {
    const player = {
      options: playerOptions,
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      stopVideo: vi.fn(),
      seekTo: vi.fn(),
      setVolume: vi.fn(),
      setLoop: vi.fn(),
      nextVideo: vi.fn(),
      getPlaylistIndex: vi.fn(),
      getVideoData: vi.fn(() => ({ title: '' })),
      getPlaylist: vi.fn(() => null),
      destroy: vi.fn(),
    }
    players.push(player)
    return player
  }
  const loadApi = async () => ({ Player }) as unknown as YtNamespace
  const settings = new SettingsStore()
  if (options.pause === false) settings.update({ pause_audio_on_breaks: false })
  const rain = new RainPlayer({
    alerts: { audioContext: () => null },
    volume: new MemoryBackgroundVolumeStore(),
  })
  const linkStore = new MemoryYoutubeLinkStore()
  linkStore.save(`https://youtu.be/${ID}`)
  const api = { list: async () => [], use: async () => [] }
  const view = (state: State) => (
    <SettingsContext.Provider value={settings}>
      <AudioControls
        source="youtube"
        paused={state.paused ?? false}
        inBreak={state.inBreak ?? false}
        rain={rain}
        onSourceChange={vi.fn()}
        youtube={{ api, linkStore, loadApi }}
      />
    </SettingsContext.Provider>
  )
  const result = render(view(options.initial ?? {}))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  await act(async () => players[0].options.events.onReady())
  return {
    players,
    settings,
    show: (state: State) => result.rerender(view(state)),
    state: (data: number) => act(async () => players[0].options.events.onStateChange({ data })),
  }
}

const resumeButton = () => screen.queryByRole('button', { name: 'Resume video' })

describe('YouTube through a Pomodoro break', () => {
  it('pauses at the break and plays at the next focus, player still visible', async () => {
    const t = await setup()
    const p = t.players[0]
    expect(p.playVideo).toHaveBeenCalledTimes(1)
    t.show({ inBreak: true })
    expect(p.pauseVideo).toHaveBeenCalledTimes(1)
    expect(screen.getByText(CUE)).toHaveAttribute('role', 'status')
    expect(document.querySelector('.youtube-player')).not.toHaveAttribute('hidden')
    t.show({ inBreak: false })
    expect(p.playVideo).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(CUE)).toBeNull()
    expect(p.destroy).not.toHaveBeenCalled()
  })

  it('calls nothing at the break with the setting off, and shows no cue', async () => {
    const t = await setup({ pause: false })
    const p = t.players[0]
    t.show({ inBreak: true })
    expect(screen.queryByText(CUE)).toBeNull()
    t.show({ inBreak: false })
    expect(p.pauseVideo).not.toHaveBeenCalled()
    expect(p.playVideo).toHaveBeenCalledTimes(1)
  })

  it('keeps it paused when the timer is paused and resumed in a break', async () => {
    const t = await setup()
    const p = t.players[0]
    t.show({ inBreak: true })
    t.show({ inBreak: true, paused: true })
    t.show({ inBreak: true, paused: false })
    expect(p.playVideo).toHaveBeenCalledTimes(1)
    expect(screen.getByText(CUE)).toBeInTheDocument()
  })

  it('pausing during focus behaves as today, with no cue', async () => {
    const t = await setup()
    t.show({ paused: true })
    expect(t.players[0].pauseVideo).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(CUE)).toBeNull()
    t.show({ paused: false })
    expect(t.players[0].playVideo).toHaveBeenCalledTimes(2)
  })

  it('takes a setting change in the break at once', async () => {
    const t = await setup()
    const p = t.players[0]
    t.show({ inBreak: true })
    await act(async () => t.settings.update({ pause_audio_on_breaks: false }))
    expect(p.playVideo).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(CUE)).toBeNull()
    await act(async () => t.settings.update({ pause_audio_on_breaks: true }))
    expect(p.pauseVideo).toHaveBeenCalledTimes(2)
    expect(screen.getByText(CUE)).toBeInTheDocument()
  })

  it('a session restored in a break never plays', async () => {
    const t = await setup({ initial: { inBreak: true } })
    expect(t.players[0].playVideo).not.toHaveBeenCalled()
    expect(screen.getByText(CUE)).toBeInTheDocument()
  })
})

describe('Resume video fallback (blocked playVideo)', () => {
  it('appears if the video is not playing 3 s after a focus block starts, and plays on tap', async () => {
    const t = await setup()
    t.show({ inBreak: true })
    t.show({ inBreak: false })
    expect(resumeButton()).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAY_BLOCKED_MS + 100)
    })
    const calls = vi.mocked(t.players[0].playVideo).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Resume video' }))
    expect(t.players[0].playVideo).toHaveBeenCalledTimes(calls + 1)
    await t.state(YT_PLAYING)
    expect(resumeButton()).toBeNull()
  })

  it('does not appear when the video reports playing in time', async () => {
    const t = await setup()
    t.show({ inBreak: true })
    t.show({ inBreak: false })
    await t.state(YT_PLAYING)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAY_BLOCKED_MS * 2)
    })
    expect(resumeButton()).toBeNull()
  })

  it('goes away when the next break starts', async () => {
    const t = await setup()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAY_BLOCKED_MS + 100)
    })
    expect(resumeButton()).toBeInTheDocument()
    t.show({ inBreak: true })
    expect(resumeButton()).toBeNull()
  })
})
