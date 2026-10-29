// YouTube as the background source (F8.4-F8.6): paste a link or tap one of the 5 most recent,
// and the video plays in a small visible player, looping while the timer runs (AC8.2). A link or
// video that doesn't work only shows a message; the session is unaffected (AC8.5).

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useSettingsStore, useSettingsState } from '../settings/SettingsContext.ts'
import { LocalYoutubeLinkStore, type YoutubeLinkStore } from './audioSource.ts'
import YoutubePlayer from './youtubePlayer.tsx'
import { loadYoutubeApi, type LoadYoutubeApi } from './ytApi.ts'
import { checkYoutubeLink, parseYoutubeLink, type YoutubeLink } from './youtubeLink.ts'
import { httpYoutubeLinksApi, type RecentLink, type YoutubeLinksApi } from './youtubeLinksApi.ts'
import YoutubeLabel from './YoutubeLabel.tsx'
import RangeInput from '../RangeInput.tsx'

export const INVALID_LINK_MESSAGE =
  "That doesn't look like a YouTube link. Paste a link from youtube.com or youtu.be."

export const NO_ID_MESSAGE =
  "This link doesn't point to a video or playlist. Paste the link to a video, short or playlist."

export interface YoutubeControlsProps {
  /** The timer is paused. */
  paused: boolean
  linkStore?: YoutubeLinkStore
  api?: YoutubeLinksApi
  loadApi?: LoadYoutubeApi
}

let defaultLinkStore: YoutubeLinkStore | null = null

/** Created on first use, so importing this module doesn't touch localStorage. */
function getDefaultLinkStore(): YoutubeLinkStore {
  defaultLinkStore ??= new LocalYoutubeLinkStore()
  return defaultLinkStore
}

export default function YoutubeControls({
  paused,
  linkStore: givenLinkStore,
  api = httpYoutubeLinksApi,
  loadApi = loadYoutubeApi,
}: YoutubeControlsProps) {
  const linkStore = givenLinkStore ?? getDefaultLinkStore()
  const inputId = useId()
  const errorId = useId()
  const volumeId = useId()
  const settings = useSettingsStore()
  const volume = useSettingsState().values.background_volume
  const [link, setLink] = useState<YoutubeLink | null>(() => {
    const stored = linkStore.load()
    return stored === null ? null : parseYoutubeLink(stored)
  })
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<{ link: YoutubeLink; title: string | null }[]>([])
  // The title the player reported for the link now playing.
  const [playing, setPlaying] = useState<{ url: string; title: string } | null>(null)

  // Set once a link has been used: a slower first fetch must not overwrite that newer list.
  const usedSinceMount = useRef(false)

  function showRecent(items: RecentLink[]) {
    // One entry per video or playlist id, the newest (first) one: the server's rule (#249).
    const seen = new Set<string>()
    const shown: { link: YoutubeLink; title: string | null }[] = []
    for (const item of items) {
      const parsed = parseYoutubeLink(item.url)
      if (parsed === null) continue
      const key = `${parsed.target.kind}:${parsed.target.id}`
      if (seen.has(key)) continue
      seen.add(key)
      shown.push({ link: parsed, title: item.title })
    }
    setRecent(shown.slice(0, 5))
  }

  useEffect(() => {
    const abort = new AbortController()
    api.list(abort.signal).then(
      (items) => {
        if (!usedSinceMount.current) showRecent(items)
      },
      () => undefined,
    )
    return () => abort.abort()
  }, [api])

  // Remembering the link is best effort: playback never waits for it.
  function remember(url: string, title?: string) {
    api.use(url, title).then(
      (items) => {
        usedSinceMount.current = true
        showRecent(items)
      },
      () => undefined,
    )
  }

  function choose(chosen: YoutubeLink) {
    setError(null)
    setText('')
    setLink(chosen)
    setPlaying(null)
    linkStore.save(chosen.url)
    remember(chosen.url)
  }

  // The label of the link now playing: the player's own title, else the one saved with it.
  const nowTitle =
    link === null
      ? null
      : playing?.url === link.url
        ? playing.title
        : (recent.find(
            (item) =>
              item.link.target.kind === link.target.kind && item.link.target.id === link.target.id,
          )?.title ?? null)

  function submit(event: FormEvent) {
    event.preventDefault()
    const result = checkYoutubeLink(text)
    if (result.ok) choose(result.link)
    else setError(result.reason === 'no-id' ? NO_ID_MESSAGE : INVALID_LINK_MESSAGE)
  }

  return (
    <div className="youtube-controls">
      {link !== null && (
        <>
          <YoutubePlayer
            key={`${link.target.kind}:${link.target.id}`}
            target={link.target}
            playing={!paused}
            volume={volume}
            loadApi={loadApi}
            onTitle={(title) => {
              setPlaying({ url: link.url, title })
              remember(link.url, title)
            }}
          />
          <p className="youtube-now-playing">
            <YoutubeLabel kind={link.target.kind} title={nowTitle} />
          </p>
          <div className="timer-volume">
            <label htmlFor={volumeId}>YouTube volume</label>
            <RangeInput
              id={volumeId}
              min={0}
              max={100}
              value={volume}
              onChange={(event) =>
                settings.update({ background_volume: Number(event.target.value) })
              }
            />
          </div>
        </>
      )}
      <form onSubmit={submit} className="field">
        <label htmlFor={inputId}>{link === null ? 'YouTube link' : 'Another YouTube link'}</label>
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={text}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(event) => {
            setText(event.target.value)
            setError(null)
          }}
        />
        {error !== null && (
          <p id={errorId} className="field-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="secondary">
          Play
        </button>
      </form>
      {recent.length > 0 && (
        <ul className="youtube-recent" aria-label="Recent YouTube links">
          {recent.map((item) => (
            <li key={item.link.url}>
              <button type="button" className="secondary" onClick={() => choose(item.link)}>
                <YoutubeLabel kind={item.link.target.kind} title={item.title} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
