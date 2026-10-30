// A YouTube link as the user sees it (#326): a small YouTube icon, then the title trimmed to fit.
// The full title is the accessible name and the tooltip. Without a title it reads "YouTube video"
// or "YouTube playlist", never the id. Reused wherever a link is shown.

import { trimYoutubeTitle, youtubeLabelText } from './youtubeTitle.ts'

/**
 * YouTube's play-button mark in its own colours, the same in both themes (see _docs/assets.md).
 * `red` and `white` are #FF0000 and #FFFFFF: brand colours, deliberately not theme tokens.
 */
export function YoutubeIcon() {
  return (
    <svg
      className="youtube-icon"
      width="16"
      height="12"
      viewBox="0 0 28 20"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="28" height="20" rx="6" fill="red" />
      <path d="M11 5.5v9l8-4.5z" fill="white" />
    </svg>
  )
}

export interface YoutubeLabelProps {
  kind: 'video' | 'playlist'
  title?: string | null
  /** Show the YouTube mark (default). Off where the mark already sits next to the label. */
  showIcon?: boolean
}

export default function YoutubeLabel({ kind, title, showIcon = true }: YoutubeLabelProps) {
  const full = youtubeLabelText(kind, title)
  const short = trimYoutubeTitle(full)
  return (
    <span className="youtube-label" title={full}>
      {showIcon && <YoutubeIcon />}
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
