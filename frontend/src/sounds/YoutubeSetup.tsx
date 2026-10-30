// YouTube on New session (#325): the link is chosen before the session starts, by pasting one or
// tapping one of the 5 most recent (AC8.6). Start waits for a link that will play; the same
// messages as the timer screen say what is wrong with one that won't (AC8.5). The video only
// plays once the session is running, in the timer screen's visible player (F8.4).

import { useId, useState } from 'react'
import { checkYoutubeLink } from './youtubeLink.ts'
import { httpYoutubeLinksApi, type YoutubeLinksApi } from './youtubeLinksApi.ts'
import RecentLinkList from './RecentLinkList.tsx'
import { linkErrorMessage, useRecentLinks } from './youtubeRecent.ts'

export const YOUTUBE_HINT = 'Paste a YouTube link, or pick a recent one, to start.'

export interface YoutubeSetupProps {
  text: string
  onTextChange: (text: string) => void
  /** Id of the hint that says why Start is disabled; the Start button points at it. */
  hintId: string
  api?: YoutubeLinksApi
}

export default function YoutubeSetup({
  text,
  onTextChange,
  hintId,
  api = httpYoutubeLinksApi,
}: YoutubeSetupProps) {
  const inputId = useId()
  const { recent } = useRecentLinks(api)
  // A half-typed link isn't an error yet: the message waits until the field is left.
  const [touched, setTouched] = useState(false)
  const result = text.trim() === '' ? null : checkYoutubeLink(text)
  const error = touched && result !== null && !result.ok ? linkErrorMessage(result) : null
  const chosenUrl = result?.ok ? result.link.url : undefined

  return (
    <div className="youtube-controls">
      <div className="field">
        <label htmlFor={inputId}>YouTube link</label>
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={text}
          aria-invalid={error !== null}
          aria-describedby={hintId}
          onChange={(event) => {
            onTextChange(event.target.value)
            setTouched(false)
          }}
          onBlur={() => setTouched(true)}
        />
        <p
          id={hintId}
          aria-live="polite"
          className={error !== null ? 'field-hint field-error' : 'field-hint'}
        >
          {error ?? (chosenUrl === undefined ? YOUTUBE_HINT : '')}
        </p>
      </div>
      <RecentLinkList
        recent={recent}
        selectedUrl={chosenUrl ?? ''}
        onChoose={(link) => {
          onTextChange(link.url)
          setTouched(false)
        }}
      />
    </div>
  )
}
