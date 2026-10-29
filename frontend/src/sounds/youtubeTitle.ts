// How a YouTube title is shown (#326): trimmed to fit a small button, counted in graphemes so an
// emoji or an accented letter is never split. The full title stays in the accessible name and the
// tooltip. Titles are user content: never logged.

export const TITLE_MAX_GRAPHEMES = 20
export const VIDEO_FALLBACK = 'YouTube video'
export const PLAYLIST_FALLBACK = 'YouTube playlist'

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text)
}

const TRAILING = /[\s\p{P}]+$/u

/**
 * Longer than 20 graphemes: cut at the last space at or before the 20th, with trailing spaces and
 * punctuation dropped, and `…` added. No space in the first 20: cut at 20.
 */
export function trimYoutubeTitle(title: string, max = TITLE_MAX_GRAPHEMES): string {
  const text = title.trim()
  const parts = graphemes(text)
  if (parts.length <= max) return text
  const head = parts.slice(0, max)
  const lastSpace = head.findLastIndex((part) => /^\s+$/u.test(part))
  const cut = (lastSpace > 0 ? head.slice(0, lastSpace) : head).join('').replace(TRAILING, '')
  return `${cut || head.join('')}…`
}

/** The text to show for a link: its title, or a generic name. Never the raw id. */
export function youtubeLabelText(kind: 'video' | 'playlist', title: string | null | undefined) {
  const clean = title?.trim()
  if (clean) return clean
  return kind === 'video' ? VIDEO_FALLBACK : PLAYLIST_FALLBACK
}
