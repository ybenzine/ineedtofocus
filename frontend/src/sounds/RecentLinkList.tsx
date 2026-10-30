// The list of recent YouTube links (AC8.6), shared by the timer screen and New session (#325).

import type { YoutubeLink } from './youtubeLink.ts'
import type { RecentItem } from './youtubeRecent.ts'
import YoutubeLabel from './YoutubeLabel.tsx'

export interface RecentLinkListProps {
  recent: RecentItem[]
  onChoose: (link: YoutubeLink) => void
  /** The url of the link now chosen, marked as pressed. */
  selectedUrl?: string
  /** Show the YouTube mark on each link (default). */
  showIcon?: boolean
}

export default function RecentLinkList({
  recent,
  onChoose,
  selectedUrl,
  showIcon = true,
}: RecentLinkListProps) {
  if (recent.length === 0) return null
  return (
    <ul className="youtube-recent" aria-label="Recent YouTube links">
      {recent.map((item) => (
        <li key={item.link.url}>
          <button
            type="button"
            className="secondary"
            aria-pressed={selectedUrl === undefined ? undefined : selectedUrl === item.link.url}
            onClick={() => onChoose(item.link)}
          >
            <YoutubeLabel kind={item.link.target.kind} title={item.title} showIcon={showIcon} />
          </button>
        </li>
      ))}
    </ul>
  )
}
