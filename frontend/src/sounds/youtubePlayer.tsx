// The visible embedded YouTube player (AC8.4, AC8.5), driven by the YouTube IFrame Player API.
// YouTube's terms require the player to stay visible, so it is rendered on the timer screen and
// never hidden. It loops, follows `playing` (AC8.2) and takes the background volume (0-100).
// The embed is built from the parsed id, never from the pasted string, and is never logged.

import { useEffect, useRef, useState } from 'react'
import type { YoutubeTarget } from './youtubeLink.ts'
import {
  PLAYER_ERROR_MESSAGE,
  PLAYER_LOAD_MESSAGE,
  SKIPPABLE_ERRORS,
  SKIPPED_ITEM_MESSAGE,
  SKIP_NOTE_MS,
  UNKNOWN_PLAYLIST_LENGTH,
  YT_CUED,
  YT_ENDED,
  YT_PLAYING,
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
  /** The title of the video now loaded, once the player knows it (and when it changes). */
  onTitle?: (title: string) => void
}

export default function YoutubePlayer({
  target,
  playing,
  volume,
  loadApi = loadYoutubeApi,
  onProblem,
  onTitle,
}: YoutubePlayerProps) {
  const wrapper = useRef<HTMLDivElement>(null)
  const player = useRef<YtPlayer | null>(null)
  const ready = useRef(false)
  const wantPlaying = useRef(playing)
  const wantVolume = useRef(volume)
  const problemHandler = useRef(onProblem)
  const titleHandler = useRef(onTitle)
  const [message, setMessage] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    wantPlaying.current = playing
    wantVolume.current = volume
    problemHandler.current = onProblem
    titleHandler.current = onTitle
  })

  const { kind, id } = target
  useEffect(() => {
    const host = wrapper.current
    let cancelled = false
    let created: YtPlayer | null = null
    let hasPlayed = false
    let failuresInARow = 0
    let lastSkippedIndex: number | undefined
    let noteTimer: number | undefined
    let lastTitle = ''
    const reportTitle = () => {
      if (cancelled) return
      let title = ''
      try {
        title = created?.getVideoData?.()?.title?.trim() ?? ''
      } catch {
        // Not known yet.
      }
      if (title === '' || title === lastTitle) return
      lastTitle = title
      titleHandler.current?.(title)
    }
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
              reportTitle()
            },
            onStateChange: (event) => {
              // The title is often only known once a video starts (and changes in a playlist).
              if (event.data === YT_PLAYING || event.data === YT_CUED) reportTitle()
              if (event.data === YT_PLAYING) {
                hasPlayed = true
                failuresInARow = 0
                lastSkippedIndex = undefined
              }
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
            onError: (event) => {
              // In a playlist one unplayable item is skipped; the player goes only when every item
              // has failed in a row. Errors before anything played and other errors remove it.
              if (
                kind === 'playlist' &&
                hasPlayed &&
                created &&
                !cancelled &&
                SKIPPABLE_ERRORS.includes(event.data)
              ) {
                // The same item reported twice, or already left behind: don't skip a good one.
                let index: number | undefined
                try {
                  index = created.getPlaylistIndex()
                } catch {
                  // Index unknown.
                }
                if (index !== undefined && index === lastSkippedIndex) return
                lastSkippedIndex = index
                failuresInARow += 1
                let total = UNKNOWN_PLAYLIST_LENGTH
                try {
                  total = created.getPlaylist()?.length || UNKNOWN_PLAYLIST_LENGTH
                } catch {
                  // Length unknown.
                }
                if (failuresInARow < total) {
                  setNote(SKIPPED_ITEM_MESSAGE)
                  window.clearTimeout(noteTimer)
                  noteTimer = window.setTimeout(() => setNote(null), SKIP_NOTE_MS)
                  created.nextVideo()
                  return
                }
              }
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
      window.clearTimeout(noteTimer)
      setNote(null)
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
      <p className="field-hint" role="status">
        {message === null ? note : null}
      </p>
      {message !== null && (
        <p className="field-error" role="alert">
          {message}
        </p>
      )}
    </>
  )
}
