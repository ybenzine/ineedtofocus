// YouTube as the background source (F8.4-F8.6): paste a link or tap one of the 5 most recent,
// and the video plays in a small visible player, looping while the timer runs (AC8.2). A link or
// video that doesn't work only shows a message; the session is unaffected (AC8.5).

import { useId, useState, type FormEvent } from 'react'
import { useSettingsStore, useSettingsState } from '../settings/SettingsContext.ts'
import { getDefaultLinkStore, type YoutubeLinkStore } from './audioSource.ts'
import YoutubePlayer from './youtubePlayer.tsx'
import { loadYoutubeApi, type LoadYoutubeApi } from './ytApi.ts'
import { checkYoutubeLink, parseYoutubeLink, type YoutubeLink } from './youtubeLink.ts'
import { httpYoutubeLinksApi, type YoutubeLinksApi } from './youtubeLinksApi.ts'
import RecentLinkList from './RecentLinkList.tsx'
import { linkErrorMessage, savedTitle, useRecentLinks } from './youtubeRecent.ts'
import YoutubeLabel from './YoutubeLabel.tsx'
import RangeInput from '../RangeInput.tsx'

export interface YoutubeControlsProps {
  /** The timer is paused. */
  paused: boolean
  linkStore?: YoutubeLinkStore
  api?: YoutubeLinksApi
  loadApi?: LoadYoutubeApi
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
  const { recent, remember } = useRecentLinks(api)
  // The title the player reported for the link now playing.
  const [playing, setPlaying] = useState<{ url: string; title: string } | null>(null)

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
    link === null ? null : playing?.url === link.url ? playing.title : savedTitle(recent, link)

  function submit(event: FormEvent) {
    event.preventDefault()
    const result = checkYoutubeLink(text)
    if (result.ok) choose(result.link)
    else setError(linkErrorMessage(result))
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
            <label htmlFor={volumeId} className="sr-only">
              YouTube volume
            </label>
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
      <RecentLinkList recent={recent} onChoose={choose} />
    </div>
  )
}
