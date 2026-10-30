// A YouTube link as the user sees it (#326): a small play glyph, then the title trimmed to fit.
// The full title is the accessible name and the tooltip. Without a title it reads "YouTube video"
// or "YouTube playlist", never the id. Reused wherever a link is shown. The icon can be turned
// off (`showIcon`) where the glyph already appears once nearby, as in the timer's audio card.

import { trimYoutubeTitle, youtubeLabelText } from './youtubeTitle.ts'

/**
 * A plain play glyph: one filled right-pointing triangle in the text colour (`currentColor`).
 * It is not YouTube's mark and has no brand colours. Decorative: the text next to it carries
 * the meaning.
 */
export function PlayGlyph() {
  return (
    <svg
      className="play-glyph"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 2v12l10-6z" fill="currentColor" />
    </svg>
  )
}

export interface YoutubeLabelProps {
  kind: 'video' | 'playlist'
  title?: string | null
  /** Show the play glyph (default). Off where the glyph already sits next to the label. */
  showIcon?: boolean
}

export default function YoutubeLabel({ kind, title, showIcon = true }: YoutubeLabelProps) {
  const full = youtubeLabelText(kind, title)
  const short = trimYoutubeTitle(full)
  return (
    <span className="youtube-label" title={full}>
      {showIcon && <PlayGlyph />}
      {short === full ? (
        <span>{full}</span>
      ) : (
        <>
          <span aria-hidden="true">{short}</span>
          <span className="sr-only">{full}</span>
        </>
      )}
    </span>
  )
}
