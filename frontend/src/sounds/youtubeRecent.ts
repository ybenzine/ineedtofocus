// The pieces of choosing a YouTube link that the timer screen (YoutubeControls) and New session
// (YoutubeSetup) share: the messages for a link that won't do (AC8.5), the 5 recent links with
// their titles (AC8.6, #326) and how they are listed. Links and titles are never logged.

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseYoutubeLink, type YoutubeCheck, type YoutubeLink } from './youtubeLink.ts'
import type { RecentLink, YoutubeLinksApi } from './youtubeLinksApi.ts'

export const INVALID_LINK_MESSAGE =
  "That doesn't look like a YouTube link. Paste a link from youtube.com or youtu.be."

export const NO_ID_MESSAGE =
  "This link doesn't point to a video or playlist. Paste the link to a video, short or playlist."

/** The message for a link `checkYoutubeLink` refused. */
export function linkErrorMessage(result: Extract<YoutubeCheck, { ok: false }>): string {
  return result.reason === 'no-id' ? NO_ID_MESSAGE : INVALID_LINK_MESSAGE
}

export interface RecentItem {
  link: YoutubeLink
  title: string | null
}

/** One entry per video or playlist id, the newest (first) one: the server's rule (#249). */
export function listRecent(items: RecentLink[]): RecentItem[] {
  const seen = new Set<string>()
  const shown: RecentItem[] = []
  for (const item of items) {
    const parsed = parseYoutubeLink(item.url)
    if (parsed === null) continue
    const key = `${parsed.target.kind}:${parsed.target.id}`
    if (seen.has(key)) continue
    seen.add(key)
    shown.push({ link: parsed, title: item.title })
  }
  return shown.slice(0, 5)
}

/** The title saved for a link's video or playlist id, if the recent list has one. */
export function savedTitle(recent: RecentItem[], link: YoutubeLink): string | null {
  return (
    recent.find(
      (item) =>
        item.link.target.kind === link.target.kind && item.link.target.id === link.target.id,
    )?.title ?? null
  )
}

/** The recent links, loaded on mount. `remember` marks a link used and refreshes the list. */
export function useRecentLinks(api: YoutubeLinksApi) {
  const [recent, setRecent] = useState<RecentItem[]>([])
  // Set once a link has been used: a slower first fetch must not overwrite that newer list.
  const usedSinceMount = useRef(false)

  useEffect(() => {
    const abort = new AbortController()
    api.list(abort.signal).then(
      (items) => {
        if (!usedSinceMount.current) setRecent(listRecent(items))
      },
      () => undefined,
    )
    return () => abort.abort()
  }, [api])

  // Remembering the link is best effort: playback never waits for it.
  const remember = useCallback(
    (url: string, title?: string) => {
      api.use(url, title).then(
        (items) => {
          usedSinceMount.current = true
          setRecent(listRecent(items))
        },
        () => undefined,
      )
    },
    [api],
  )

  return { recent, remember }
}
