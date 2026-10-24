// The visible embedded YouTube player (AC8.4, AC8.5), driven by the YouTube IFrame Player API.
// YouTube's terms require the player to stay visible, so it is rendered on the timer screen and
// never hidden. It loops, follows `playing` (AC8.2) and takes the background volume (0-100).
// The embed is built from the parsed id, never from the pasted string, and is never logged.

import { useEffect, useRef, useState } from 'react'
import type { YoutubeTarget } from './youtubeLink.ts'
import {
  PLAYER_ERROR_MESSAGE,
  PLAYER_LOAD_MESSAGE,
  YT_ENDED,
  loadYoutubeApi,
  type LoadYoutubeApi,
  type YtPlayer,
} from './ytApi.ts'

export interface YoutubePlayerProps {
  target: YoutubeTarget
  /** The timer is running (AC8.2). */
  playing: boolean
  /** 0-100 */
  volume: number
  loadApi?: LoadYoutubeApi
  /** Told about a video that can't play, or a player that can't load; the message is shown here. */
  onProblem?: () => void
}

export default function YoutubePlayer({
  target,
  playing,
  volume,
  loadApi = loadYoutubeApi,
  onProblem,
}: YoutubePlayerProps) {
  const wrapper = useRef<HTMLDivElement>(null)
  const player = useRef<YtPlayer | null>(null)
  const ready = useRef(false)
  const wantPlaying = useRef(playing)
  const wantVolume = useRef(volume)
  const problemHandler = useRef(onProblem)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    wantPlaying.current = playing
    wantVolume.current = volume
    problemHandler.current = onProblem
  })

  const { kind, id } = target
  useEffect(() => {
    const host = wrapper.current
    let cancelled = false
    let created: YtPlayer | null = null
    const fail = (text: string) => {
      if (cancelled) return
      setMessage(text)
      problemHandler.current?.()
    }
    loadApi().then(
      (yt) => {
        if (cancelled || !host) return
        const mount = document.createElement('div')
        host.appendChild(mount)
        const vars: Record<string, string | number> = { playsinline: 1, rel: 0, loop: 1 }
        if (kind === 'video')
          vars.playlist = id // a single video loops as a one-item playlist
        else {
          vars.listType = 'playlist'
          vars.list = id
        }
        created = new yt.Player(mount, {
          width: '100%',
          height: '100%',
          host: 'https://www.youtube-nocookie.com',
          ...(kind === 'video' ? { videoId: id } : {}),
          playerVars: vars,
          events: {
            onReady: () => {
              if (cancelled || !created) return
              ready.current = true
              player.current = created
              created.setVolume(wantVolume.current)
              if (kind === 'playlist') created.setLoop(true)
              if (wantPlaying.current) created.playVideo()
            },
            onStateChange: (event) => {
              // Backs up `loop` for a single video: start over while the timer runs.
              // A playlist moves on by itself (`setLoop`); restarting here would repeat an item.
              if (
                kind === 'video' &&
                event.data === YT_ENDED &&
                wantPlaying.current &&
                !cancelled
              ) {
                created?.seekTo(0, true)
                created?.playVideo()
              }
            },
            onError: () => {
              // Nothing may play from a player the user can't see: stop and remove it.
              ready.current = false
              player.current = null
              const failed = created
              created = null
              try {
                failed?.stopVideo()
                failed?.destroy()
              } catch {
                // Already gone.
              }
              host?.replaceChildren()
              fail(PLAYER_ERROR_MESSAGE)
            },
          },
        })
      },
      () => fail(PLAYER_LOAD_MESSAGE),
    )
    return () => {
      cancelled = true
      ready.current = false
      player.current = null
      try {
        created?.destroy()
      } catch {
        // Already gone.
      }
      host?.replaceChildren()
    }
  }, [kind, id, loadApi])

  useEffect(() => {
    if (!ready.current || !player.current) return
    if (playing) player.current.playVideo()
    else player.current.pauseVideo()
  }, [playing])

  useEffect(() => {
    if (ready.current && player.current) player.current.setVolume(volume)
  }, [volume])

  return (
    <>
      <div className="youtube-player" ref={wrapper} hidden={message !== null} />
      {message !== null && (
        <p className="field-error" role="alert">
          {message}
        </p>
      )}
    </>
  )
}
